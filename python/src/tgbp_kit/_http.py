"""The one place the API clients talk HTTP.

It sets the headers every request carries, sends the idempotency key, and owns
the retry rule: retry only a network error or a 5xx, and only when the call is
safe to repeat. A call that creates a record is safe to repeat only because it
resends the same idempotency key, so a retry returns the first record instead
of a second mint or redemption.
"""

from __future__ import annotations

import http.client
import json
import math
import random
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from ._version import __version__
from .errors import TgbpKitError


@dataclass(frozen=True)
class HttpRequest:
    method: str
    url: str
    # The headers carry the API key, so they stay out of reprs and error reporters' locals.
    headers: Mapping[str, str] = field(repr=False)
    body: bytes | None
    timeout: float


@dataclass(frozen=True)
class HttpResponse:
    status: int
    reason: str
    headers: Mapping[str, str]
    """Header names in lower case."""
    body: bytes


Transport = Callable[[HttpRequest], HttpResponse]
"""Sends one request. Raise OSError on a network failure; return any HTTP status as a response."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # A redirect would carry X-API-Key to wherever it points, so a 3xx is returned as is.
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def urllib_transport(req: HttpRequest) -> HttpResponse:
    """The default transport, on the standard library."""
    request = urllib.request.Request(req.url, data=req.body, headers=dict(req.headers), method=req.method)
    try:
        with _opener.open(request, timeout=req.timeout) as res:
            return HttpResponse(res.status, res.reason, _lower(res.headers.items()), res.read())
    except urllib.error.HTTPError as err:
        with err:
            return HttpResponse(err.code, err.reason, _lower(err.headers.items()), err.read())


def _lower(items: Any) -> dict[str, str]:
    return {name.lower(): value for name, value in items}


@dataclass(frozen=True)
class HttpConfig:
    api_key: str = field(repr=False)
    base_url: str
    transport: Transport = urllib_transport
    timeout: float = 30.0
    """Socket timeout in seconds, for the connect and for each read. A timeout counts as a network error."""
    max_retries: int = 3
    """Retries after the first attempt."""
    base_delay: float = 0.5
    """First backoff delay in seconds; each retry doubles it, with jitter."""

    def __post_init__(self) -> None:
        # Fails at construction, so a bad option never turns into an endless loop or an instant timeout.
        # A stray newline or space would fail inside http.client, whose error quotes the key.
        if not _API_KEY.fullmatch(self.api_key):
            raise ValueError("api_key must be non-empty printable ASCII with no spaces or newlines")
        if isinstance(self.max_retries, bool) or not (
            isinstance(self.max_retries, int) and self.max_retries >= 0
        ):
            raise ValueError(f"max_retries must be a non-negative integer: {self.max_retries}")
        if not (_finite(self.base_delay) and self.base_delay >= 0):
            raise ValueError(f"base_delay must be a finite number >= 0: {self.base_delay}")
        if not (_finite(self.timeout) and self.timeout > 0):
            raise ValueError(f"timeout must be a finite number > 0: {self.timeout}")


def _finite(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


_API_KEY = re.compile(r"[\x21-\x7e]+")
IDEMPOTENCY_KEY = re.compile(r"[A-Za-z0-9_-]{1,18}")
_KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"


def generate_idempotency_key() -> str:
    """A random 18-character key (108 bits).

    Store it with your order before you call, so a retry after a crash can reuse it.
    """
    return "".join(secrets.choice(_KEY_ALPHABET) for _ in range(18))


def assert_idempotency_key(key: str) -> None:
    if not IDEMPOTENCY_KEY.fullmatch(key):
        raise ValueError(f'Invalid idempotency key "{key}": use 1 to 18 letters, digits, "_" or "-"')


def normalise_base_url(base_url: str) -> str:
    """Refuses plain HTTP, which would send the API key in cleartext, except to this machine."""
    url = urllib.parse.urlsplit(base_url)
    local = url.hostname in ("localhost", "127.0.0.1", "::1")
    if url.scheme != "https" and not (url.scheme == "http" and local):
        raise ValueError(f"base_url must use https: {base_url}")
    if url.query or url.fragment or url.username is not None or url.password is not None:
        # Not echoed: it may carry credentials.
        raise ValueError("base_url must not carry a query, fragment or credentials")
    if not url.netloc:
        raise ValueError(f"base_url has no host: {base_url}")
    return base_url.rstrip("/")


def encode_json(value: Any) -> str:
    """JSON with every Decimal written as a number, digit for digit."""
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError(f"{value} is not a JSON number")
        return format(value, "f")
    if isinstance(value, float):
        raise TypeError(f"{value!r} is a float; pass a Decimal, a str or an int")
    if isinstance(value, (datetime, date)):
        return json.dumps(value.isoformat())
    if isinstance(value, Mapping):
        items = (f"{json.dumps(str(key))}:{encode_json(item)}" for key, item in value.items())
        return "{" + ",".join(items) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(encode_json(item) for item in value) + "]"
    if value is None or isinstance(value, (str, int, bool)):
        return json.dumps(value)
    raise TypeError(f"cannot send {type(value).__name__} as JSON")


def query_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, float):
        raise TypeError(f"{value!r} is a float; pass a Decimal, a str or an int")
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


@dataclass
class _Context:
    method: str
    path: str
    idempotency_key: str | None = None
    dedupe_key: tuple[str, str] | None = None
    """A key the API dedupes on that travels in the body, such as a swap intent's id."""


