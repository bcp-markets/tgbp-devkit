---
name: tgbp-balance
description: Read a tGBP balance on an EVM chain, for this agent's wallet or any address. Use when the user asks how much tGBP a wallet holds, or before a transfer, redemption or swap to check there is enough.
---

# Read a tGBP balance

Call the `tgbp_balance` tool from the `tgbp` MCP server.

- `chain`: a registry chain key, such as `sepolia`. It must be one of the spend policy's `chains`.
- `owner`: the address to read. Leave it out to read this agent's own wallet.

The result's `amount` is a decimal string in tGBP: `"12.5"` means 12.50 tGBP, worth £12.50.

A balance read moves nothing and does not count against any cap. The policy must still list
`balance` in its `actions`.

## When the tool refuses

An error with `code: "SPEND_POLICY_DENIED"` names the policy field in `details.rule`. Tell the
user which rule refused the read, and stop. Only the user can change the policy.
