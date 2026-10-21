---
name: tgbp-swap
description: Swap between USDC and tGBP through the tGBP Swap API, settling to an allowed recipient. Use when the user asks to convert, exchange or swap USDC and tGBP.
---

# Swap USDC and tGBP

A swap converts a deposit that the swap API has already confirmed. Fund the deposit first: send
the source tokens to the account's swap deposit address. Sending tGBP there is a transfer, so the
deposit address must be in the policy's `destinations`.

1. Call `tgbp_policy`. The recipient must be in `destinations`, the chain in `chains`, and the
   amount within `perTransferCap`.
2. Call `tgbp_swap` with:
   - `chain`: `base` or `sepolia`.
   - `direction`: `TGBP_TO_USDC` or `USDC_TO_TGBP`.
   - `amount`: the source amount, in tGBP or USDC.
   - `recipient`: the address the swapped tokens go to.
   - `minOut` (optional): refuse the swap if it would pay out less.
   - `idempotencyKey` (optional): only to retry a swap that failed with an unclear result, using
     the key from that error. Never retry without it.
3. Report the conversion to the user.

The caps are in pounds. A USDC amount counts as the same number of pounds, so 100 USDC uses
£100 of the cap.

## When the tool refuses

An error with `code: "SPEND_POLICY_DENIED"` names the refusing rule in `details.rule`. Tell
the user the rule and stop. Never split a swap into smaller ones to get under a cap, and never
send to a different recipient to get round a refusal.
