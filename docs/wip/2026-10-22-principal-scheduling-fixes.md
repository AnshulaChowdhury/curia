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

**What shipped in PR 2 beyond the decisions below:**
- The elevated message is counted toward confidence before the trust score is taken, so a
  first email scores 0.34 rather than 0.24 (decided with the user).
- The scenario stack scores and authorizes senders as production does (AuthorizationService
  in the resolver; channel trust, weights and the confidence pipeline in the harness
  Dispatcher). Before this, every known contact reached the coordinator in scenarios with no
  AUTHORIZATION section (decided with the user; release gate re-run).
- Turn guidance on the elevated turn names the evidence (`principal-colleague` or
  `principal-correspondent`) and how to weigh a request for the principal's time
  (`acquaintance-time-request`). Without them the colleague was sometimes treated as
  unvetted, and the acquaintance was booked into the next two workdays (3/9).
- 25m/25n `principal_hears` also accepts the principal note (the Dispatcher emails it).

**Result (2026-10-22, 9 runs, autonomy 84 band):** 25m and 25n pass every critical behavior
9/9 (baseline 0/10 between them). Markers removed.

## PR 3 — making room by band (gap C)

An injection keyed on "make room" language in a principal turn, carrying the band's rule:
at ≥80 move the principal's own blocks (then small internal meetings) and say what moved;
below 80 one private, specific ask. Never external, multi-stakeholder or medical events.
Consider a calendar-side check that flags an offered slot overlapping a busy event.

**What shipped:** the `make-room` injection (`looksLikeMakeRoom` on the principal's own text,
above any quote; plain "find some time" does not fire). Below 80 a short holding note to the
counterpart is allowed. The calendar-side overlap check was not needed.

Case fixes found on the way:
- 25b's `calendar-check-conflicts` stub reported a conflict for every slot, so a slot freed by
  a move still read as busy and the calendar specialist looped until the run timed out
  (2 of 5 runs). It now answers clear; `makes_room` now fails an offer over an event left in
  place.
- 25c's `specific_ask` asked for "focus blocks, the 1:1", so the judge docked a proposal that
  moved only the principal's own blocks, which is the order the principal asked for.

**Result (2026-10-22, 9 runs):** 25b at 84 (band) and 25c at 74 (band) pass every behavior
9/9 (baseline: 25b moved events in 1/10, 25c asked first in 0/5). Markers removed.

## PR 2 decisions

Decided (2026-10-22): a code check in dispatch, not a prompt step. For an email sender with
tier `unknown`, kind person, and `senderVerified` (SPF, DKIM and DMARC pass): if the sender
is on a configured organization domain (`security.principal_org_domains`, empty by default;
first drafted as "the principal's own non-freemail domain", replaced after a security review
because a denylist of mail providers fails open), or the principal has sent them mail (an
injectable lookup over the principal's mailbox, so scenarios can stub it), elevate the
contact to `known` and re-resolve before routing. `known` carries `schedule_meetings`.
Also decided: lower `security.trust_thresholds.scheduling` from 0.5 to 0.3, since a `known`
email contact scores about 0.24 + 0.4 × confidence and would otherwise still be declined in
production.
