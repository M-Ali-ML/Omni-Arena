"""Runnable entrypoint for the rating worker.

Reads ``DATABASE_URL``, aggregates votes in-database, fits Bradley-Terry
ratings with Fisher-information CIs, and writes them back. Supports a one-shot
run (default) and a periodic loop (``--loop``) with warm-started refits.

Usage::

    python -m omniarena_rating              # one-shot
    python -m omniarena_rating --loop       # periodic (REFIT_INTERVAL_SECONDS)
    python -m omniarena_rating --interval 60 --loop
"""

from __future__ import annotations

import argparse
import os
import sys
import time

from .aggregate import fetch_aggregated_data
from .report import compute_ratings
from .writeback import write_ratings


def _connect(database_url: str):
    try:
        import psycopg
    except ImportError as exc:  # pragma: no cover - import guard
        raise SystemExit(
            "psycopg is required to run the worker; install requirements.txt"
        ) from exc
    return psycopg.connect(database_url)


def run_once(
    database_url: str,
    *,
    ridge: float,
    warm_start=None,
):
    """Aggregate, fit, and write back once. Returns (report, warm_start)."""
    conn = _connect(database_url)
    try:
        data = fetch_aggregated_data(conn)
        if data.n_models == 0:
            print("No enabled models; nothing to rate.", file=sys.stderr)
            return None, warm_start
        if not data.pairs:
            print("No comparisons yet; skipping fit.", file=sys.stderr)
            return None, warm_start
        # Warm-start only when the model set is unchanged since the last refit.
        seed = (
            warm_start
            if warm_start is not None
            and warm_start.shape == (data.n_models + 1,)
            else None
        )
        report = compute_ratings(data, ridge=ridge, warm_start=seed)
        written = write_ratings(conn, report)
        leader = report.models[0]
        print(
            f"Rated {written} models across "
            f"{len({m.component_id for m in report.models})} component(s); "
            f"leader {leader.display_name} "
            f"{leader.rating:.0f} (+/-{leader.rating - leader.ci_lower:.0f}); "
            f"tie_param={report.tie_param:.3f}, "
            f"converged={report.converged}, iters={report.n_iter}."
        )
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
    args = parser.parse_args(argv)

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is not set.", file=sys.stderr)
        return 1

    warm_start = None
    if not args.loop:
        run_once(database_url, ridge=args.ridge, warm_start=warm_start)
        return 0

    print(f"Rating worker loop started; interval={args.interval}s.")
    while True:
        try:
            _, warm_start = run_once(
                database_url, ridge=args.ridge, warm_start=warm_start
            )
        except Exception as exc:  # keep the loop alive across transient errors
            print(f"Refit failed: {exc}", file=sys.stderr)
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
