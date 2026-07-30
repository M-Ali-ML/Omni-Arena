import { z } from "zod";
import type { Model } from "../core/ports.js";

/**
 * How the arena decides whether to engage a request. `always` reproduces the
 * historic behavior (every request is a matchup); `manual` serves a single
 * model unless the request explicitly opts in; `sampled` engages with
 * probability `ARENA_SAMPLE_RATE`.
 */
export const arenaTriggerSchema = z
  .enum(["always", "manual", "sampled"])
  .default("always");

export type ArenaTrigger = z.infer<typeof arenaTriggerSchema>;

/**
 * What the user sees when a request is engaged. `blind` streams both answers
 * anonymously (votable); `shadow` streams only the incumbent and persists the
 * challenger silently (not votable).
 */
export const arenaExposureSchema = z.enum(["blind", "shadow"]).default("blind");

export type ArenaExposure = z.infer<typeof arenaExposureSchema>;

const arenaModeConfigSchema = z.object({
  trigger: arenaTriggerSchema,
  exposure: arenaExposureSchema,
  /**
   * Model id streamed for `single`/`shadow` plans; required once trigger !==
   * always or exposure === shadow. After boot resolution this is always a
   * `models.id` UUID when set.
   */
  defaultModel: z.string().trim().min(1).nullable().default(null),
  /**
   * Engagement probability when `trigger === "sampled"`. Ignored otherwise.
   * Parsed from `ARENA_SAMPLE_RATE` (0..1 inclusive).
   */
  sampleRate: z.coerce.number().min(0).max(1).default(0),
});

export type ArenaModeConfig = z.infer<typeof arenaModeConfigSchema>;

/**
 * The resolved shape of a request: `matchup` (blind A/B, votable), `shadow`
 * (A streamed, B silent+logged), or `single` (one model, nothing persisted).
 */
export type ArenaPlan =
  | { kind: "matchup" }
  | { kind: "single" }
  | { kind: "shadow" };

/** Opt-in signals a manual-trigger deployment reads off the request. */
export interface ArenaRequestSignals {
  /** Request body `arena: true`. */
  arena?: boolean;
  /** Value of the `x-arena` header (case-insensitive `on` opts in). */
  header?: string | null;
}

export function parseArenaModeConfig(
  env: Record<string, string | undefined>,
): ArenaModeConfig {
  return arenaModeConfigSchema.parse({
    trigger: env.ARENA_TRIGGER,
    exposure: env.ARENA_EXPOSURE,
    defaultModel: env.ARENA_DEFAULT_MODEL?.trim() ? env.ARENA_DEFAULT_MODEL : null,
    sampleRate: env.ARENA_SAMPLE_RATE,
  });
}

function isOptedIn(signals: ArenaRequestSignals): boolean {
  if (signals.arena === true) {
    return true;
  }
  return signals.header?.trim().toLowerCase() === "on";
}

/** Map an engaged request onto the exposure axis. */
function engagedPlan(exposure: ArenaExposure): ArenaPlan {
  return exposure === "shadow" ? { kind: "shadow" } : { kind: "matchup" };
}

/**
 * Collapse config + request into a single plan. `rng` is injected so the
 * `sampled` trigger can branch deterministically in tests (default Math.random).
 *
 * Matrix (trigger × engaged × exposure):
 *   always            → matchup | shadow
 *   sampled hit       → matchup | shadow
 *   sampled miss      → single
 *   manual opted-in   → matchup | shadow
 *   manual not        → single
 */
export function resolveArenaPlan(
  config: ArenaModeConfig,
  signals: ArenaRequestSignals,
  rng: () => number = Math.random,
): ArenaPlan {
  if (config.trigger === "manual") {
    return isOptedIn(signals) ? engagedPlan(config.exposure) : { kind: "single" };
  }
  if (config.trigger === "sampled") {
    return rng() < config.sampleRate
      ? engagedPlan(config.exposure)
      : { kind: "single" };
  }
  return engagedPlan(config.exposure);
}

