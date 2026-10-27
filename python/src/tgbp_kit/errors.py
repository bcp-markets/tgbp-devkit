"""The one exception the API clients raise for a failed call."""

from __future__ import annotations

from typing import Any, Literal

TgbpErrorCode = Literal["API_ERROR", "API_UNREACHABLE"]
"""
`API_ERROR`: the tGBP API answered with an error. `details` carries `status`,
the API's own `apiCode` and `requestId` (quote it to support), and
`idempotencyKey` on a call that creates a record. After a 5xx the call may
have taken effect: retry only with that same key.

`API_UNREACHABLE`: the tGBP API gave no response, after every retry. The call
may still have taken effect: retry only with `details["idempotencyKey"]`, or
read the record before sending anything new.
"""


class TgbpKitError(Exception):
    def __init__(self, code: TgbpErrorCode, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code: TgbpErrorCode = code
        self.message = message
        self.details: dict[str, Any] = details or {}
