"""Runnable entrypoint for the rating worker.

Reads ``DATABASE_URL``, aggregates votes in-database, fits Bradley-Terry
ratings with Fisher-information CIs, and writes them back. Supports a one-shot
run (default) and a periodic loop (``--loop``) with warm-started refits.

Loop mode mixes two kinds of refit. Most iterations are **incremental**: the
solver starts from the previous solution and converges in a handful of L-BFGS-B
iterations. Every ``FULL_REFIT_EVERY`` refits the warm state is discarded and
the fit runs **from scratch** as a ground-truth pass. Because the ridge makes
the objective strictly convex the two paths have the same unique optimum, so the
cold pass is also a cross-check that the unbroken chain of warm starts has not
drifted away from it.

Usage::

    python -m omniarena_rating              # one-shot
    python -m omniarena_rating --loop       # periodic (REFIT_INTERVAL_SECONDS)
    python -m omniarena_rating --interval 60 --loop
    python -m omniarena_rating --loop --full-refit-every 0   # never force cold

Logging is controlled by ``LOG_LEVEL`` (default ``INFO``) and ``LOG_FORMAT``
(``text`` or ``json``, default ``text``); see :mod:`omniarena_rating.logging_setup`.
"""

from __future__ import annotations

import argparse
import logging
import os
import time
import uuid

import numpy as np

from .aggregate import AggregatedData, fetch_aggregated_data, fetch_session_stats
from .anomaly import detect_anomalous_sessions
from .bradley_terry import fit_bradley_terry
from .logging_setup import configure_logging, get_logger
from .report import SCALE, RatingReport, compute_ratings
from .style import compute_style_ratings, fetch_style_votes
from .writeback import write_ratings, write_style_ratings

logger = get_logger(__name__)

# Largest gap tolerated between the ground-truth cold fit and a warm-started fit
# of the *same* aggregates, measured in each model's own standard errors. An
# absolute (display-point) threshold does not transfer: L-BFGS-B stops on a
# *relative* function tolerance, so its parameter accuracy loosens as the
# log-likelihood grows with vote volume. Scaling by the standard error keeps the
# check meaningful at any data scale -- a disagreement well inside one standard
# error is statistically invisible on the leaderboard. Calibration over synthetic
# refits (3-60 models, 10-20k votes per pair) puts a realistic one-interval warm
# step below 0.06 standard errors, while a warm fit that genuinely stalls short
# of the optimum lands whole standard errors away.
WARM_DRIFT_TOLERANCE_SE = 0.5


def _connect(database_url: str):
    try:
        import psycopg
    except ImportError as exc:  # pragma: no cover - import guard
        raise SystemExit(
            "psycopg is required to run the worker; install requirements.txt"
        ) from exc
    return psycopg.connect(database_url)


def _screen_sessions(conn, log, *, enabled: bool) -> list[str]:
    """Return anonymous session ids to exclude from the fit before aggregating.

    Runs the p-value based anomaly detector over per-session vote tallies; when
    disabled (``--no-anomaly-filter``) nothing is excluded.
    """
    if not enabled:
        return []
    stats = fetch_session_stats(conn)
    report = detect_anomalous_sessions(stats)
    excluded = sorted(report.flagged_sessions)
    if excluded:
        log.info(
            "Anomaly screen excluded %d of %d session(s) before fitting.",
            len(excluded),
            len(stats),
        )
    return excluded


def _run_style_pass(conn, log, data, excluded: list[str], *, ridge: float) -> None:
    """Heavier periodic style-controlled fit on raw (bucketing-free) votes."""
    index_of = {model_id: i for i, model_id in enumerate(data.model_ids)}
    votes = fetch_style_votes(conn, index_of, excluded_sessions=excluded)
    report = compute_style_ratings(
        data.model_ids, data.display_names, votes, ridge=ridge
    )
    if report is None:
        log.info("No votes for the style-controlled pass; skipping.")
        return
    written = write_style_ratings(conn, report)
    coeffs = " ".join(
        f"{name}={value:+.3f}" for name, value in report.coefficients.items()
    )
    log.info(
        "Style-controlled %d models over %d votes; converged=%s coefficients=[%s]",
        written,
        report.n_votes,
        report.converged,
        coeffs,
    )


