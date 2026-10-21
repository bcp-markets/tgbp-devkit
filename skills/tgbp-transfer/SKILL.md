---
name: tgbp-transfer
description: Send tGBP from this agent's wallet to an allowed address on an EVM chain, within the spend policy's caps. Use when the user asks to pay, send or transfer tGBP.
---

# Send tGBP

1. Call `tgbp_policy` and check that the recipient is in `destinations`, the chain is in
   `chains`, and the amount is within `perTransferCap`.
2. Call `tgbp_transfer` with `chain`, `to` (the recipient address) and `amount` (a decimal
   string in tGBP, such as `"25.00"`).
3. Report the returned `hash` to the user, with the chain's block explorer if you know it.

Every transfer counts against `perTransferCap` and `dailyCap`. It counts from the moment the
policy allows it, even if the transfer then fails.

## When the tool refuses

An error with `code: "SPEND_POLICY_DENIED"` names the refusing rule in `details.rule`:

| `rule` | Meaning |
|---|---|
| `perTransferCap` | The amount is over the per-transfer cap. |
| `dailyCap` | Today's spend would pass the daily cap; `details.spentToday` says how much is spent. |
| `destinations` | The recipient is not on the allowlist. |
| `chains` | The policy does not allow this chain. |
| `actions` | The policy does not allow transfers. |
| `expiresAt` | The policy has expired. |
| `ledger` | The spend ledger cannot be read, so the daily cap cannot be checked. |

Tell the user the rule and stop. Never split a payment into smaller ones to get under a cap,
and never send to a different address or chain to get round a refusal. Only the user can
change the policy.

## Other errors

`TRANSFER_UNCONFIRMED` means the transfer was broadcast but not confirmed. Check
`details.hash` on chain before you try again: a second transfer may pay twice.
`INSUFFICIENT_BALANCE`, `ADDRESS_BANNED` and `TOKEN_PAUSED` mean nothing was sent.
