---
name: tgbp-mint
description: Create a tGBP mint through the tGBP API. GBP paid by bank transfer becomes tGBP at an allowed address. Use when the user asks to mint, buy or top up tGBP with pounds.
---

# Mint tGBP

1. Call `tgbp_policy`. The destination address must be in `destinations`, the chain in
   `chains`, and the amount within `perTransferCap`.
2. Call `tgbp_mint` with `chain`, `destinationAddress` and `amount` (GBP to the penny, such as
   `"100.00"`). Pass `customerId` when the account mints for its own customers.
3. Read the result's `status`:
   - `created` or `replayed`: give the user `data.bank_transfer_details`. tGBP is minted to the
     destination once that bank transfer arrives.
   - `pending_approval`: the account needs a second person to approve the mint. Nothing exists
     yet, so do not call the tool again.

A mint counts against `perTransferCap` and `dailyCap`, like any other action that moves value.

## When the tool refuses

An error with `code: "SPEND_POLICY_DENIED"` names the refusing rule in `details.rule`. Tell
the user the rule and stop. Never split a mint into smaller ones to get under a cap, and never
mint to a different address to get round a refusal.

After an `API_ERROR` with a 5xx status, or `API_UNREACHABLE`, the mint may exist. Tell the user,
and quote `details.idempotencyKey`; do not create a new mint.
