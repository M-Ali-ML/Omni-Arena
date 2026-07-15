"""Logging configuration for the rating worker.

A single :func:`configure_logging` entrypoint plus a :func:`get_logger` helper.
The level and output format are controlled by environment variables so operators
can switch between human-readable text (local/dev) and structured JSON (for a
production log aggregator) without any code change:

    LOG_LEVEL   DEBUG | INFO | WARNING | ERROR   (default INFO)
    LOG_FORMAT  text | json                      (default text)

Structured context (e.g. a per-refit ``run_id`` and timings) is attached via the
standard ``extra=`` argument -- or a :class:`logging.LoggerAdapter` -- and
surfaces in both formats.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone

_PACKAGE_LOGGER = "omniarena_rating"
_configured = False

# Standard ``LogRecord`` attributes; anything else on a record is treated as a
# structured "extra" field and rendered by the formatters below.
_RESERVED = set(vars(logging.makeLogRecord({}))) | {"message", "asctime", "taskName"}


def _extra_fields(record: logging.LogRecord) -> dict:
    return {
        key: value
        for key, value in record.__dict__.items()
        if key not in _RESERVED and not key.startswith("_")
    }


class _JsonFormatter(logging.Formatter):
    """One JSON object per line: timestamp, level, logger, message, extras."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(
                record.created, tz=timezone.utc
            ).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        payload.update(_extra_fields(record))
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class _TextFormatter(logging.Formatter):
    """Human-readable single line with any structured fields appended."""

    def __init__(self) -> None:
        super().__init__(
            "%(asctime)s %(levelname)-7s %(name)s: %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S%z",
        )

    def format(self, record: logging.LogRecord) -> str:
        base = super().format(record)
        fields = _extra_fields(record)
        if fields:
            suffix = " ".join(f"{k}={v}" for k, v in fields.items())
            base = f"{base} [{suffix}]"
        return base


def configure_logging(level: str | None = None, fmt: str | None = None) -> None:
    """Idempotently configure the package logger from args or the environment.

    Safe to call more than once; the handler is replaced each time so repeated
    calls (e.g. in tests) never double-log.
    """
    global _configured
    level_name = (level or os.environ.get("LOG_LEVEL", "INFO")).upper()
    fmt_name = (fmt or os.environ.get("LOG_FORMAT", "text")).lower()

    logger = logging.getLogger(_PACKAGE_LOGGER)
    logger.setLevel(getattr(logging, level_name, logging.INFO))
    logger.propagate = False

    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        _JsonFormatter() if fmt_name == "json" else _TextFormatter()
    )
    logger.handlers = [handler]
    _configured = True


def get_logger(name: str) -> logging.Logger:
    """Return a logger under the package namespace, configuring on first use."""
    if not _configured:
        configure_logging()
    return logging.getLogger(name)
