from __future__ import annotations

import copy
import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from tgbp_kit import HttpRequest, HttpResponse, TgbpClient, TgbpSwapClient
from tgbp_kit._http import encode_json

FIXTURES: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "responses.json").read_text(), parse_float=Decimal
)


@dataclass
class Call:
    method: str
    url: str
    headers: dict[str, str]
    body: Any

    @property
    def path(self) -> str:
        return urlsplit(self.url).path

    @property
    def query(self) -> dict[str, list[str]]:
        return parse_qs(urlsplit(self.url).query)


Reply = HttpResponse | BaseException


@dataclass
class FakeTransport:
    """Records each call and answers from `replies` in order."""

    replies: list[Reply] = field(default_factory=list)
    calls: list[Call] = field(default_factory=list)

    def __call__(self, req: HttpRequest) -> HttpResponse:
        body = None if req.body is None else json.loads(req.body, parse_float=Decimal)
        self.calls.append(Call(req.method, req.url, dict(req.headers), body))
        if not self.replies:
            raise AssertionError("FakeTransport: no reply left")
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return reply


def reply(status: int, body: Any = None, headers: dict[str, str] | None = None) -> HttpResponse:
    raw = body if isinstance(body, bytes) else b"" if body is None else encode_json(body).encode()
    return HttpResponse(status, "Reason", {"content-type": "application/json", **(headers or {})}, raw)


def fixture(name: str) -> Any:
    return copy.deepcopy(FIXTURES[name])


@pytest.fixture
def transport() -> Iterator[FakeTransport]:
    yield FakeTransport()


@pytest.fixture
def client(transport: FakeTransport) -> TgbpClient:
    return TgbpClient(api_key="tgbp_sandbox_test", environment="sandbox", transport=transport, base_delay=0)


@pytest.fixture
def swap(transport: FakeTransport) -> TgbpSwapClient:
    return TgbpSwapClient(api_key="tgbp_sandbox_test", transport=transport, base_delay=0)
