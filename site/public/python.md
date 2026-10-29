# Python quickstart

> **For AI agents.** This page is also Markdown, at [/python.md](https://dev.tokenisedgbp.com/python.md), and [llms.txt](https://dev.tokenisedgbp.com/llms.txt) lists every page. To act on tGBP, install the `tgbp-mcp` MCP server and the agent skills from `@bcptechnologies/tgbp-kit`: the [README](https://github.com/bcp-markets/tgbp-devkit#agents-mcp-server-skills-and-spend-policy) has the config. Start on testnet: Base Sepolia, test tGBP from the faucet, and the API sandbox, the server's default. Act through the server and its spend policy, and never ask for the API key or the wallet key.

[`tgbp-kit`](https://pypi.org/project/tgbp-kit/) is the Python client for the tGBP mint, redeem and swap API. It covers the same operations as the TypeScript client, with request and response types generated from the API spec. This guide creates a test mint on the sandbox. You need Python 3.10 or later and a sandbox API key.

The script is also in the repo, under [`examples/python-quickstart`](https://github.com/bcp-markets/tgbp-devkit/tree/main/examples/python-quickstart).

## 1. Install the client

```
python3 -m venv .venv
. .venv/bin/activate
pip install tgbp-kit
```

The package is on PyPI at [pypi.org/project/tgbp-kit](https://pypi.org/project/tgbp-kit/).

## 2. Set your sandbox details

The sandbox takes staging API keys and mints on testnets only. Set the key, a verified customer on your account and an approved recipient address for that customer:

```
export TGBP_API_KEY=...
export TGBP_CUSTOMER_ID=...
export TGBP_ADDRESS=0x...
```

## 3. Create a mint

Save this as `mint.py`:

```
"""Create a test mint on the tGBP sandbox, simulate the bank transfer and follow the mint."""

import os
import time
from decimal import Decimal

from tgbp_kit import Created, TgbpClient

tgbp = TgbpClient(api_key=os.environ["TGBP_API_KEY"], environment="sandbox")

result = tgbp.mints.create(
    {
        "customerId": os.environ["TGBP_CUSTOMER_ID"],
        "destinationAddress": os.environ["TGBP_ADDRESS"],
        "chain": os.environ.get("TGBP_CHAIN", "sepolia"),
        "amount": {"currency": "GBP", "value": Decimal("25.00")},
    }
)
if not isinstance(result, Created):
    raise SystemExit(f"A second person must approve this mint: {result.approval_request_id}")
mint = result.data
print(f"Created mint {mint.id}. Idempotency key: {result.idempotency_key}")

# Sandbox only: pretend the bank transfer arrived.
tgbp.mints.simulate_payin(mint.id)

for _ in range(60):
    mint = tgbp.mints.get(mint.id).data
    print(f"{mint.id}: {mint.status}")
    if mint.status in ("confirmed", "in_transit", "failed", "cancelled"):
        break
    time.sleep(5)
else:
    print("Stopped waiting after 5 minutes. Check again with tgbp.mints.get.")
```

Run it:

```
python mint.py
```

The sandbox simulates the bank transfer, and then the mint moves on. It can stop at `in_transit`, because the sandbox simulates only the first bank leg.

## Money is never a float

Pass amounts as `Decimal`, a string or an int. The client raises `TypeError` on a float, because a float cannot hold most decimal amounts exactly. Amounts in responses come back as `Decimal`.

## Retries and idempotency

Every create sends an idempotency key. The client generates one unless you pass `idempotency_key=`, and returns it on the result. It retries a network error or a 5xx with the same key, so a retry returns the first mint instead of a second one. When a call fails, it raises `TgbpKitError`. Its `details` name the key to retry with when the call may have taken effect.

## Next

- Redeem tGBP for GBP with `tgbp.redemptions.create`.
- Swap USDC and tGBP with `TgbpSwapClient`.
- Read every operation in the [Python README](https://github.com/bcp-markets/tgbp-devkit/tree/main/python#readme).
