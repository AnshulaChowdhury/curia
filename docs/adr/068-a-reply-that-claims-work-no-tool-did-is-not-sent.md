# ADR-068: A reply that claims work no tool did is not sent

Date: 2026-11-27
Status: Accepted

## Context

In a chat with a budget spreadsheet attached, the coordinator answered more than once that it had delegated or completed
work when it had called no tool. Its instructions said it could not change the budget and must not say it had. Replies
are stored as text only, so earlier unbacked replies in a conversation may encourage more.

## Decision

On a turn carrying the `budget-sheet-attached` guidance, where the model can delegate and has called `delegate` zero
times:

- a draft that **states work was delegated or done** is held back, and the model gets one more round with a runtime note
  and **`delegate` required** (`toolChoice`, supported by the Bedrock and Anthropic providers);
- a reply that **still** states it is replaced with a fixed message saying nothing was done.

Claims are recognised by pattern (`unbacked-claim.ts`); questions, offers, conditions and denials are left alone.

## Consequences

- The check is code, so it does not depend on the model following an instruction.
- It is narrow. Other chats and other kinds of claim are not checked, and an unusual wording can slip past.
- It does not verify what a delegation achieved: after one runs, the reply is not checked.
- A mistaken match costs one extra model call and delegates a request that did not need it. The specialist can only
  read, or propose changes the owner must approve (ADR-067).
