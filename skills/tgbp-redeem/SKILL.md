---
name: tgbp-redeem
description: Redeem tGBP for pounds paid to an allowed bank account. Creates the redemption and burns the tGBP from this agent's wallet, with human approval above the policy threshold. Use when the user asks to redeem, cash out or withdraw tGBP to a bank.
---

# Redeem tGBP for GBP

1. Call `tgbp_policy`. The bank id must be in `destinations`, the chain in `chains`, and the
   amount within `perTransferCap`.
2. If the amount is over `redemptionApprovalAbove`, tell the user that a human must approve it.
   Their MCP client shows the approval prompt when you call the tool.
3. Call `tgbp_redeem` with `chain`, `bankId` and `amount` (GBP to the penny, such as `"50.00"`).
   The tool creates the redemption, then sends the tGBP to the redemption's burn address.
4. Report `redemption.data.redemptionId` and `burnHash`. GBP is paid to the bank account once
   the burn confirms.

If `redemption.status` is `pending_approval`, the account needs a second person to approve it.
Nothing was burned, so do not call the tool again.

## Approval

A redemption above the threshold waits for the human to approve it in the MCP client. A "no",
no answer before the timeout, and a client that cannot ask all refuse it. There is no way for an
agent to approve it, and no timeout ever approves it.

## When the tool refuses

An error with `code: "SPEND_POLICY_DENIED"` names the refusing rule in `details.rule`;
`redemptionApprovalAbove` means no human approved it. Tell the user the rule and stop. Never
split a redemption into smaller ones to get under the approval threshold or a cap.

If the error carries `details.redemptionId`, the redemption exists but the burn did not complete.
Read the message: only "nothing was burned" means no tGBP moved. Any other burn error may have
sent the burn, so check `details.hash` on chain before anyone burns again or cancels. Tell the
user, and never create another redemption.

The tool burns only when the API's redemption is `pending` and matches the chain, amount and bank
you asked for. Otherwise it burns nothing and asks you to cancel the redemption.