_NOT_JSON = object()


def request(
    config: HttpConfig,
    method: str,
    path: str,
    *,
    retry: bool,
    path_params: Mapping[str, str] | None = None,
    query: Mapping[str, Any] | None = None,
    body: Any = None,
    idempotency_key: str | None = None,
    dedupe_key: tuple[str, str] | None = None,
) -> tuple[int, Any]:
    """Sends a request and returns the status and the parsed JSON body of a 2xx.

    `retry` is True only when repeating the call cannot create or move anything twice.
    JSON numbers with a fraction parse as Decimal, never float.
    """
    max_retries = config.max_retries if retry else 0
    url = _build_url(config.base_url, path, path_params, query)
    headers = {
        "accept": "application/json",
        "user-agent": f"tgbp-kit-python/{__version__}",
        "x-api-key": config.api_key,
    }
    data = None
    if body is not None:
        headers["content-type"] = "application/json"
        data = encode_json(body).encode()
    if idempotency_key is not None:
        headers["idempotency-key"] = idempotency_key
    context = _Context(method, path, idempotency_key, dedupe_key)
    outgoing = HttpRequest(method, url, headers, data, config.timeout)

    attempt = 0
    while True:
        if attempt > 0:
            time.sleep(_backoff(config.base_delay, attempt))
        # A failure anywhere before the whole body arrives, timeout included, is a network error.
        try:
            response = config.transport(outgoing)
        except (OSError, http.client.HTTPException) as cause:
            if attempt < max_retries:
                attempt += 1
                continue
            raise TgbpKitError(
                "API_UNREACHABLE",
                f"{method} {path} got no response ({_describe(cause)}){_retry_hint(context)}",
                {
                    **_context_details(context),
                    "attempts": attempt + 1,
                    "mayHaveTakenEffect": method != "GET",
                },
            ) from cause
        if response.status >= 500 and attempt < max_retries:
            attempt += 1
            continue
        break

    attempts = attempt + 1
    text = response.body.decode("utf-8", errors="replace")
    parsed = _parse_json(text)
    # Keep a proxy's HTML or plain-text error, capped, so the caller can see what answered.
    error_body = text[:2000] if parsed is _NOT_JSON else parsed
    if not 200 <= response.status < 300:
        raise api_error(response, error_body, context, attempts)
    if parsed is _NOT_JSON:
        raise api_error(response, error_body, context, attempts, "the response was not JSON")
    # Every success the API documents carries a body, so an empty one is a broken answer.
    if parsed is None:
        raise api_error(response, None, context, attempts, "the response body was empty")
    return response.status, parsed


def _describe(cause: BaseException) -> str:
    """Names what went wrong without a response: a timeout, a reset, a DNS failure."""
    if isinstance(cause, urllib.error.URLError):
        cause = cause.reason if isinstance(cause.reason, BaseException) else cause
    if isinstance(cause, TimeoutError):
        return "timed out"
    return f"{type(cause).__name__}: {cause}"


