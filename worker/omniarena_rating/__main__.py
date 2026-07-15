"""Runnable entrypoint for the rating worker.

Reads ``DATABASE_URL``, aggregates votes in-database, fits Bradley-Terry
ratings with Fisher-information CIs, and writes them back. Supports a one-shot
run (default) and a periodic loop (``--loop``) with warm-started refits.

Usage::

    python -m omniarena_rating              # one-shot
    python -m omniarena_rating --loop       # periodic (REFIT_INTERVAL_SECONDS)
    python -m omniarena_rating --interval 60 --loop

Logging is controlled by ``LOG_LEVEL`` (default ``INFO``) and ``LOG_FORMAT``
(``text`` or ``json``, default ``text``); see :mod:`omniarena_rating.logging_setup`.
"""

from __future__ import annotations

import argparse
import logging
import os
import time
import uuid

from .aggregate import fetch_aggregated_data, fetch_session_stats
from .anomaly import detect_anomalous_sessions
from .logging_setup import configure_logging, get_logger
from .report import compute_ratings
from .style import compute_style_ratings, fetch_style_votes
from .writeback import write_ratings, write_style_ratings

logger = get_logger(__name__)


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


def run_once(
    database_url: str,
    *,
    ridge: float,
    warm_start=None,
    run_id: str | None = None,
    with_style: bool = False,
    style_ridge: float = 0.05,
    filter_anomalies: bool = True,
):
    """Aggregate, fit, and write back once. Returns (report, warm_start)."""
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
        # Warm-start only when the model set is unchanged since the last refit.
        seed = (
            warm_start
            if warm_start is not None
            and warm_start.shape == (data.n_models + 1,)
            else None
        )
        log.debug("Fitting ratings: warm_start=%s", seed is not None)
        report = compute_ratings(data, ridge=ridge, warm_start=seed)
        write_started = time.perf_counter()
        written = write_ratings(conn, report)
        write_ms = (time.perf_counter() - write_started) * 1e3
        leader = report.models[0]
        log.info(
            "Rated %d models across %d component(s); "
            "leader %s %.0f (+/-%.0f); tie_param=%.3f converged=%s iters=%d "
            "(fetch_ms=%.1f write_ms=%.1f total_ms=%.1f)",
            written,
            len({m.component_id for m in report.models}),
            leader.display_name,
            leader.rating,
            leader.rating - leader.ci_lower,
            report.tie_param,
            report.converged,
            report.n_iter,
            fetch_ms,
            write_ms,
            (time.perf_counter() - started) * 1e3,
        )
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

    logger.info("Rating worker loop started; interval=%ss.", args.interval)
    while True:
        try:
            _, warm_start = run_once(
                database_url,
                ridge=args.ridge,
                warm_start=warm_start,
                with_style=args.style,
                style_ridge=args.style_ridge,
                filter_anomalies=filter_anomalies,
            )
        except Exception:  # keep the loop alive across transient errors
            # ``exception`` captures the full traceback, not just str(exc).
            logger.exception("Refit failed; retrying after interval.")
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
