// Synthetic arena history for demos and local development.
//
// A fresh install has no votes, so every chart on /insights renders its empty
// state. This script fabricates a plausible voting record — matchups spread
// over a time window, responses with varied latency/verbosity/formatting, and
// votes drawn from the same Rao-Kupper model the rating worker fits — so the
// whole dashboard lights up in one command.
//
// The generated votes deliberately contain style confounding (verbose and
// heavily formatted answers win more often than their latent strength alone
// justifies), which is exactly the signal `python -m omniarena_rating --style`
// exists to regress out. Seeded ratings are a win-rate approximation; a real
// worker run overwrites them with a proper fit.
//
//   npm run db:seed:demo --workspace server
//   npm run db:seed:demo --workspace server -- --reset --matchups 400 --days 30
import { createHash, randomUUID } from "node:crypto";
import { pool } from "./pool.js";

const DEMO_SESSION_PREFIX = "demo-";
/** Elo-like points per unit of log-odds, matching the worker's reporting scale. */
const ELO_SCALE = 400 / Math.LN10;
/** Rao-Kupper tie threshold: larger means more "both good"/"both bad" votes. */
const TIE_THRESHOLD = 0.55;
const SKIP_PROBABILITY = 0.04;
/** Log-odds the voter hands to whichever answer is shown in slot A. */
const POSITION_BIAS = 0.18;
/** Log-odds per standard deviation of the A−B gap in each style feature. */
const VERBOSITY_BIAS = 0.55;
const FORMATTING_BIAS = 0.45;
const LATENCY_BIAS = -0.15;

interface Options {
  matchups: number;
  days: number;
  reset: boolean;
  seed: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { matchups: 240, days: 14, reset: false, seed: 20260724 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--reset") {
      options.reset = true;
    } else if (flag === "--matchups") {
      options.matchups = Number(argv[++i]);
    } else if (flag === "--days") {
      options.days = Number(argv[++i]);
    } else if (flag === "--seed") {
      options.seed = Number(argv[++i]);
    }
  }
  if (!Number.isFinite(options.matchups) || options.matchups < 1) {
    throw new Error("--matchups must be a positive number");
  }
  if (!Number.isFinite(options.days) || options.days < 1) {
    throw new Error("--days must be a positive number");
  }
  return options;
}

/** Deterministic PRNG so repeated runs produce an identical arena. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

interface ModelRow {
  id: string;
  display_name: string;
  provider_model_id: string;
}

interface Profile {
  id: string;
  displayName: string;
  providerModelId: string;
  /** Latent Bradley-Terry strength in log-odds. */
  strength: number;
  meanTokens: number;
  meanMarkdown: number;
  meanTtftMs: number;
  msPerToken: number;
  providerUsage: boolean;
}

/** Size class inferred from the model name, with the trade-offs it implies. */
type Tier = "light" | "mid" | "heavy";

interface TierTraits {
  /** Baseline log-odds strength for the class. */
  strength: number;
  baseTokens: number;
  baseMarkdown: number;
  baseTtftMs: number;
  baseMsPerToken: number;
}

// A "lite" model is genuinely fast and genuinely weaker — the trade-off anyone
// picking between tiers actually faces, and the reason the "does faster win?"
// scatter is worth looking at.
const TIERS: Record<Tier, TierTraits> = {
  light: { strength: -0.62, baseTokens: 210, baseMarkdown: 0.1, baseTtftMs: 175, baseMsPerToken: 4.5 },
  mid: { strength: 0, baseTokens: 430, baseMarkdown: 0.28, baseTtftMs: 320, baseMsPerToken: 8 },
  heavy: { strength: 0.45, baseTokens: 560, baseMarkdown: 0.34, baseTtftMs: 520, baseMsPerToken: 13 },
};

/**
 * Log-odds of strength bought by being a full version-spread newer. Held above
 * the style advantage padding can buy, so a genuinely better model still tops
 * the raw leaderboard and style control widens its lead instead of flipping it.
 */
const VERSION_WEIGHT = 0.7;

const LIGHT_MARKERS = ["lite", "mini", "nano", "small", "tiny", "8b", "haiku"];
const HEAVY_MARKERS = ["pro", "ultra", "opus", "max", "large", "70b", "thinking"];

/**
 * Markers must match a whole name segment, not any substring: "gemini" ends in
 * "mini" and "preview" would otherwise never be safe next to "pro".
 */
function hasMarker(name: string, markers: string[]): boolean {
  const segments = name.split(/[^a-z0-9]+/);
  return segments.some((segment) => markers.includes(segment));
}

