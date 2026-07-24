import { z } from "zod";

/**
 * How the arena decides whether to engage a request. `always` reproduces the
 * historic behavior (every request is a matchup); `manual` serves a single
 * model unless the request explicitly opts in. `sampled` is reserved for a
 * later phase and intentionally not accepted yet.
 */
export const arenaTriggerSchema = z
  .enum(["always", "manual"])
  .default("always");

export type ArenaTrigger = z.infer<typeof arenaTriggerSchema>;

const arenaModeConfigSchema = z.object({
  trigger: arenaTriggerSchema,
  /** Model id streamed for `single` plans; required once trigger !== always. */
  defaultModel: z.string().trim().min(1).nullable().default(null),
});

export type ArenaModeConfig = z.infer<typeof arenaModeConfigSchema>;

/**
 * The resolved shape of a request. Only `matchup` and `single` are reachable in
 * Phase 1; `shadow` is declared so downstream consumers can be exhaustive ahead
 * of Phase 3 without a type change.
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
    defaultModel: env.ARENA_DEFAULT_MODEL?.trim() ? env.ARENA_DEFAULT_MODEL : null,
  });
}

function isOptedIn(signals: ArenaRequestSignals): boolean {
  if (signals.arena === true) {
    return true;
  }
  return signals.header?.trim().toLowerCase() === "on";
}

/**
 * Collapse config + request into a single plan. `rng` is injected now (unused in
 * Phase 1) so the `sampled` trigger can branch on it in Phase 2 without changing
 * the signature or any call site.
 */
export function resolveArenaPlan(
  config: ArenaModeConfig,
  signals: ArenaRequestSignals,
  _rng: () => number = Math.random,
): ArenaPlan {
  if (config.trigger === "manual") {
    return isOptedIn(signals) ? { kind: "matchup" } : { kind: "single" };
  }
  return { kind: "matchup" };
}

/**
 * Fail fast at boot: any non-`always` trigger needs a designated model to serve
 * `single` plans. The roster membership of that id is validated lazily at
 * request time, where the enabled-model list is available.
 */
export function assertArenaModeConfig(config: ArenaModeConfig): void {
  if (config.trigger !== "always" && !config.defaultModel) {
    throw new Error(
      `ARENA_DEFAULT_MODEL is required when ARENA_TRIGGER=${config.trigger}`,
    );
  }
}
