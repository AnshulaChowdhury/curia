# ADR-054: Personal details are authorized by who directed the send, not redacted by pattern

Date: 2026-10-26
Status: Accepted

## Context

Under `autonomy.gating: band` (ADR-049) the outbound gateway still ran the PII redactor first.
It replaced every detected item with a `[REDACTED: …]` token before band review saw the
message, so the judge ruled on tokens and the recipient could receive a message with holes in
it. One incident (#2312) showed six failures at once:

1. A counterparty's reply to Curia's own outreach (a web-form booking) arrived as a stranger
   with no task, so nothing said the principal had asked for it.
2. The judge flagged Curia's own statements ("I can't share that") as ungrounded claims about
   the principal.
3. A report to the principal was judged as a disclosure to a third party.
4. A refusal was cut down to a fragment and sent, and the principal was told it had been
   shared in full.
5. Nobody asked the principal. A legitimate requester's need ended in a refusal.
6. The principal was told "unverified" about a contact that was verified, because identity
   verification and message authentication were one fact in the sender block.

Whether sharing a phone number or a SIN is acceptable depends on who authorized it and why:
the same number is right to send when the principal said "give them my number to book the
call" and wrong when a stranger's forwarded text claims the principal said so. A pattern
cannot tell the two apart. The data's sensitivity does not either.

## Decision

Under band gating, personal details are authorized per item by the judge, with the authority
computed by code, and the gateway never cuts or tokenizes text. The drafter writes the details
it was asked for and leaves the decision to the gateway: the band autonomy block's
**Personal details** rule says so, and the LOW-TRUST and trust-score prompt rules defer to it.
Without that, they had the drafter withhold the detail before review saw it. Under `gating: tier`, the
redactor behaves as before and the gateway only reports what it removed.

1. **Detect, then decide, then act.** The gateway detects PII items (body, subject and the
   quoted thread) without removing anything. The band brief gets a `disclosure` question: for
   each item (at most ten; past that the judge rules on the message's own items alone, and
   quote-only items go unruled, so the quote is dropped; more than ten of the message's own
   is treated as unsupported) the judge answers `directed`,
   `inferred` or `unsupported`, and whether the recipient asked for it. Detected items are
   ruled on under `disclosure` only, never `necessity`.
2. **The judge's ruling is advisory; code owns authority.** A deterministic policy table
   (`band-send-review.ts`) combines the ruling with who directed the send: the principal
   (live turn, the send's task or its root task, or a recorded yes), or a trusted contact
   whose directive arrived on an authenticated channel. Authority is computed from evidence
   the judge cannot write: originator tier and system role, message authentication
   (`TaskOriginator.authenticated`), the live turn, and the task. A `directed` ruling is
   accepted only for an authority the code confirms. A trusted contact's explicit directive
   is held for the principal at any score: a trusted contact is not the principal, and the
   trusted tier grants no `send_on_behalf`. (The design had it send and copy the principal;
   the first paid scenario run showed that contradicting the authorization block and the
   approval band, so the principal decides until the permissions are revisited.) Text quoted
   or forwarded inside a message grants no authority.
3. **No cut-and-send, and no tokens delivered.** A finding the judge will not approve goes
   back to the drafter once to be rewritten without it. If the rewrite still has it, the
   send is held below 80 and blocked at 80+ (the drafter is told why and may ask the
   principal). A relayed reply or a saved draft has no drafter to rewrite, so a block holds
   it. Any `[REDACTED: …]` token in a band-gated body or subject is a defect and bounces the
   same way. The agent always learns which labels were removed or refused. If the judge fails,
   the message's own items fail closed, never open: the draft bounces (held below 80, which
   holds every unreviewed send). Items only in a quoted message follow decision 4: the send
   takes the ordinary judge-failure path without the quote, so an unreviewed quote never goes out.
4. **Quoted-thread exemption.** A detail that appears only in quoted text is not a
   disclosure when every non-principal recipient was already on the quoted message, which the
   gateway confirms from that message's own headers, never from the caller's word. Otherwise
   an unauthorized quote-only item drops the quote rather than bouncing the reply. The
   principal's approval never covers a quote it did not show: an approved replay, and a draft
   saved for one, go without a quote that has personal details and reaches someone new. A
   reply draft saved by `email-draft-save` follows the same rule. Once saved, its quote is
   part of the stored body: `send-draft` reviews it as the draft's own text, which can hold a
   reply the exemption would have let through, but never lets one out.
5. **Replies are linked to their task by outreach records.** Sends and web forms on a
   task-bound turn write `task_outreach` rows (the `record-outreach` tool covers forms and
   calls; a `web-browser` backstop records a skeleton row). A non-principal email is matched
   by address, known contact, or the organization's domain (shared-tenant and freemail hosts
   excluded), then by a fast-tier model check. A link is **strong** only when the match is
   direct, the sender is authenticated and the row is `confirmed`: an explicit outreach act on
   a principal-originated turn. Everything else is **weak**. A strong link lets an `inferred`
   ruling send; a weak link never does at any score and only makes the requester askable. A
   link never changes the sender's tier. Addresses are learned onto the row only after a
   strong link or the principal's yes.
