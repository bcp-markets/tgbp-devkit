"""Creates a mint on sandbox.tgbp.io with a staging API key.

Runs only when TGBP_SANDBOX_API_KEY is set, unless TGBP_REQUIRE_SANDBOX=1 makes
missing config a failure (CI's sandbox job sets it). The other variables name
records the key's account already owns, on a testnet:

    TGBP_SANDBOX_CUSTOMER_ID     a verified customer
    TGBP_SANDBOX_ADDRESS         an approved recipient address for that customer
    TGBP_SANDBOX_CHAIN           optional, default sepolia

The test creates a mint, replays it with the same key, then cancels it. The
TypeScript sandbox test already drives a mint through the simulated pay-in.

CI logs here are public and the sandbox's errors can name a banking provider,
so a failure raises only text this repo wrote: the method, path, status and
an id-shaped request id. It drops the API's code and message, and the cause.
"""

from __future__ import annotations

import os
import random
import re
from decimal import Decimal

import pytest

from tgbp_kit import Created, TgbpClient, TgbpKitError

REQUIRED_VARS = ["TGBP_SANDBOX_API_KEY", "TGBP_SANDBOX_CUSTOMER_ID", "TGBP_SANDBOX_ADDRESS"]
missing = [name for name in REQUIRED_VARS if not os.environ.get(name)]
required = os.environ.get("TGBP_REQUIRE_SANDBOX") == "1"

REDACTED = "[API error text redacted from the public CI log]"
REQUEST_ID = re.compile(r"[\w-]{1,64}")


def redacted(error: BaseException) -> AssertionError:
    if isinstance(error, TgbpKitError):
        d = error.details
        call = f" on {d['method']} {d['path']}" if "method" in d and "path" in d else ""
        status = f" with {d['status']}" if isinstance(d.get("status"), int) else ""
        rid = d.get("requestId")
        request = f" (request id {rid})" if isinstance(rid, str) and REQUEST_ID.fullmatch(rid) else ""
        return AssertionError(f"TgbpKitError {error.code}{call}{status}: {REDACTED}{request}")
    return AssertionError(f"{type(error).__name__}: {REDACTED}")


def test_has_the_sandbox_config_it_requires() -> None:
    if required and missing:
        pytest.fail(f"TGBP_REQUIRE_SANDBOX=1 but these are unset: {', '.join(missing)}")


@pytest.mark.skipif(bool(missing), reason="sandbox credentials not set")
def test_creates_a_sandbox_mint() -> None:
    try:
        failure = create_replay_and_cancel()
    except Exception as error:
        raise redacted(error) from None
    if failure:
        pytest.fail(failure)


def create_replay_and_cancel() -> str | None:
    """Returns this repo's own failure text, or None. Never puts API values in it."""
    tgbp = TgbpClient(api_key=os.environ["TGBP_SANDBOX_API_KEY"], environment="sandbox")
    # The API refuses a second active mint to the same address for the same
    # amount, so each run mints a random amount from 5.00 to 104.99.
    amount = Decimal(500 + random.randrange(10_000)) / 100
    body = {
        "customerId": os.environ["TGBP_SANDBOX_CUSTOMER_ID"],
        "destinationAddress": os.environ["TGBP_SANDBOX_ADDRESS"],
        "chain": os.environ.get("TGBP_SANDBOX_CHAIN") or "sepolia",
        "amount": {"currency": "GBP", "value": amount},
    }

    created = tgbp.mints.create(body)
    if not isinstance(created, Created):
        return "the sandbox account requires dual approval; use one that does not"
    if created.status != "created":
        return "the first create did not report a new mint"
    mint_id = created.data.id

    # Cancel even when the replay check fails, so no run leaves an active mint behind.
    try:
        replay = tgbp.mints.create(body, idempotency_key=created.idempotency_key)
        replayed = isinstance(replay, Created) and replay.status == "replayed" and replay.data.id == mint_id
    finally:
        cancelled = tgbp.mints.cancel(mint_id, {"reason": "tgbp-devkit Python integration test"})
    if not replayed:
        return "a create with the same key did not replay the first mint"
    if cancelled.data.status != "cancelled":
        return "the mint did not cancel"
    return None
