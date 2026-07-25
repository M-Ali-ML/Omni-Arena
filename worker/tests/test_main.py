"""Tests for the worker entrypoint: run_once orchestration and main().

The database and the numeric fit are stubbed out, so these exercise only the
plumbing -- skip conditions, the warm-start reuse guard, the cold/warm cadence of
the loop, connection lifecycle, argument/env handling, and error handling.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import numpy as np
import pytest

import omniarena_rating.__main__ as m
from omniarena_rating.aggregate import AggregatedData
from omniarena_rating.report import ModelRating, RatingReport


class FakeConn:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class StopLoop(Exception):
    """Sentinel to break the otherwise-infinite worker loop in tests."""


def _data(n_models: int, n_pairs: int) -> AggregatedData:
    return AggregatedData(
        model_ids=[f"m{i}" for i in range(n_models)],
        display_names=[f"N{i}" for i in range(n_models)],
        pairs=[None] * n_pairs,  # only truthiness/len matters; fit is stubbed
        games=[0] * n_models,
    )


def _report(n_models: int = 2) -> RatingReport:
    models = [
        ModelRating(
            f"m{i}", f"N{i}", 1000.0 - 100 * i, 10.0,
            990.0 - 100 * i, 1010.0 - 100 * i, 0, 10,
        )
        for i in range(n_models)
    ]
    report = RatingReport(models=models, tie_param=0.2, converged=True, n_iter=3)
    report.warm_state = np.zeros(n_models + 1)
    return report


@pytest.fixture
def wired(monkeypatch):
    """Stub _connect/fetch/compute/write; return handles for assertions."""
    conn = FakeConn()
    state: dict = {"conn": conn, "compute_calls": [], "compute_return": None}

    monkeypatch.setattr(m, "_connect", lambda url: conn)

    def fake_compute(data, *, ridge, warm_start=None):
        state["compute_calls"].append({"ridge": ridge, "warm_start": warm_start})
        return state["compute_return"]

    monkeypatch.setattr(m, "compute_ratings", fake_compute)
    monkeypatch.setattr(m, "write_ratings", lambda conn, report: len(report.models))
    return state


def _fetch(data: AggregatedData):
    """A stub matching the fetch_aggregated_data(conn, excluded_sessions=...) API."""
    return lambda conn, excluded_sessions=None: data


def _shadow_fit(raw_params: np.ndarray):
    """A stub fit_bradley_terry for the cold pass's warm-start cross-check."""
    return lambda *args, **kwargs: SimpleNamespace(raw_params=raw_params)


