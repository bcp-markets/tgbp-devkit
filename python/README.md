# tgbp-kit for Python

Typed Python clients for the tGBP mint, redeem and swap API. tGBP is the tokenised British pound,
issued by BCP Technologies Ltd. This package covers the same API operations as the TypeScript
client in [`@bcptechnologies/tgbp-kit`](https://www.npmjs.com/package/@bcptechnologies/tgbp-kit).
The request and response models are generated from the tGBP API spec.

```sh
pip install tgbp-kit
```

It needs Python 3.10 or later and depends only on pydantic. Run it on your server: API keys carry
no scopes, so never ship one to a client device.

## Mint and redeem

```python
import os
from decimal import Decimal

from tgbp_kit import Created, TgbpClient

tgbp = TgbpClient(api_key=os.environ["TGBP_API_KEY"], environment="sandbox")

mint = tgbp.mints.create(
    {
        "customerId": "customer_…",
        "destinationAddress": "0x…",
        "chain": "sepolia",
        "amount": {"currency": "GBP", "value": Decimal("100.00")},
    }
)
if isinstance(mint, Created):
    print(mint.data.bank_transfer_details)  # pay this account, with this reference
    tgbp.mints.simulate_payin(mint.data.id)  # sandbox only

redemption = tgbp.redemptions.create(
    {"chain": "sepolia", "amount": {"currency": "GBP", "value": 50}, "bankId": "bank_…"}
)
# Then send the tGBP to redemption.data.burnAddress; GBP is paid out once the burn confirms.
```

`environment="sandbox"` calls `https://sandbox.tgbp.io`, which takes staging keys, runs on
testnets and simulates bank transfers. `environment="production"` calls `https://api.tgbp.io`,
and `base_url=` takes any other host.

| `TgbpClient` | Does |
|---|---|
| `mints.create`, `mints.get`, `mints.list`, `mints.cancel` | Create, read, list and cancel mints |
| `mints.simulate_payin` | Sandbox only: simulate the bank transfer for a pending mint |
| `redemptions.create`, `redemptions.get`, `redemptions.list`, `redemptions.cancel` | Create, read, list and cancel redemptions |
| `redemptions.quote` | Screen the address that will send the burn, before you burn |
| `redemptions.confirm_burn` | Report the burn when it is not detected on its own |

A request body is a model from `tgbp_kit.models`, such as `MintCreateRequest`, or a dict the
client validates against that model. A list takes its query as a model:

```python
from tgbp_kit.models import ListMintsQuery

page = tgbp.mints.list(ListMintsQuery(status=["pending"], per_page=50))
```

## Swap

`TgbpSwapClient` converts between USDC and tGBP. It defaults to production; for staging, pass
the swap host from your onboarding pack as `base_url`.

```python
from tgbp_kit import TgbpSwapClient
from tgbp_kit.swap_models import GetQuoteQuery

swap = TgbpSwapClient(api_key=os.environ["TGBP_API_KEY"])
quote = swap.get_quote(GetQuoteQuery(direction="USDC_TO_TGBP", usdcAmount="100"))
```

Its methods are `get_quote`, `get_limits`, `get_supported_networks`, `get_deposit_session`,
`create_deposit_address`, `list_deposits`, `get_deposit_balance`, `create_swap_intent`,
`get_swap_intent`, `cancel_swap_intent` and `create_conversion`. Each returns the record inside
the API's `data` field.

## Amounts

Pass amounts as `Decimal`, a string or an int. A float raises `TypeError`, because a float cannot
hold most decimal amounts exactly. The client reads every JSON number with a fraction as
`Decimal`, and writes a `Decimal` to the API digit for digit.

## Idempotency and retries

Every call that creates a mint, redemption, swap intent or conversion sends an idempotency key.
The client generates one unless you pass `idempotency_key=`, and returns it on the result. A retry
with the same key returns the first record and never creates a second one. Keys are 1 to 18
letters, digits, `_` or `-`, and last 24 hours. A swap intent's key is its `id`.

The client retries a network error or a 5xx response up to 3 times, with backoff, and resends the
same key each time. It never retries a 4xx, including 429. It never retries a call that is unsafe
to repeat and has no key, such as `simulate_payin` or `cancel_swap_intent`. Set `max_retries=`,
`base_delay=` (seconds) and `timeout=` (seconds, for the connect and each read) to change this.

A create returns `Created`, whose `status` is `"created"` for a new record and `"replayed"` for an
earlier one with the same key. It returns `PendingApproval` when your account needs a second
person to approve the action. Nothing exists until then, so do not retry.

## Errors

A failed call raises `TgbpKitError`, with a `code` and a `details` dict:

| `code` | Meaning |
|---|---|
| `API_ERROR` | The API answered with an error, or with a success body that does not match the spec. `details` carries `status`, the API's `apiCode` and `requestId` (quote it to support). |
| `API_UNREACHABLE` | No response, after every retry. |

When `details["mayHaveTakenEffect"]` is true, the call may have created or changed a record.
Retry only with `details["idempotencyKey"]` (or `details["swapIntentId"]`), or read the record
before you send anything new. An invalid argument raises `ValueError` or `TypeError` before any
request is sent.

## Development

From the repo root:

```sh
python -m venv python/.venv && . python/.venv/bin/activate
pip install --group python/pyproject.toml:dev -e python
ruff check python && mypy --strict --config-file python/pyproject.toml python/ && pytest python
```

`python/spec/*.json` holds the API spec, pruned to the operations the kit publishes. The tGBP team
regenerates it from the private spec with `pnpm generate:api`.
`python/scripts/generate_models.py` then writes `models.py` and `swap_models.py`; CI fails when
they drift from the spec. `pnpm check:python-parity` checks that this client has every operation
the TypeScript client has.

`tests/test_sandbox_live.py` creates, replays and cancels a mint on the sandbox. It runs when
`TGBP_SANDBOX_API_KEY`, `TGBP_SANDBOX_CUSTOMER_ID` and `TGBP_SANDBOX_ADDRESS` are set.

## Releases

Publishing a GitHub release tagged `python-v<version>` publishes this package to PyPI through
trusted publishing. The npm package releases on `v<version>` tags.

## Licence

MIT
