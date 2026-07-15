"""Tests for the logging configuration and formatters."""

from __future__ import annotations

import json
import logging

import pytest

from omniarena_rating.logging_setup import (
    _JsonFormatter,
    _TextFormatter,
    configure_logging,
    get_logger,
)


def _record(msg: str = "hi %s", args=("world",), exc_info=None) -> logging.LogRecord:
    return logging.LogRecord(
        name="omniarena_rating.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=10,
        msg=msg,
        args=args,
        exc_info=exc_info,
    )


@pytest.fixture(autouse=True)
def _restore_logging():
    """Reset the package logger to a known state after each test."""
    yield
    configure_logging(level="INFO", fmt="text")


def test_text_formatter_renders_message_and_extra_fields():
    record = _record()
    record.run_id = "abc123"
    out = _TextFormatter().format(record)

    assert "hi world" in out
    assert "INFO" in out
    assert "omniarena_rating.test" in out
    assert "run_id=abc123" in out


def test_text_formatter_without_extras_has_no_bracket_suffix():
    out = _TextFormatter().format(_record())
    assert out.endswith("hi world")


def test_json_formatter_emits_structured_object_with_extras():
    record = _record()
    record.run_id = "abc123"
    payload = json.loads(_JsonFormatter().format(record))

    assert payload["msg"] == "hi world"
    assert payload["level"] == "INFO"
    assert payload["logger"] == "omniarena_rating.test"
    assert payload["run_id"] == "abc123"
    assert "ts" in payload


def test_json_formatter_includes_exception():
    try:
        raise ValueError("kaboom")
    except ValueError:
        import sys

        record = _record(msg="failed", args=(), exc_info=sys.exc_info())
    payload = json.loads(_JsonFormatter().format(record))

    assert payload["msg"] == "failed"
    assert "kaboom" in payload["exc"]
    assert "Traceback" in payload["exc"]


def test_configure_logging_sets_level_and_json_formatter():
    configure_logging(level="DEBUG", fmt="json")
    logger = logging.getLogger("omniarena_rating")

    assert logger.level == logging.DEBUG
    assert logger.propagate is False
    assert len(logger.handlers) == 1
    assert isinstance(logger.handlers[0].formatter, _JsonFormatter)


def test_configure_logging_is_idempotent_single_handler():
    configure_logging(level="INFO", fmt="text")
    configure_logging(level="INFO", fmt="text")
    logger = logging.getLogger("omniarena_rating")

    assert len(logger.handlers) == 1
    assert isinstance(logger.handlers[0].formatter, _TextFormatter)


def test_get_logger_returns_namespaced_child():
    logger = get_logger("omniarena_rating.child")
    assert logger.name == "omniarena_rating.child"
