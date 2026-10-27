"""The default transport, against a local HTTP server."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from tgbp_kit import TgbpClient, TgbpKitError

from .conftest import fixture


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/api/v1/mints/moved":
            self.send_response(302)
            self.send_header("location", "http://127.0.0.1:1/steal")
            self.end_headers()
            return
        status, body = (
            (200, {"data": fixture("mint")})
            if self.path == "/api/v1/mints/mint_1" and self.headers["x-api-key"] == "k"
            else (404, {"error": {"code": "not_found", "message": "no mint"}})
        )
        raw = json.dumps(body, default=str).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("x-request-id", "req_1")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args: object) -> None:
        pass


@pytest.fixture
def local_client() -> Iterator[TgbpClient]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield TgbpClient(api_key="k", base_url=f"http://127.0.0.1:{server.server_address[1]}", timeout=5)
    finally:
        server.shutdown()
        server.server_close()


def test_reads_a_record(local_client: TgbpClient) -> None:
    assert local_client.mints.get("mint_1").data.id == "mint_1"


def test_returns_an_error_status_as_an_api_error(local_client: TgbpClient) -> None:
    with pytest.raises(TgbpKitError) as caught:
        local_client.mints.get("other")
    assert caught.value.details["status"] == 404
    assert caught.value.details["apiCode"] == "not_found"
    assert caught.value.details["requestId"] == "req_1"


def test_never_follows_a_redirect(local_client: TgbpClient) -> None:
    with pytest.raises(TgbpKitError) as caught:
        local_client.mints.get("moved")
    assert caught.value.details["status"] == 302


def test_a_refused_connection_is_unreachable() -> None:
    client = TgbpClient(api_key="k", base_url="http://127.0.0.1:1", max_retries=0, timeout=2)
    with pytest.raises(TgbpKitError) as caught:
        client.mints.get("mint_1")
    assert caught.value.code == "API_UNREACHABLE"
