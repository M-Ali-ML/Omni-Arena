/**
 * Shared visual language for the insights charts, matching the paper-and-ink
 * style of the rest of the app (see styles.css).
 */
export const chartColors = {
  ink: "#37352f",
  muted: "#7a776e",
  grid: "#e4e2e0",
  paper: "#fbf9f7",
  positive: "#3f8a5f",
  positiveSoft: "#a8cdb6",
  negative: "#c4674d",
  negativeSoft: "#e3b7a9",
  neutral: "#c9c2b4",
};

/** Categorical palette for per-model series (lines, scatter dots). */
export const seriesPalette = [
  "#37352f",
  "#c4674d",
  "#3f8a5f",
  "#5b7fa6",
  "#a3803d",
  "#8a67a8",
  "#bd6f8e",
  "#4f9391",
  "#7d8a4d",
  "#9a6b4f",
];

export function seriesColor(index: number): string {
  return seriesPalette[index % seriesPalette.length] ?? chartColors.ink;
}

export function formatPercent(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatRating(value: number): string {
  return String(Math.round(value));
}

/**
 * Linear scale helper for the CSS row charts: maps a domain value to a
 * left-offset percentage within the track.
 */
export interface LinearScale {
  min: number;
  max: number;
  pct: (value: number) => number;
  ticks: number[];
}

/** A 1/2/2.5/5×10ⁿ tick step that yields at most maxTicks ticks over span. */
export function niceStep(span: number, maxTicks = 7): number {
  const raw = Math.max(span, 1e-9) / maxTicks;
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const multiple of [1, 2, 2.5, 5, 10]) {
    if (power * multiple >= raw) {
      return power * multiple;
    }
  }
  return power * 10;
}

export function linearScale(
  min: number,
  max: number,
  tickStep: number,
): LinearScale {
  const span = max - min || 1;
  const pct = (value: number): number =>
    Math.min(100, Math.max(0, ((value - min) / span) * 100));
  const ticks: number[] = [];
  const first = Math.ceil(min / tickStep) * tickStep;
  for (let tick = first; tick <= max + 1e-9; tick += tickStep) {
    // Round to kill floating-point drift so tick labels stay clean.
    ticks.push(Math.round(tick * 1e6) / 1e6);
  }
  return { min, max, pct, ticks };
}
