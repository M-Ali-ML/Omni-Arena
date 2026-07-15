"""Tests for pre-fit voting-session anomaly detection."""

from __future__ import annotations

from omniarena_rating.anomaly import (
    AnomalyConfig,
    SessionStats,
    detect_anomalous_sessions,
)


def _normal_population(count: int) -> list[SessionStats]:
    """A crowd of ordinary sessions: modest volume, balanced sides."""
    sessions = []
    for k in range(count):
        left = 4 + (k % 3)
        right = 5 - (k % 3)
        sessions.append(
            SessionStats(
                session_id=f"normal_{k}",
                left=left,
                right=right,
                ties=1,
                skips=1,
            )
        )
    return sessions


def test_extreme_volume_is_flagged():
    sessions = _normal_population(40)
    spammer = SessionStats(
        session_id="spammer", left=250, right=240, ties=10, skips=0
    )
    report = detect_anomalous_sessions(sessions + [spammer])

    assert "spammer" in report.flagged_sessions
    assert any("volume" in r for r in report.reasons_for("spammer"))
    # Ordinary sessions are left alone.
    assert report.flagged_sessions == {"spammer"}


def test_degenerate_position_bias_is_flagged():
    sessions = _normal_population(40)
    always_left = SessionStats(
        session_id="always_left", left=60, right=0, ties=0, skips=0
    )
    report = detect_anomalous_sessions(sessions + [always_left])

    assert "always_left" in report.flagged_sessions
    reasons = report.reasons_for("always_left")
    assert any("position" in r for r in reasons)


def test_balanced_high_volume_only_flags_on_volume_not_position():
    # A heavy but perfectly balanced voter: volume trips, position does not.
    sessions = _normal_population(40)
    heavy = SessionStats(
        session_id="heavy", left=200, right=200, ties=0, skips=0
    )
    report = detect_anomalous_sessions(sessions + [heavy])
    reasons = report.reasons_for("heavy")
    assert any("volume" in r for r in reasons)
    assert not any("position" in r for r in reasons)


def test_fast_repeated_voting_is_flagged():
    sessions = _normal_population(20)
    # Ten votes spaced 0.2s apart -> clearly automated.
    stamps = tuple(1000.0 + 0.2 * i for i in range(10))
    bot = SessionStats(
        session_id="bot", left=5, right=5, ties=0, skips=0, timestamps=stamps
    )
    report = detect_anomalous_sessions(sessions + [bot])
    assert "bot" in report.flagged_sessions
    assert any("speed" in r for r in report.reasons_for("bot"))


def test_slow_human_pace_is_not_flagged_on_speed():
    sessions = _normal_population(20)
    stamps = tuple(1000.0 + 30.0 * i for i in range(10))  # 30s apart
    human = SessionStats(
        session_id="human", left=5, right=5, ties=0, skips=0, timestamps=stamps
    )
    report = detect_anomalous_sessions(sessions + [human])
    assert "human" not in report.flagged_sessions


def test_small_sessions_below_minimums_are_ignored():
    # A tiny always-left session lacks the sample size to reject any null.
    sessions = _normal_population(30)
    tiny = SessionStats(session_id="tiny", left=3, right=0, ties=0, skips=0)
    report = detect_anomalous_sessions(sessions + [tiny])
    assert "tiny" not in report.flagged_sessions


def test_empty_input_returns_empty_report():
    report = detect_anomalous_sessions([])
    assert report.flagged_sessions == set()
    assert report.verdicts == []


def test_config_thresholds_are_respected():
    sessions = _normal_population(30)
    borderline = SessionStats(
        session_id="borderline", left=20, right=5, ties=0, skips=0
    )
    strict = detect_anomalous_sessions(
        sessions + [borderline],
        config=AnomalyConfig(alpha=1e-1, min_decisive_for_position=10),
    )
    lenient = detect_anomalous_sessions(
        sessions + [borderline],
        config=AnomalyConfig(alpha=1e-9, min_decisive_for_position=10),
    )
    assert "borderline" in strict.flagged_sessions
    assert "borderline" not in lenient.flagged_sessions