def _check_warm_drift(
    log,
    data: AggregatedData,
    seed: np.ndarray,
    cold: RatingReport,
    *,
    ridge: float,
) -> None:
    """Warn if the incremental path no longer lands on the cold optimum.

    The ridge prior makes the penalised objective strictly convex, so the raw
    optimiser vector ``[r_0..r_{n-1}, eta]`` is the *unique* minimiser: a
    warm-started fit of these same aggregates must reach the same point as the
    from-scratch fit that was just written back. Refitting from ``seed`` here is
    cheap (it starts at the previous solution) and holds the data fixed, which is
    what makes the comparison meaningful -- diffing the cold ratings against what
    the warm chain reported on the *previous* interval would instead measure the
    genuine rating movement caused by new votes.

    Disagreement is reported in standard-error units (see
    :data:`WARM_DRIFT_TOLERANCE_SE`). Models whose standard error is degenerate
    are excluded: their intervals are already flagged as untrustworthy by
    :func:`omniarena_rating.report.compute_ratings`.
    """
    if cold.warm_state is None:
        return
    warm = fit_bradley_terry(
        data.n_models, data.pairs, ridge=ridge, anchor="mean", init=seed
    )
    n = data.n_models
    shift = SCALE * np.abs(warm.raw_params[:n] - cold.warm_state[:n])
    stderr_of = {m.model_id: m.rating_stderr for m in cold.models}
    stderr = np.array([stderr_of[model_id] for model_id in data.model_ids])
    usable = np.isfinite(stderr) & (stderr > 0.0)
    if not usable.any():
        return
    drift = float(np.max(shift[usable] / stderr[usable]))
    if drift > WARM_DRIFT_TOLERANCE_SE:
        log.warning(
            "Warm-started refit diverges from the ground-truth fit by %.2f "
            "standard error(s) (tolerance %.2f); the incremental path may be "
            "stopping short of the optimum.",
            drift,
            WARM_DRIFT_TOLERANCE_SE,
        )
    else:
        log.debug("Warm-start cross-check: max drift %.3f standard error(s).", drift)


