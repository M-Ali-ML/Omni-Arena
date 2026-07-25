"""Tests for the idempotent rating upsert (no live database required)."""

from __future__ import annotations

from omniarena_rating.report import ModelRating, RatingReport
from omniarena_rating.writeback import (
    HISTORY_INSERT_SQL,
    UPSERT_SQL,
    write_ratings,
)


class FakeCursor:
    def __init__(self) -> None:
        self.executemany_calls: list[tuple[str, list[tuple]]] = []

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *exc) -> bool:
        return False

    def executemany(self, sql: str, rows) -> None:
        self.executemany_calls.append((sql, [tuple(r) for r in rows]))


class FakeConn:
    def __init__(self, cursor: FakeCursor) -> None:
        self._cursor = cursor
        self.commits = 0

    def cursor(self) -> FakeCursor:
        return self._cursor

    def commit(self) -> None:
        self.commits += 1


def _report(models: list[ModelRating]) -> RatingReport:
    return RatingReport(models=models, tie_param=0.2, converged=True, n_iter=5)


def test_write_ratings_maps_columns_in_declared_order():
    cursor = FakeCursor()
    conn = FakeConn(cursor)
    report = _report(
        [
            ModelRating("m1", "One", 1200.0, 10.0, 1180.0, 1220.0, 0, 50),
            ModelRating("m2", "Two", 900.0, 12.0, 876.0, 924.0, 1, 30),
        ]
    )

    written = write_ratings(conn, report)

    assert written == 2
    assert len(cursor.executemany_calls) == 2
    sql, rows = cursor.executemany_calls[0]
    assert sql == UPSERT_SQL
    # Row tuple order must match the INSERT column list exactly:
    # (model_id, rating, rating_stderr, ci_lower, ci_upper, component_id, games)
    assert rows[0] == ("m1", 1200.0, 10.0, 1180.0, 1220.0, 0, 50)
    assert rows[1] == ("m2", 900.0, 12.0, 876.0, 924.0, 1, 30)
    assert conn.commits == 1


def test_write_ratings_appends_history_snapshot_in_same_transaction():
    cursor = FakeCursor()
    conn = FakeConn(cursor)
    report = _report(
        [ModelRating("m1", "One", 1200.0, 10.0, 1180.0, 1220.0, 0, 50)]
    )

    write_ratings(conn, report)

    history_sql, history_rows = cursor.executemany_calls[1]
    assert history_sql == HISTORY_INSERT_SQL
    # Same tuples feed the history insert, so the snapshot mirrors the upsert.
    assert history_rows == cursor.executemany_calls[0][1]
    # Both statements run before the single commit (one transaction).
    assert conn.commits == 1


def test_write_ratings_commits_exactly_once():
    cursor = FakeCursor()
    conn = FakeConn(cursor)
    report = _report(
        [ModelRating("m1", "One", 1000.0, 5.0, 990.0, 1010.0, 0, 10)]
    )

    write_ratings(conn, report)

    assert conn.commits == 1


def test_write_ratings_empty_report_writes_no_rows_but_commits():
    cursor = FakeCursor()
    conn = FakeConn(cursor)

    written = write_ratings(conn, _report([]))

    assert written == 0
    assert cursor.executemany_calls[0][1] == []
    assert conn.commits == 1