function classifyTier(name: string): Tier {
  if (hasMarker(name, LIGHT_MARKERS)) {
    return "light";
  }
  if (hasMarker(name, HEAVY_MARKERS)) {
    return "heavy";
  }
  return "mid";
}

/** First version-looking number in the name, e.g. 3.5 from "gemini-3.5-flash". */
function parseVersion(name: string): number | null {
  const match = name.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

/**
 * Derive each model's personality from its name so the seeded arena matches the
 * intuition a reader brings to it: newer versions are stronger, and a "lite"
 * variant is the fast-but-less-accurate option however new it is.
 *
 * Verbosity runs the other way from recency — older models in the same class pad
 * their answers with headers and preamble. That padding earns real votes, so the
 * runner-up closes most of the gap on the raw leaderboard and gives it all back
 * once style is regressed out, which is what the style charts exist to show.
 */
function buildProfiles(models: ModelRow[], random: () => number): Profile[] {
  const described = models.map((model, index) => {
    const name = `${model.display_name} ${model.provider_model_id}`.toLowerCase();
    return { model, index, tier: classifyTier(name), version: parseVersion(name) };
  });

  const versions = described
    .map((entry) => entry.version)
    .filter((version): version is number => version !== null);
  const meanVersion = versions.length > 0 ? average(versions) : 0;
  const versionSpread = Math.max(...versions, meanVersion) - Math.min(...versions, meanVersion) || 1;

  return described.map(({ model, index, tier, version }) => {
    const traits = TIERS[tier];
    // Normalized recency in roughly [-0.5, 0.5]. Unversioned rosters (the mock
    // pair, say) fall back to declaration order so they still get a ranking.
    const recency =
      version === null
        ? 0.5 - index / Math.max(described.length - 1, 1)
        : (version - meanVersion) / versionSpread;

    const strength = traits.strength + VERSION_WEIGHT * recency;
    // Older models in the same class lean on formatting and length.
    const padding = 0.5 - recency;
    return {
      id: model.id,
      displayName: model.display_name,
      providerModelId: model.provider_model_id,
      strength,
      meanTokens: Math.round(traits.baseTokens * (0.8 + 0.55 * padding) + random() * 40),
      meanMarkdown: Math.min(
        0.92,
        Math.max(0.04, traits.baseMarkdown * (0.7 + 0.95 * padding) + random() * 0.03),
      ),
      meanTtftMs: Math.round(traits.baseTtftMs * (0.9 + 0.2 * random())),
      msPerToken: traits.baseMsPerToken * (0.85 + 0.3 * random()),
      providerUsage: tier !== "light",
    };
  });
}

/** Box-Muller normal sample, clamped to keep generated metrics sane. */
function normal(random: () => number, mean: number, stdDev: number): number {
  const u = Math.max(random(), 1e-9);
  const v = random();
  return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface GeneratedResponse {
  modelId: string;
  tokens: number;
  markdown: number;
  ttftMs: number;
  durationMs: number;
  tokenSource: "provider" | "estimated";
}

function generateResponse(profile: Profile, random: () => number): GeneratedResponse {
  const tokens = Math.max(24, Math.round(normal(random, profile.meanTokens, profile.meanTokens * 0.3)));
  const markdown = Math.min(0.95, Math.max(0, normal(random, profile.meanMarkdown, 0.08)));
  const ttftMs = Math.max(45, Math.round(normal(random, profile.meanTtftMs, profile.meanTtftMs * 0.35)));
  const durationMs = ttftMs + Math.max(30, Math.round(tokens * profile.msPerToken * (0.75 + random() * 0.6)));
  return {
    modelId: profile.id,
    tokens,
    markdown,
    ttftMs,
    durationMs,
    tokenSource: profile.providerUsage ? "provider" : "estimated",
  };
}

const PROMPTS = [
  "Explain eventual consistency to a backend engineer new to distributed systems.",
  "Write a Python function that merges overlapping intervals and explain the approach.",
  "Summarize the trade-offs between server-side rendering and static generation.",
  "How would you debug a memory leak in a long-running Node.js service?",
  "Draft a concise migration plan from REST to GraphQL for a mid-size API.",
  "Explain why floating point arithmetic surprises people, with examples.",
  "Design a rate limiter for a multi-tenant API and justify the algorithm.",
  "What are the practical differences between a mutex and a semaphore?",
  "Review this approach: storing session tokens in localStorage. Good or bad?",
  "Explain database index selectivity and when an index stops helping.",
];

/**
 * All unordered model pairs, cycled in order so coverage stays even and the
 * head-to-head matrix fills in rather than leaving holes.
 */
function buildPairCycle(profiles: Profile[]): Array<[Profile, Profile]> {
  const pairs: Array<[Profile, Profile]> = [];
  for (let i = 0; i < profiles.length; i += 1) {
    for (let j = i + 1; j < profiles.length; j += 1) {
      const left = profiles[i];
      const right = profiles[j];
      if (left && right) {
        pairs.push([left, right]);
      }
    }
  }
  return pairs;
}

interface VoteRecord {
  matchupId: string;
  vote: "left" | "right" | "both_good" | "both_bad" | "skip";
  winnerModelId: string | null;
  slotAModelId: string;
  slotBModelId: string;
  createdAt: Date;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const random = createRandom(options.seed);

  const { rows: models } = await pool.query<ModelRow>(
    `SELECT id, display_name, provider_model_id
     FROM models WHERE enabled = TRUE
     ORDER BY created_at, display_name`,
  );
  if (models.length < 2) {
    throw new Error(
      `Need at least 2 enabled models, found ${models.length}. Run db:seed or db:seed:mock first.`,
    );
  }

  if (options.reset) {
    // Cascades to turns, responses, and preferences. Scoped to demo sessions so
    // votes recorded through the real UI survive.
    const deleted = await pool.query(
      `DELETE FROM matchups WHERE id IN (
         SELECT t.matchup_id FROM turns t
         JOIN conversations c ON c.id = t.conversation_id
         WHERE c.anonymous_session_id LIKE $1
       )`,
      [`${DEMO_SESSION_PREFIX}%`],
    );
    await pool.query("DELETE FROM conversations WHERE anonymous_session_id LIKE $1", [
      `${DEMO_SESSION_PREFIX}%`,
    ]);
    console.log(`Removed ${deleted.rowCount ?? 0} previously seeded matchups`);
  }

  const profiles = buildProfiles(models, random);
  const pairCycle = buildPairCycle(profiles);
  const votes: VoteRecord[] = [];

  const now = Date.now();
  const windowMs = options.days * 24 * 60 * 60 * 1000;
  const start = now - windowMs;

  // One session per handful of votes. Sessions must stay small and mixed: the
  // worker's anomaly screen excludes sessions that look like vote-stuffing or a
  // stuck-on-one-side bot, and an excluded session contributes nothing to the fit.
  let sessionId = `${DEMO_SESSION_PREFIX}${randomUUID().slice(0, 8)}`;
  let sessionVotes = 0;
  let sessionLimit = 3 + Math.floor(random() * 6);

  for (let index = 0; index < options.matchups; index += 1) {
    if (sessionVotes >= sessionLimit) {
      sessionId = `${DEMO_SESSION_PREFIX}${randomUUID().slice(0, 8)}`;
      sessionVotes = 0;
      sessionLimit = 3 + Math.floor(random() * 6);
    }
    sessionVotes += 1;

    // Ramp volume toward the present so the activity chart has a shape.
    const progress = Math.sqrt((index + random()) / options.matchups);
    const createdAt = new Date(start + progress * windowMs);

    const pair = pairCycle[index % pairCycle.length];
    if (!pair) {
      continue;
    }
    const [first, second] = pair;
    // Randomize which side of the pair is displayed as slot A.
    const flip = random() < 0.5;
    const slotA = flip ? second : first;
    const slotB = flip ? first : second;

    const responseA = generateResponse(slotA, random);
    const responseB = generateResponse(slotB, random);

    // What the voter reacts to: true strength plus the style confounders.
    const tokenGap = (responseA.tokens - responseB.tokens) / 400;
    const markdownGap = responseA.markdown - responseB.markdown;
    const latencyGap = (responseA.durationMs - responseB.durationMs) / 4000;
    const delta =
      slotA.strength -
      slotB.strength +
      POSITION_BIAS +
      VERBOSITY_BIAS * tokenGap +
      FORMATTING_BIAS * markdownGap +
      LATENCY_BIAS * latencyGap;

    const pA = sigmoid(delta - TIE_THRESHOLD);
    const pB = sigmoid(-delta - TIE_THRESHOLD);
    const draw = random();

    let vote: VoteRecord["vote"];
    let winnerModelId: string | null = null;
    if (random() < SKIP_PROBABILITY) {
      vote = "skip";
    } else if (draw < pA) {
      vote = "left";
      winnerModelId = slotA.id;
    } else if (draw < pA + pB) {
      vote = "right";
      winnerModelId = slotB.id;
    } else {
      // Ties split between "both good" and "both bad" by overall answer quality.
      vote = slotA.strength + slotB.strength > 0 ? "both_good" : "both_bad";
    }

    const matchupId = randomUUID();
    const conversationId = randomUUID();
    const responseAId = randomUUID();
    const responseBId = randomUUID();
    const prompt = PROMPTS[index % PROMPTS.length];
    const timestamp = createdAt.toISOString();

    await pool.query(
      "INSERT INTO conversations (id, anonymous_session_id, created_at) VALUES ($1, $2, $3)",
      [conversationId, sessionId, timestamp],
    );
    await pool.query(
      `INSERT INTO matchups (
         id, prompt, model_a_id, model_b_id, slot_a_model_id, slot_b_model_id,
         slot_a_provider_model_id, slot_b_provider_model_id,
         matchup_token_hash, harness_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'demo', $10)`,
      [
        matchupId,
        prompt,
        first.id,
        second.id,
        slotA.id,
        slotB.id,
        slotA.providerModelId,
        slotB.providerModelId,
        createHash("sha256").update(randomUUID()).digest("hex"),
        timestamp,
      ],
    );
    await pool.query(
      `INSERT INTO turns (
         id, conversation_id, matchup_id, parent_response_id, turn_index, prompt, created_at
       ) VALUES ($1, $2, $3, NULL, 0, $4, $5)`,
      [randomUUID(), conversationId, matchupId, prompt, timestamp],
    );

    for (const [responseId, slot, generated] of [
      [responseAId, "A", responseA],
      [responseBId, "B", responseB],
    ] as const) {
      await pool.query(
        `INSERT INTO responses (
           id, matchup_id, slot, model_id, content, latency_ms, created_at,
           ttft_ms, stream_duration_ms, output_token_count, token_count_source,
           markdown_density, model_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          responseId,
          matchupId,
          slot,
          generated.modelId,
          `Seeded demo answer for: ${prompt}`,
          generated.durationMs,
          timestamp,
          generated.ttftMs,
          generated.durationMs,
          generated.tokens,
          generated.tokenSource,
          Number(generated.markdown.toFixed(4)),
          "demo-seed",
        ],
      );
    }

    await pool.query(
      `INSERT INTO preferences (
         id, matchup_id, vote, winner_model_id, position_bias_meta,
         anonymous_session_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        matchupId,
        vote,
        winnerModelId,
        JSON.stringify({
          selectedSlot: vote === "left" ? "A" : vote === "right" ? "B" : null,
        }),
        sessionId,
        timestamp,
      ],
    );

    votes.push({
      matchupId,
      vote,
      winnerModelId,
      slotAModelId: slotA.id,
      slotBModelId: slotB.id,
      createdAt,
    });
  }

  await seedRatings(profiles, votes, options);

  const decisive = votes.filter((v) => v.vote === "left" || v.vote === "right").length;
  const ties = votes.filter((v) => v.vote === "both_good" || v.vote === "both_bad").length;
  const skips = votes.filter((v) => v.vote === "skip").length;
  console.log(
    `Seeded ${votes.length} matchups across ${options.days} days ` +
      `(${decisive} decisive, ${ties} ties, ${skips} skips) for ${profiles.length} models`,
  );
  console.log("Open /insights to see the dashboard.");
  console.log(
    "Ratings above are a win-rate approximation; run the worker for a real fit:\n" +
      "  cd worker && uv run python -m omniarena_rating --style",
  );
}

/**
 * Backfill the worker-owned tables so the rating charts have data before the
 * Python worker has ever run. Ratings come from the cumulative win rate at a
 * series of checkpoints, mapped onto the worker's Elo-like scale — the same
 * quantity Bradley-Terry converges to for an evenly sampled round robin, so the
 * seeded numbers stay close to what a real fit produces.
 */
async function seedRatings(
  profiles: Profile[],
  votes: VoteRecord[],
  options: Options,
): Promise<void> {
  const modelIds = profiles.map((profile) => profile.id);
  await pool.query("DELETE FROM model_rating_history WHERE model_id = ANY($1)", [modelIds]);
  await pool.query("DELETE FROM model_ratings WHERE model_id = ANY($1)", [modelIds]);
  await pool.query("DELETE FROM model_style_ratings WHERE model_id = ANY($1)", [modelIds]);

  const decisiveAndTies = votes
    .filter((vote) => vote.vote !== "skip")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // One checkpoint per day, mimicking a worker that refit daily over the window.
  const checkpoints = Math.min(options.days, 12);
  const oldest = decisiveAndTies[0]?.createdAt.getTime() ?? Date.now();
  const newest = decisiveAndTies.at(-1)?.createdAt.getTime() ?? Date.now();

  for (let step = 1; step <= checkpoints; step += 1) {
    const cutoff = oldest + ((newest - oldest) * step) / checkpoints;
    const upTo = decisiveAndTies.filter((vote) => vote.createdAt.getTime() <= cutoff);
    const stats = tally(profiles, upTo);
    const isFinal = step === checkpoints;

    for (const profile of profiles) {
      const { games, wins, ties } = stats.get(profile.id)!;
      if (games === 0) {
        continue;
      }
      const rating = ratingFromRecord(wins, ties, games);
      const stderr = stderrFromGames(games);
      const computedAt = new Date(cutoff).toISOString();
      await pool.query(
        `INSERT INTO model_rating_history (
           model_id, rating, rating_stderr, ci_lower, ci_upper, component_id, games, computed_at
         ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7)`,
        [profile.id, rating, stderr, rating - 1.96 * stderr, rating + 1.96 * stderr, games, computedAt],
      );

      if (isFinal) {
        await pool.query(
          `INSERT INTO model_ratings (
             model_id, rating, rating_stderr, ci_lower, ci_upper, component_id, games, computed_at
           ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7)`,
          [profile.id, rating, stderr, rating - 1.96 * stderr, rating + 1.96 * stderr, games, computedAt],
        );

        // Style-controlled: strip the verbosity/formatting advantage back out,
        // measured against the roster average, so heavy formatters lose ground.
        const meanTokens = average(profiles.map((p) => p.meanTokens));
        const meanMarkdown = average(profiles.map((p) => p.meanMarkdown));
        const penalty =
          VERBOSITY_BIAS * ((profile.meanTokens - meanTokens) / 400) +
          FORMATTING_BIAS * (profile.meanMarkdown - meanMarkdown);
        const styleRating = rating - penalty * ELO_SCALE;
        const styleStderr = stderr * 1.15;
        await pool.query(
          `INSERT INTO model_style_ratings (
             model_id, style_controlled_rating, style_controlled_stderr,
             style_ci_lower, style_ci_upper, component_id, games, computed_at
           ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7)`,
          [
            profile.id,
            styleRating,
            styleStderr,
            styleRating - 1.96 * styleStderr,
            styleRating + 1.96 * styleStderr,
            games,
            computedAt,
          ],
        );
      }
    }
  }

  const coefficients: Array<[string, number]> = [
    ["position", POSITION_BIAS],
    ["verbosity", VERBOSITY_BIAS],
    ["formatting", FORMATTING_BIAS],
    ["latency_ttft", LATENCY_BIAS / 2],
    ["latency_duration", LATENCY_BIAS],
  ];
  for (const [feature, coefficient] of coefficients) {
    await pool.query(
      `INSERT INTO style_control_coefficients (feature, coefficient, computed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (feature) DO UPDATE SET
         coefficient = EXCLUDED.coefficient,
         computed_at = EXCLUDED.computed_at`,
      [feature, coefficient],
    );
  }
}

function tally(
  profiles: Profile[],
  votes: VoteRecord[],
): Map<string, { games: number; wins: number; ties: number }> {
  const stats = new Map(
    profiles.map((profile) => [profile.id, { games: 0, wins: 0, ties: 0 }]),
  );
  for (const vote of votes) {
    for (const modelId of [vote.slotAModelId, vote.slotBModelId]) {
      const entry = stats.get(modelId);
      if (!entry) {
        continue;
      }
      entry.games += 1;
      if (vote.winnerModelId === modelId) {
        entry.wins += 1;
      } else if (vote.winnerModelId === null) {
        entry.ties += 1;
      }
    }
  }
  return stats;
}

/** Win rate (ties as half a win) mapped onto the worker's Elo-like scale. */
function ratingFromRecord(wins: number, ties: number, games: number): number {
  const score = (wins + ties / 2) / games;
  const clamped = Math.min(0.98, Math.max(0.02, score));
  return 1000 + ELO_SCALE * Math.log(clamped / (1 - clamped));
}

/** Standard error of the log-odds, widened for small samples. */
function stderrFromGames(games: number): number {
  return (ELO_SCALE * 2) / Math.sqrt(Math.max(games, 1));
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

try {
  await main();
} finally {
  await pool.end();
}
