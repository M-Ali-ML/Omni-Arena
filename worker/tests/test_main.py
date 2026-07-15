"""Tests for the worker entrypoint: run_once orchestration and main().

The database and the numeric fit are stubbed out, so these exercise only the
plumbing -- skip conditions, the warm-start reuse guard, connection lifecycle,
argument/env handling, and the loop's error handling.
"""

from __future__ import annotations

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