class _Collector(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


@pytest.fixture
def records():
    """Collect records on the package logger (it does not propagate to root)."""
    package = logging.getLogger("omniarena_rating")
    handler = _Collector()
    previous_level = package.level
    package.addHandler(handler)
    package.setLevel(logging.DEBUG)
    try:
        yield handler.records
    finally:
        package.removeHandler(handler)
        package.setLevel(previous_level)


def _loop_calls(monkeypatch, argv: list[str], iterations: int) -> list[dict]:
    """Run main() in loop mode for a bounded number of refits.

    ``run_once`` is faked to hand back a fresh warm state each time, and the
    loop's ``time.sleep`` doubles as the iteration counter -- raising once the
    requested number of refits has been observed.
    """
    monkeypatch.setenv("DATABASE_URL", "postgres://x")
    calls: list[dict] = []
    warm_state = np.zeros(3)

    def fake_run_once(url, **kw):
        calls.append(kw)
        return _report(2), warm_state

    monkeypatch.setattr(m, "run_once", fake_run_once)

    def stop(_interval):
        if len(calls) >= iterations:
            raise StopLoop

    monkeypatch.setattr(m.time, "sleep", stop)

    with pytest.raises(StopLoop):
        m.main(["--loop", *argv])
    return calls


def test_run_once_no_models_skips_fit_and_closes(wired, monkeypatch):
    monkeypatch.setattr(m, "fetch_aggregated_data", _fetch(_data(0, 0)))

    report, warm = m.run_once(
        "postgres://x", ridge=0.01, warm_start="prev", filter_anomalies=False
    )

    assert report is None
    assert warm == "prev"  # unchanged warm-start passed straight through
    assert not wired["compute_calls"]  # fit never attempted
    assert wired["conn"].closed


def test_run_once_no_pairs_skips_fit_and_closes(wired, monkeypatch):
    monkeypatch.setattr(m, "fetch_aggregated_data", _fetch(_data(3, 0)))

    report, warm = m.run_once(
        "postgres://x", ridge=0.01, warm_start=None, filter_anomalies=False
    )

    assert report is None
    assert warm is None
    assert not wired["compute_calls"]
    assert wired["conn"].closed


def test_run_once_success_returns_report_and_warm_state(wired, monkeypatch):
    monkeypatch.setattr(m, "fetch_aggregated_data", _fetch(_data(2, 1)))
    wired["compute_return"] = _report(2)

    report, warm = m.run_once("postgres://x", ridge=0.02, filter_anomalies=False)

    assert report is wired["compute_return"]
    assert warm is report.warm_state
    assert wired["conn"].closed
    assert wired["compute_calls"][0]["ridge"] == 0.02


def test_run_once_reuses_warm_start_when_shape_matches(wired, monkeypatch):
    monkeypatch.setattr(m, "fetch_aggregated_data", _fetch(_data(2, 1)))
    wired["compute_return"] = _report(2)
    seed = np.zeros(3)  # n_models + 1

    m.run_once(
        "postgres://x", ridge=0.01, warm_start=seed, filter_anomalies=False
    )

    assert wired["compute_calls"][0]["warm_start"] is seed


def test_run_once_ignores_warm_start_on_shape_mismatch(wired, monkeypatch):
    monkeypatch.setattr(m, "fetch_aggregated_data", _fetch(_data(2, 1)))
    wired["compute_return"] = _report(2)

    m.run_once(
        "postgres://x", ridge=0.01, warm_start=np.zeros(5), filter_anomalies=False
    )

    assert wired["compute_calls"][0]["warm_start"] is None


def test_run_once_force_cold_discards_usable_warm_start(wired, monkeypatch):
    monkeypatch.setattr(m, "fetch_aggregated_data", _fetch(_data(2, 1)))
    monkeypatch.setattr(m, "fit_bradley_terry", _shadow_fit(np.zeros(3)))
    wired["compute_return"] = _report(2)

    m.run_once(
        "postgres://x",
        ridge=0.01,
        warm_start=np.zeros(3),  # shape matches, so only force_cold drops it
        filter_anomalies=False,
        force_cold=True,
    )

    assert wired["compute_calls"][0]["warm_start"] is None


def test_run_once_force_cold_reports_full_mode(wired, monkeypatch, records):
    monkeypatch.setattr(m, "fetch_aggregated_data", _fetch(_data(2, 1)))
    wired["compute_return"] = _report(2)

    m.run_once("postgres://x", ridge=0.01, filter_anomalies=False, force_cold=True)
    m.run_once(
        "postgres://x",
        ridge=0.01,
        warm_start=np.zeros(3),
        filter_anomalies=False,
    )

    summaries = [
        r.getMessage() for r in records if r.getMessage().startswith("Rated")
    ]
    assert "mode=full" in summaries[0]
    assert "mode=incremental" in summaries[1]


def test_run_once_force_cold_warns_when_warm_path_diverges(
    wired, monkeypatch, records
):
    monkeypatch.setattr(m, "fetch_aggregated_data", _fetch(_data(2, 1)))
    wired["compute_return"] = _report(2)  # cold solution is the zero vector
    # 0.05 log-odds is ~8.7 display points, ~0.9 of the fake 10-point stderr.
    monkeypatch.setattr(
        m, "fit_bradley_terry", _shadow_fit(np.array([0.05, 0.0, 0.2]))
    )

    m.run_once(
        "postgres://x",
        ridge=0.01,
        warm_start=np.zeros(3),
        filter_anomalies=False,
        force_cold=True,
    )

    warnings = [r.getMessage() for r in records if r.levelno == logging.WARNING]
    assert any("diverges from the ground-truth fit" in w for w in warnings)


def test_run_once_force_cold_quiet_when_warm_path_agrees(
    wired, monkeypatch, records
):
    monkeypatch.setattr(m, "fetch_aggregated_data", _fetch(_data(2, 1)))
    wired["compute_return"] = _report(2)
    monkeypatch.setattr(
        m, "fit_bradley_terry", _shadow_fit(np.array([1e-6, -1e-6, 0.2]))
    )

    m.run_once(
        "postgres://x",
        ridge=0.01,
        warm_start=np.zeros(3),
        filter_anomalies=False,
        force_cold=True,
    )

    assert not [r for r in records if r.levelno >= logging.WARNING]


def test_run_once_cross_check_ignores_degenerate_stderrs(
    wired, monkeypatch, records
):
    report = _report(2)
    for model in report.models:
        model.rating_stderr = 0.0  # already flagged as untrustworthy upstream
    monkeypatch.setattr(m, "fetch_aggregated_data", _fetch(_data(2, 1)))
    wired["compute_return"] = report
    monkeypatch.setattr(
        m, "fit_bradley_terry", _shadow_fit(np.array([5.0, -5.0, 0.2]))
    )

    m.run_once(
        "postgres://x",
        ridge=0.01,
        warm_start=np.zeros(3),
        filter_anomalies=False,
        force_cold=True,
    )

    assert not [r for r in records if r.levelno >= logging.WARNING]


def test_run_once_skips_cross_check_without_prior_warm_state(wired, monkeypatch):
    monkeypatch.setattr(m, "fetch_aggregated_data", _fetch(_data(2, 1)))
    wired["compute_return"] = _report(2)
    shadow_fits: list[tuple] = []
    stub = _shadow_fit(np.zeros(3))
    monkeypatch.setattr(
        m,
        "fit_bradley_terry",
        lambda *args, **kwargs: shadow_fits.append(args) or stub(),
    )

    m.run_once(
        "postgres://x", ridge=0.01, filter_anomalies=False, force_cold=True
    )

    assert not shadow_fits  # nothing to cross-check against on a first fit


def test_main_missing_database_url_returns_1(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)

    def boom(*a, **k):
        raise AssertionError("run_once must not be called without DATABASE_URL")

    monkeypatch.setattr(m, "run_once", boom)
    assert m.main([]) == 1


def test_main_one_shot_invokes_run_once_with_defaults(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://x")
    monkeypatch.delenv("RATING_RIDGE", raising=False)
    calls = []
    monkeypatch.setattr(
        m, "run_once", lambda url, **kw: calls.append((url, kw)) or (None, None)
    )

    assert m.main([]) == 0
    assert len(calls) == 1
    url, kw = calls[0]
    assert url == "postgres://x"
    assert kw["ridge"] == 0.01
    assert kw["warm_start"] is None


def test_main_reads_ridge_from_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://x")
    monkeypatch.setenv("RATING_RIDGE", "0.5")
    calls = []
    monkeypatch.setattr(
        m, "run_once", lambda url, **kw: calls.append(kw) or (None, None)
    )

    m.main([])
    assert calls[0]["ridge"] == 0.5


def test_main_loop_alternates_cold_and_warm_refits(monkeypatch):
    calls = _loop_calls(monkeypatch, ["--full-refit-every", "3"], iterations=7)

    # The opening refit is already cold (no warm state), so the forced passes
    # land three refits later -- not on refit 3, which would be one early.
    assert [c["force_cold"] for c in calls] == [
        False, False, False, True, False, False, True,
    ]
    assert calls[0]["warm_start"] is None
    assert all(c["warm_start"] is not None for c in calls[1:])


def test_main_loop_default_forces_cold_every_twelfth_refit(monkeypatch):
    monkeypatch.delenv("FULL_REFIT_EVERY", raising=False)

    calls = _loop_calls(monkeypatch, [], iterations=13)

    forced = [i for i, c in enumerate(calls) if c["force_cold"]]
    assert forced == [12]  # cold at refits 1 and 13 with the default of 12


def test_main_loop_full_refit_every_one_is_always_cold(monkeypatch):
    monkeypatch.setenv("FULL_REFIT_EVERY", "1")

    calls = _loop_calls(monkeypatch, [], iterations=3)

    # The first is cold for lack of warm state; every later one is forced.
    assert [c["force_cold"] for c in calls] == [False, True, True]


def test_main_loop_zero_disables_forced_cold_refits(monkeypatch):
    calls = _loop_calls(monkeypatch, ["--full-refit-every", "0"], iterations=5)

    assert not any(c["force_cold"] for c in calls)


def test_main_loop_skipped_refits_do_not_advance_the_cadence(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://x")
    calls: list[dict] = []

    # No report means nothing was fit (no models / no comparisons yet).
    def skipped_run(url, **kw):
        calls.append(kw)
        return None, None

    monkeypatch.setattr(m, "run_once", skipped_run)

    def stop(_interval):
        if len(calls) >= 4:
            raise StopLoop

    monkeypatch.setattr(m.time, "sleep", stop)

    with pytest.raises(StopLoop):
        m.main(["--loop", "--full-refit-every", "1"])

    assert not any(c["force_cold"] for c in calls)


def test_main_loop_logs_full_traceback_and_keeps_running(monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgres://x")

    def failing_run(*a, **k):
        raise RuntimeError("boom-transient")

    monkeypatch.setattr(m, "run_once", failing_run)

    def stop(_interval):
        raise StopLoop

    monkeypatch.setattr(m.time, "sleep", stop)

    with pytest.raises(StopLoop):
        m.main(["--loop"])

    err = capsys.readouterr().err
    assert "Refit failed" in err
    assert "boom-transient" in err
    assert "Traceback" in err  # logger.exception recorded the stack
