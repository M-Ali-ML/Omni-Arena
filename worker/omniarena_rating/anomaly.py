"""Pre-fit anomaly detection over anonymous voting sessions.

Spam or malicious voters distort a Bradley-Terry fit just as badly as they
distort a raw win-rate, so OmniArena screens sessions *before* aggregation with
simple, principled statistical tests rather than ad-hoc thresholds. Every test
produces a p-value (or an equivalent tail probability); a session is excluded
when any test rejects its null hypothesis at the configured significance level.

Sessions are identified by ``preferences.anonymous_session_id`` (already
collected). The three tests, each targeting a distinct abuse pattern:

* **Volume (Poisson upper tail).** Under the null that a session's vote count is
  drawn from ``Poisson(mean_votes_per_session)``, an implausibly high count has
  a tiny survival probability ``P(X >= n)``. Flags vote-stuffing.
* **Position bias (two-sided binomial).** Slots are randomised, so a genuine
  voter's decisive left/right split is ``Binomial(n, 0.5)``. A degenerate
  always-left / always-right session has a vanishing two-sided p-value. Flags
  bots that click a fixed side.
* **Speed (median inter-vote gap).** When vote timestamps are available, a
  human cannot read two full model responses and vote in a fraction of a
  second. Sessions whose median gap between consecutive votes is below a floor
  are flagged as automated.

The multiple-comparison guard (Bonferroni over the number of tests) keeps the
family-wise false-exclusion rate near ``alpha`` even though three tests run per
session.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class SessionStats:
    """Per-session voting summary consumed by the detectors.

    ``left`` / ``right`` count decisive votes for the left / right slot; ``ties``
    and ``skips`` are non-positional outcomes. ``timestamps`` are Unix seconds of
    each vote (any order); empty/absent when the store lacks them.
    """

    session_id: str
    left: int
    right: int
    ties: int
    skips: int
    timestamps: tuple[float, ...] = ()

    @property
    def total(self) -> int:
        return self.left + self.right + self.ties + self.skips

    @property
    def decisive(self) -> int:
        return self.left + self.right


@dataclass
class AnomalyConfig:
    """Thresholds for the anomaly tests."""

    alpha: float = 1e-3
    min_votes_for_volume: int = 20
    min_decisive_for_position: int = 15
    min_votes_for_speed: int = 8
    min_median_gap_seconds: float = 1.5


@dataclass
class SessionVerdict:
    session_id: str
    flagged: bool
    reasons: list[str] = field(default_factory=list)


@dataclass
class AnomalyReport:
    verdicts: list[SessionVerdict]

    @property
    def flagged_sessions(self) -> set[str]:
        return {v.session_id for v in self.verdicts if v.flagged}

    def reasons_for(self, session_id: str) -> list[str]:
        for verdict in self.verdicts:
            if verdict.session_id == session_id:
                return verdict.reasons
        return []


def _poisson_sf(count: int, mean: float) -> float:
    """P(X >= count) for X ~ Poisson(mean); 1.0 when the mean is degenerate."""
    if mean <= 0:
        return 1.0
    from scipy.stats import poisson

    return float(poisson.sf(count - 1, mean))


def _binom_two_sided_p(successes: int, trials: int) -> float:
    """Two-sided binomial test p-value against p = 0.5."""
    if trials == 0:
        return 1.0
    from scipy.stats import binomtest

    return float(binomtest(successes, trials, 0.5, alternative="two-sided").pvalue)


def _median_gap(timestamps: tuple[float, ...]) -> float | None:
    """Median gap between consecutive votes, or ``None`` if too few points."""
    if len(timestamps) < 2:
        return None
    ordered = sorted(timestamps)
    gaps = [b - a for a, b in zip(ordered, ordered[1:])]
    gaps.sort()
    mid = len(gaps) // 2
    if len(gaps) % 2:
        return gaps[mid]
    return 0.5 * (gaps[mid - 1] + gaps[mid])


def detect_anomalous_sessions(
    sessions: list[SessionStats],
    *,
    config: AnomalyConfig | None = None,
) -> AnomalyReport:
    """Flag statistically anomalous sessions before rating aggregation."""
    cfg = config or AnomalyConfig()
    verdicts: list[SessionVerdict] = []
    if not sessions:
        return AnomalyReport(verdicts=[])

    # Bonferroni-adjust for the three tests applied per session.
    threshold = cfg.alpha / 3.0

    totals = [s.total for s in sessions]
    mean_votes = sum(totals) / len(totals) if totals else 0.0

    for session in sessions:
        reasons: list[str] = []

        if session.total >= cfg.min_votes_for_volume:
            p_volume = _poisson_sf(session.total, mean_votes)
            if p_volume < threshold:
                reasons.append(
                    f"volume p={p_volume:.2e} "
                    f"(n={session.total} vs mean {mean_votes:.1f})"
                )

        if session.decisive >= cfg.min_decisive_for_position:
            p_position = _binom_two_sided_p(session.left, session.decisive)
            if p_position < threshold:
                reasons.append(
                    f"position p={p_position:.2e} "
                    f"(left {session.left}/{session.decisive})"
                )

        if len(session.timestamps) >= cfg.min_votes_for_speed:
            gap = _median_gap(session.timestamps)
            if gap is not None and gap < cfg.min_median_gap_seconds:
                reasons.append(
                    f"speed median_gap={gap:.2f}s "
                    f"< {cfg.min_median_gap_seconds}s"
                )

        verdicts.append(
            SessionVerdict(
                session_id=session.session_id,
                flagged=bool(reasons),
                reasons=reasons,
            )
        )

    return AnomalyReport(verdicts=verdicts)