def run_once(
    database_url: str,
    *,
    ridge: float,
    warm_start=None,
    run_id: str | None = None,
    with_style: bool = False,
    style_ridge: float = 0.05,
    filter_anomalies: bool = True,
    force_cold: bool = False,
):
    """Aggregate, fit, and write back once. Returns (report, warm_start).

    ``force_cold`` discards any usable ``warm_start`` and fits from scratch, the
    periodic ground-truth pass the loop schedules; the cold result is then
    cross-checked against a warm-started fit of the same aggregates.
    """
    run_id = run_id or uuid.uuid4().hex[:8]
    log = logging.LoggerAdapter(logger, {"run_id": run_id})
    started = time.perf_counter()
    conn = _connect(database_url)
    try:
        excluded = _screen_sessions(conn, log, enabled=filter_anomalies)
        fetch_started = time.perf_counter()
        data = fetch_aggregated_data(conn, excluded_sessions=excluded)
        fetch_ms = (time.perf_counter() - fetch_started) * 1e3
        log.debug(
            "Aggregated votes: models=%d pairs=%d fetch_ms=%.1f",
            data.n_models,
            len(data.pairs),
            fetch_ms,
        )
        if data.n_models == 0:
            log.info("No enabled models; nothing to rate.")
            return None, warm_start
        if not data.pairs:
            log.info("No comparisons yet; skipping fit.")
            return None, warm_start
        # Warm-start only when the model set is unchanged since the last refit,
        # and never on a forced ground-truth pass.
        reusable = (
            warm_start
            if warm_start is not None
            and warm_start.shape == (data.n_models + 1,)
            else None
        )
        seed = None if force_cold else reusable
        mode = "incremental" if seed is not None else "full"
        log.debug("Fitting ratings: mode=%s", mode)
        report = compute_ratings(data, ridge=ridge, warm_start=seed)
        write_started = time.perf_counter()
        written = write_ratings(conn, report)
        write_ms = (time.perf_counter() - write_started) * 1e3
        leader = report.models[0]
        log.info(
            "Rated %d models across %d component(s); "
            "leader %s %.0f (+/-%.0f); tie_param=%.3f converged=%s iters=%d "
            "mode=%s (fetch_ms=%.1f write_ms=%.1f total_ms=%.1f)",
            written,
            len({m.component_id for m in report.models}),
            leader.display_name,
            leader.rating,
            leader.rating - leader.ci_lower,
            report.tie_param,
            report.converged,
            report.n_iter,
            mode,
            fetch_ms,
            write_ms,
            (time.perf_counter() - started) * 1e3,
        )
        if force_cold and reusable is not None:
            _check_warm_drift(log, data, reusable, report, ridge=ridge)
        if with_style:
            _run_style_pass(conn, log, data, excluded, ridge=style_ridge)
        return report, report.warm_state
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="omniarena_rating")
    parser.add_argument(
        "--loop",
        action="store_true",
        help="run continuously, refitting every interval",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=float(os.environ.get("REFIT_INTERVAL_SECONDS", "300")),
        help="seconds between refits in loop mode",
    )
    parser.add_argument(
        "--full-refit-every",
        type=int,
        default=int(os.environ.get("FULL_REFIT_EVERY", "12")),
        help=(
            "refits between from-scratch (cold) ground-truth fits in loop "
            "mode; 0 warm-starts indefinitely"
        ),
    )
    parser.add_argument(
        "--ridge",
        type=float,
        default=float(os.environ.get("RATING_RIDGE", "0.01")),
        help="ridge prior strength (log-odds scale)",
    )
    parser.add_argument(
        "--style",
        action="store_true",
        help="also run the heavier style-controlled fit on raw votes",
    )
    parser.add_argument(
        "--style-ridge",
        type=float,
        default=float(os.environ.get("STYLE_RIDGE", "0.05")),
        help="ridge prior strength for the style-controlled fit",
    )
    parser.add_argument(
        "--no-anomaly-filter",
        action="store_true",
        help="skip the pre-fit anomaly screen (keep every session)",
    )
    args = parser.parse_args(argv)

    configure_logging()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        logger.error("DATABASE_URL is not set.")
        return 1

    filter_anomalies = not args.no_anomaly_filter
    warm_start = None
    if not args.loop:
        run_once(
            database_url,
            ridge=args.ridge,
            warm_start=warm_start,
            with_style=args.style,
            style_ridge=args.style_ridge,
            filter_anomalies=filter_anomalies,
        )
        return 0

    logger.info(
        "Rating worker loop started; interval=%ss full_refit_every=%s.",
        args.interval,
        args.full_refit_every if args.full_refit_every > 0 else "never",
    )
    # Refits completed since the last from-scratch fit, the first of which is
    # the loop's opening iteration (it has no warm state to reuse). Counting the
    # cold fit itself as one keeps the cadence exact: with N=12 the forced pass
    # lands on refits 1, 13, 25, ... rather than one iteration early.
    since_full = 0
    while True:
        force_full = (
            args.full_refit_every > 0 and since_full >= args.full_refit_every
        )
        # Captured before ``run_once`` reassigns warm_start. A cold fit that
        # ``run_once`` takes on its own (changed model set) is not visible here,
        # so the cadence is an upper bound on drift, never a lower one.
        cold = force_full or warm_start is None
        if force_full:
            logger.info(
                "Scheduled ground-truth pass: discarding warm state after "
                "%d refit(s) and fitting from scratch.",
                since_full,
            )
        try:
            report, warm_start = run_once(
                database_url,
                ridge=args.ridge,
                warm_start=warm_start,
                with_style=args.style,
                style_ridge=args.style_ridge,
                filter_anomalies=filter_anomalies,
                force_cold=force_full,
            )
            # Only completed fits advance the cadence; iterations that skipped
            # (no models or no comparisons yet) leave the clock where it was.
            if report is not None:
                since_full = 1 if cold else since_full + 1
        except Exception:  # keep the loop alive across transient errors
            # ``exception`` captures the full traceback, not just str(exc).
            logger.exception("Refit failed; retrying after interval.")
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
