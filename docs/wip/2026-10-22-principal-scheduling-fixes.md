# Principal scheduling fixes (#2227) — plan

Design and baseline: `docs/wip/2026-10-21-principal-scheduling-scenarios-design.md` and #2227.
Measured with the 25-series batches (`--tags ps-core|ps-ask|ps-prefs`, `deepseek/deepseek-v4.1-flash`),
compared with the pre-fix runs kept outside the repo.

One issue, several PRs, in this order. Each fix sits on the highest rung that works (ADR-046).

## PR 1 — forwards and booking links (gaps A and B)

Both are injections keyed on something the dispatcher can see in the inbound text, so they
cost nothing on other turns.

- **`principal-forward`** (`src/agents/prompts/turn-guidance.ts`). Trigger: a live principal
  email addressed to Curia (not a CC) that `looksLikeForward` (`src/dispatch/turn-guidance-triggers.ts`):
  a `Fwd:`/`FW:` subject, or a Gmail or Apple Mail forward marker as the first quote marker.
  Says a forward means "please handle this" unless the note says otherwise, and to tell the
  principal what was done rather than ask. Replaces `principal-reply-shaped`, which pulls
  toward asking.
- **`booking-link`**. Trigger: `hasBookingPageLink`, a known booking host with a path
  (Calendly, Google booking pages, cal.com, SavvyCal, HubSpot meetings, Microsoft Bookings
  and others). Any sender, any channel; conditional on Curia actually setting up a meeting
  with the page's owner. Says: free windows from the calendar specialist with no holds, book
  with `web-browser`, create no event or hold of Curia's own (the page sends the invite),
  confirm on the thread, and fall back to email times only if the page fails.

Measure: 25j, 25k, 25l at 5 runs, then 9 for the acceptance criteria. Regression watch:
smoke's pasted-forward cases run on CLI, which `principal-forward` does not touch.

**Result (2026-10-22, 9 runs each, autonomy 84 band):** every critical behavior passed 9/9 in
25j, 25k and 25l (baseline 2/5, 3/5 and 1–2/5). No duplicate invite in any booking run
(baseline: every booking). Their `known_failure` markers are removed. Still seen: 25j leaves
three holds per run, which PR 3's hold hygiene covers.

## PR 2 — senders the principal knows (gap D)

Trust is a security boundary, so this needs a decision before code (see the open question
below). The aim: a sender the principal has corresponded with is not declined as a stranger,
and a decline actually reaches the principal.

## PR 3 — making room by band (gap C)

An injection keyed on "make room" language in a principal turn, carrying the band's rule:
at ≥80 move the principal's own blocks (then small internal meetings) and say what moved;
below 80 one private, specific ask. Never external, multi-stakeholder or medical events.
Consider a calendar-side check that flags an offered slot overlapping a busy event.

## PR 2 decisions

Decided (2026-10-22): a code check in dispatch, not a prompt step. For an email sender with
tier `unknown`, kind person, and `senderVerified` (SPF, DKIM and DMARC pass): if the sender
shares the principal's (non-freemail) domain, or the principal has sent them mail (an
injectable lookup over the principal's mailbox, so scenarios can stub it), elevate the
contact to `known` and re-resolve before routing. `known` carries `schedule_meetings`.
Also decided: lower `security.trust_thresholds.scheduling` from 0.5 to 0.3, since a `known`
email contact scores about 0.24 + 0.4 × confidence and would otherwise still be declined in
production.