def _build_url(
    base_url: str,
    path: str,
    path_params: Mapping[str, str] | None,
    query: Mapping[str, Any] | None,
) -> str:
    def substitute(match: re.Match[str]) -> str:
        name = match.group(1)
        value = (path_params or {}).get(name)
        if value is None:
            raise ValueError(f"Missing path parameter {name}")
        # These would resolve as dot segments and call a different endpoint.
        if value in ("", ".", ".."):
            raise ValueError(f'Invalid path parameter {name}: "{value}"')
        return urllib.parse.quote(value, safe="")

    url = base_url + re.sub(r"\{(\w+)\}", substitute, path)
    pairs: list[tuple[str, str]] = []
    for name, value in (query or {}).items():
        if value is None:
            continue
        for item in value if isinstance(value, (list, tuple)) else [value]:
            pairs.append((name, query_value(item)))
    return f"{url}?{urllib.parse.urlencode(pairs)}" if pairs else url


def _backoff(base_delay: float, attempt: int) -> float:
    """Exponential backoff with jitter: 0.5x to 1x of base * 2^(attempt - 1)."""
    return float(base_delay * 2 ** (attempt - 1) * (0.5 + random.random() / 2))


def _parse_json(text: str) -> Any:
    if text == "":
        return None
    try:
        return json.loads(text, parse_float=Decimal, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        return _NOT_JSON


def _reject_constant(name: str) -> Any:
    """NaN and Infinity are not JSON, and would parse as float."""
    raise ValueError(f"{name} is not a JSON number")


def _retry_key(context: _Context) -> tuple[str, str] | None:
    """The key a retry must resend: the idempotency key, or a dedupe key carried in the body."""
    if context.idempotency_key is not None:
        return ("idempotency key", context.idempotency_key)
    return context.dedupe_key


def _retry_hint(context: _Context) -> str:
    key = _retry_key(context)
    if key is not None:
        return f"; it may have taken effect, so retry only with the same {key[0]} ({key[1]})"
    return "" if context.method == "GET" else "; it may have taken effect, so read the record first"


def _context_details(context: _Context) -> dict[str, Any]:
    """The context as error details, with a dedupe key under its own name."""
    details: dict[str, Any] = {"method": context.method, "path": context.path}
    if context.idempotency_key is not None:
        details["idempotencyKey"] = context.idempotency_key
    if context.dedupe_key is not None:
        details[context.dedupe_key[0]] = context.dedupe_key[1]
    return details


def api_error(
    response: HttpResponse,
    body: Any,
    context: _Context,
    attempts: int,
    reason: str | None = None,
) -> TgbpKitError:
    error = body.get("error") if isinstance(body, dict) else None
    error = error if isinstance(error, dict) else {}
    details = error.get("details")
    details = details if isinstance(details, dict) else {}
    api_code = error.get("code") if isinstance(error.get("code"), str) else None
    request_id = details.get("request_id")
    if not isinstance(request_id, str):
        request_id = response.headers.get("x-request-id")
    message = reason or (error["message"] if isinstance(error.get("message"), str) else response.reason)
    ok = 200 <= response.status < 300
    # A 409 duplicate_request on a keyed create means an earlier request with that
    # key is still creating the record; resending under a new key would create a
    # second one. Other 409s, such as duplicate_active_mint, created nothing.
    keyed_409 = response.status == 409 and api_code == "duplicate_request" and _retry_key(context) is not None
    hint = _retry_hint(context) if ok or response.status >= 500 or keyed_409 else ""
    code = f" {api_code}" if api_code else ""
    return TgbpKitError(
        "API_ERROR",
        f"{context.method} {context.path} failed with {response.status}{code}: {message}{hint}",
        {
            **_context_details(context),
            "attempts": attempts,
            "status": response.status,
            "apiCode": api_code,
            "requestId": request_id,
            "contentType": response.headers.get("content-type"),
            "mayHaveTakenEffect": hint != "",
            "body": body,
        },
    )


def unexpected_body(
    method: str,
    path: str,
    status: int,
    body: Any,
    expected: str,
    *,
    idempotency_key: str | None = None,
    dedupe_key: tuple[str, str] | None = None,
) -> TgbpKitError:
    """A 2xx without the body it promised. A write may still have taken effect."""
    context = _Context(method, path, idempotency_key, dedupe_key)
    hint = _retry_hint(context)
    return TgbpKitError(
        "API_ERROR",
        f"{method} {path} returned {status} without {expected}{hint}",
        {**_context_details(context), "status": status, "mayHaveTakenEffect": hint != "", "body": body},
    )


def incomplete_create(path: str, status: int, body: Any, idempotency_key: str, missing: str) -> TgbpKitError:
    """A create answered 2xx without the record it promised; the error carries the key to retry with."""
    return unexpected_body("POST", path, status, body, missing, idempotency_key=idempotency_key)