6. **Ask instead of refusing, when the requester is askable.** An `unsupported` item the
   recipient asked for, where the recipient is linked to a principal-directed task or is a
   `known` or `trusted` contact, becomes a held send whose approval leads with the question
   ("<requester> wants your <label> to <summary>. Share it?"). The send result tells the
   agent to deliver the approval and send a holding reply without the data. A cold stranger
   gets a polite decline, not an ask. The principal's yes or no (reaction, or
   `approve-action` / `deny-action`) is stored in `disclosure_decisions` per conversation,
   counterparty and label: a yes authorizes that label to that counterparty on that thread, a
   no turns later asks there into bounces, and the principal's newest explicit live word wins.
7. **Approvals are informed.** An approval display lists every personal detail (label and
   value) so an approved replay goes out intact; `approve-action` refuses an approval the
   principal was never shown when it carries personal details, and records a yes only for a
   delivered one. Saved drafts get the same detection: held under band, and refused under
   tier unless principal-directed. An approved draft passes intact only if it is unchanged
   since approval.
8. **Sender facts are stated separately.** The coordinator's sender block gives identity
   verification and message authentication as two facts, so a verified contact is never
   called unverified (spec 06).

## Alternatives considered and rejected

- **Exempt the principal's own identities from redaction.** It would have fixed the incident
  but is wrong in general: the principal's SIN should still not go to a stranger, and the
  exemption would cover precisely the data most worth protecting. Authority, not identity of
  the data's subject, decides.
- **Sensitivity-based exceptions** (a tier of "low-risk" details such as a phone number that
  may go anywhere). Sensitivity depends on the recipient and the purpose; the same number is
  harmless to a booking desk and a leak to a scraper. It also re-creates the false positives
  ADR-049 removed.
- **Keep cut-and-send** (cut the sentence or token and send the rest). It produced the
  incident's hollow message and a false report to the principal. A message with something
  removed is a different message; only the drafter can rewrite it so it still makes sense.
- **Domain as the only linking signal, or a domain match that grants authority.** A domain
  match is cheap but spoofable by anyone at that domain or on a shared host, and misses forms
  answered from another address. Domain is one signal among several; authority needs a direct
  match, an authenticated sender and a confirmed act (strong link). The model check and
  unauthenticated matches are weak and only make a requester askable.
- **Refuse instead of asking.** A refusal turns a legitimate counterparty away and tells the
  principal nothing. Asking costs one approval and records the answer for the thread.

## Consequences

- A single path decides every send's personal details, with fewer false redactions and a
  complete message or no message. The judge needs the raw values, as the drafter and the
  tool-result evidence already did; the content filter's Stage 2 still sees the redacted copy.
- More holds below 80 and an extra deliver step for approvals with personal details; approval
  messages are longer. Principals see asks for linked or known requesters only.
- A judge failure bounces a draft carrying personal details (holds it below 80), and more than
  ten of the message's own items always bounce: larger messages must be split. A long quote
  that alone passes the cap goes without the quote. A quote-only judge failure sends
  without the quote.
- The outreach tables and `disclosure_decisions` (migrations 107 and 108) add state to keep
  correct; weak links and unconfirmed rows cost an ask where a strong link would have shared.
- `gating: tier` is unchanged apart from reporting: sends say what was redacted, the quoted
  thread is still not redacted, and a tier-gated saved draft from the principal still sends
  as written. Operators move to band to get the full flow.
- A trusted contact's directive to send the principal's details costs an approval at any
  score; loosening that is a permissions change, not a band-review one.
- Scenario cases run through the production gateway into recording transports (`through_gateway`)
  so these behaviors are checked deterministically.

Supersedes in part [ADR-049](049-band-driven-autonomy.md) where it describes trimming and
unneeded disclosures.
