---
name: tgbp-swap
description: Swap between USDC and tGBP through the tGBP Swap API, settling to an allowed recipient. Use when the user asks to convert, exchange or swap USDC and tGBP.
---

# Swap USDC and tGBP

A swap runs in two calls to `tgbp_swap`, with a deposit between them. The first call registers a
swap intent: a firm quote that waits for its deposit. The second converts the deposit that fills
it. Never send funds to the swap deposit address before the intent exists. The swap API neither
converts nor returns a deposit that no intent expects.

1. Call `tgbp_policy`. The recipient must be in `destinations`, the chain in `chains`, and the
   amount within `perTransferCap`.
2. Call `tgbp_swap` with:
   - `chain`: `sepolia` on testnet. For mainnet, see [Mainnet](#mainnet).
   - `direction`: `TGBP_TO_USDC` or `USDC_TO_TGBP`.
   - `amount`: the source amount, in tGBP or USDC.
   - `recipient`: the address the swapped tokens go to. The deposit must come from it too.
   - `minOut` (optional): refuse the swap, and cancel its intent, if the quote pays out less.
   - `idempotencyKey` (optional): only to retry a swap that failed with an unclear result, using
     the `intentId` from that error. Never retry with a new one.
3. Until a deposit fills the intent, the call fails with the exact amount to send, the address to
   send it from and a deadline. Send exactly that amount from `recipient` to the account's swap
   deposit address before the deadline. Sending tGBP there is a transfer, so the deposit address
   must be in `destinations`.
4. Once the deposit confirms, call `tgbp_swap` again with the same inputs. It finds the same
   intent and converts it. The swap API also converts a funded intent on its own.
5. Report the conversion to the user.

The caps are in pounds. A USDC amount counts as the same number of pounds, so 100 USDC uses
£100 of the cap. Each call counts against the caps, the second one too.

## When the tool refuses

An error with `code: "SPEND_POLICY_DENIED"` names the refusing rule in `details.rule`. Tell
the user the rule and stop. Never split a swap into smaller ones to get under a cap, and never
send to a different recipient to get round a refusal. A refused second call does not strand a
deposit: the swap API converts a funded intent on its own.

An intent that expired or was cancelled converts nothing. The next call with the same inputs
registers a new one. An intent that failed or was withdrawn may already hold a deposit, so every
call with the same inputs is refused: send nothing more, and ask a human to check it.

## Mainnet

On mainnet, swaps run on `base`. The server needs `TGBP_ENVIRONMENT=production`, and the policy's
`chains` must list `base`. Swap on mainnet only when the user asks for it by name.