/**
 * Fail fast at boot: any non-`always` trigger, or shadow exposure, needs a
 * designated model (incumbent for shadow / single-model for non-engaged).
 * Roster membership / human-identifier resolution is handled separately by
 * {@link resolveArenaDefaultModel}.
 */
export function assertArenaModeConfig(config: ArenaModeConfig): void {
  if (config.trigger !== "always" && !config.defaultModel) {
    throw new Error(
      `ARENA_DEFAULT_MODEL is required when ARENA_TRIGGER=${config.trigger}`,
    );
  }
  if (config.exposure === "shadow" && !config.defaultModel) {
    throw new Error(
      "ARENA_DEFAULT_MODEL is required when ARENA_EXPOSURE=shadow",
    );
  }
}

function formatEnabledModels(models: Model[]): string {
  if (models.length === 0) {
    return "(none enabled)";
  }
  return models
    .map(
      (model) =>
        `${model.provider}:${model.providerModelId} (${model.displayName}, id=${model.id})`,
    )
    .join(", ");
}

/**
 * Match `ARENA_DEFAULT_MODEL` against the enabled roster. Accepts, in order of
 * preference: `models.id` (UUID), `provider:provider_model_id`,
 * `provider_model_id` (slug), or `display_name`. Returns the matching model or
 * throws when zero or multiple rows match at the winning specificity.
 */
export function findDefaultModel(
  identifier: string,
  models: Model[],
): Model {
  const needle = identifier.trim();

  const byId = models.filter((model) => model.id === needle);
  if (byId.length === 1) {
    return byId[0]!;
  }
  if (byId.length > 1) {
    throw new Error(
      `ARENA_DEFAULT_MODEL '${needle}' matches multiple enabled models by id: ${formatEnabledModels(byId)}`,
    );
  }

  const colon = needle.indexOf(":");
  if (colon > 0) {
    const provider = needle.slice(0, colon);
    const providerModelId = needle.slice(colon + 1);
    const byProviderKey = models.filter(
      (model) =>
        model.provider === provider && model.providerModelId === providerModelId,
    );
    if (byProviderKey.length === 1) {
      return byProviderKey[0]!;
    }
    if (byProviderKey.length > 1) {
      throw new Error(
        `ARENA_DEFAULT_MODEL '${needle}' matches multiple enabled models by provider:provider_model_id: ${formatEnabledModels(byProviderKey)}`,
      );
    }
  }

  const bySlug = models.filter((model) => model.providerModelId === needle);
  if (bySlug.length === 1) {
    return bySlug[0]!;
  }
  if (bySlug.length > 1) {
    throw new Error(
      `ARENA_DEFAULT_MODEL '${needle}' is ambiguous across providers (matched provider_model_id on ${bySlug.length} enabled models). Use provider:provider_model_id. Matches: ${formatEnabledModels(bySlug)}`,
    );
  }

  const byDisplayName = models.filter((model) => model.displayName === needle);
  if (byDisplayName.length === 1) {
    return byDisplayName[0]!;
  }
  if (byDisplayName.length > 1) {
    throw new Error(
      `ARENA_DEFAULT_MODEL '${needle}' matches multiple enabled models by display_name: ${formatEnabledModels(byDisplayName)}`,
    );
  }

  throw new Error(
    `ARENA_DEFAULT_MODEL '${needle}' matched none of the enabled models. Accepted forms: models.id (UUID), provider_model_id, display_name, or provider:provider_model_id. Enabled: ${formatEnabledModels(models)}`,
  );
}

/**
 * Resolve a human-friendly `ARENA_DEFAULT_MODEL` to a `models.id` UUID against
 * the enabled roster at boot. Returns the config unchanged when unset. Request
 * handlers keep comparing `defaultModel` to `Model.id`.
 */
export function resolveArenaDefaultModel(
  config: ArenaModeConfig,
  models: Model[],
): ArenaModeConfig {
  if (!config.defaultModel) {
    return config;
  }
  const model = findDefaultModel(config.defaultModel, models);
  return { ...config, defaultModel: model.id };
}
