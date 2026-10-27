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
