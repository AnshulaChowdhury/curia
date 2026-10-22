# ADR-052: Knowledge-graph node merge — a previewed, single-transaction merge where the survivor's type is the result type

Date: 2026-10-21
Status: Accepted

## Context

The knowledge graph accumulates duplicates. Some are the same kind of thing: two `person`
nodes for one human, each with its own contact. Others are one entity stored as the wrong
kind: an `event` called "Acme" that is really the organization Acme, or an `organization`
node that is really a person. ADR-040 made the first kind routine, because two contacts
that share a name now each hold a same-label node.

Nothing merges two *nodes*. The principal can merge two *contacts* from the Contacts page,
and that folds the KG nodes best-effort, after the commit, through
`EntityMemory.mergeEntities` (#1711 moved the fold to after the secondary contact row is
gone). `mergeEntities` is the wrong foundation for a user-driven merge:

- It is not transactional.
- It re-stores every fact through `storeFact`: one embedding call per fact, a rate limit of
  50 per source, and a silent drop when `storeFact` rejects a fact.
- It hard-deletes the secondary node.
- It does no conflict detection.

The contact merge also loses data around the contact. A merge cascade-deletes
`contact_calendars`, `grant_recommendations` and `conversation_resolved_entities`, nulls
`tasks.waiting_on_contact_id`, `voice_sessions` and `working_memory`
references, leaves `originator.contactId` stale, and never carries the canonical
attributes (title, organization, timezone, …) across. #1695 made the write sequence
transactional but did not touch these.

The console needs a node merge that handles same-type and cross-type duplicates, shows the
user every contradiction before anything is written, and can be recovered from. The
questions were what the result type is, how the merge executes, how the user stays in
control of conflicts, what happens to the absorbed node, and what happens to the contacts
hanging off both.

## Decision

**A console node merge is a two-step, previewed operation. The survivor keeps its id and
type, and the whole apply runs in one Postgres transaction on a single client.** The design
is `docs/wip/2026-10-21-kg-node-merge-design.md`; the user flow and endpoints are in
spec 12, *Merging nodes*.

### The survivor's type is the result type

The user picks the direction: the node they keep (the survivor) and the node folded into it
(the absorbed node). The result has the survivor's id, type and identity tier. The console
shows a **Swap** button, and the preview suggests a swap when the direction would lose
information: the absorbed node is the principal's, the absorbed node has contacts the
survivor's type cannot take, or the absorbed node is a person with a contact and the
survivor is a contactless node of another type.

Rejected: letting the user choose the result type freely, or inferring it. Inference has to
guess between "Acme the event" and "Acme the organization", which is exactly the judgement
the user is making. A free type choice also lets a merge produce a type that neither node
had, with the contact consequences undefined. "Keep this one" already says everything.

### One transaction, node SQL on one client

The merge writes through new SQL that takes a `PoolClient` (`src/kg-merge/`), inside one
transaction that also covers the contact merge. Facts and edges are *moved*: a fact's
`relates_to` edge is re-pointed at the survivor, and the fact node keeps its id, embedding,
timestamps and provenance. Duplicates are collapsed in place. The only embedding call is for
the survivor's label if the label changes, and it happens before the transaction. The new
vector is a `document` embedding stored with its model stamp (ADR-051).

Rejected:

- **Reusing pool-based `mergeEntities`.** It cannot join a transaction, and its
  re-store-through-`storeFact` approach has the cost and silent-drop problems above.
- **Re-storing the absorbed facts through `storeFact`.** Embedding cost, rate limits, and a
  fact the validator rejects is lost with no trace.
- **A best-effort KG fold after the contact commit** (today's behaviour). A failed fold
  leaves a merged contact and two nodes, which is the orphan state ADR-040 already has to
  count.

`mergeEntities` stays as it is for its existing callers (the Contacts-page merge and the
dedup tooling). Moving them onto the new engine is out of scope.

### Preview, then apply, gated by a plan token

`POST /api/kg/nodes/merge` defaults to `dryRun: true` and returns a preview: the conflicts,
blockers, warnings, contact plan and counts, plus a **plan token**, a SHA-256 over the
canonical snapshot of both sides. Apply sends the token and the user's resolutions. The
server reloads the snapshot under `SELECT … FOR UPDATE` row locks (nodes ordered by id, then
every affected contact), recomputes the token, and refuses with 409 `stale_preview` if it
changed. The console re-previews and keeps the user's still-valid choices.

Rejected:

- **Optimistic apply without a preview.** The user would be agreeing to a merge they have not
  seen, and a contradiction would be resolved by a default they never read.
- **The client sends the full plan.** The server would have to trust a client-computed set of
  operations against rows it has not examined. Only the token and the user's *answers*
  cross the wire; the plan is always recomputed server-side.

### Conflicts are surfaced, with server-computed defaults

Contradictions are not resolved silently. Property conflicts, conflicting attribute facts,
near-duplicate facts (cosine at least the embedding profile's fact-dedup threshold, scored only
between vectors from the live model, per ADR-051), contact field conflicts
and auth-override conflicts each come back with a deterministic id and a default. Property
and fact conflicts take the newer `last_confirmed_at` (survivor on a tie), near-duplicates
default to *merge*, contact field conflicts default to the survivor, and auth-override
conflicts default to the side that denies. The user can override any of them. Where a fact value loses, it is appended to the kept fact's
`properties.previous_values`, matching `storeFact`. Sensitivity only ratchets up and is
never user-selectable downward.

### The absorbed node is archived, not deleted

After everything has moved, the absorbed node has no edges. It is archived
(`archived_at = now()`) with `properties.merged_into` and `properties.merged_at`, keeping its
label and type. That makes the old id resolvable: `GET /api/kg/graph` answers
`404 { code: 'node_merged', mergedInto }` and the console follows the link. It keeps the
audit trail legible and leaves the door open for an undo, which is a non-goal now. The label is
freed for reuse because `idx_kg_nodes_unique` excludes archived rows. ADR-040 gave
`archived_at` on an anchored node the meaning "this contact is gone"; a merge is now a
second way to archive one, and `properties.merged_into` is what tells the two apart. By
then the absorbed contact has been merged or re-pointed, so the node no longer backs a live
contact.

Rejected: hard-deleting the absorbed node (as `mergeEntities` does). It breaks deep links,
loses the audit anchor, and rules out undo.

### Contacts, by the survivor's type

| Survivor type | Contacts plan |
|---|---|
| `person` | Everything folds into **one** contact: the survivor's contact if it has one, otherwise the earliest-created absorbed contact, re-pointed to the survivor node. Any other contact on either node is contact-merged into it. Result kind: `person`. |
| `organization` | Each absorbed contact is **re-pointed** to the survivor node and its kind becomes `organization`. They are not merged with each other, because several org contacts legitimately share one org node (ADR-040). |
| any other type | The absorbed node must have no contacts, otherwise the merge is **blocked** ("merge in the other direction, or into a person or organization"). |

A person node with more than one contact on the survivor side is an existing inconsistency
and blocks the merge. A structural absorbed contact (principal, agent) that would be merged
away blocks it too.

### Principal and agent guards

- The agent node (or a node linked to the agent contact) is a blocker on either side.
- The principal's node as the *absorbed* side is a blocker, and the preview suggests the
  swap.
- The principal's node as the *survivor* is allowed, because removing a duplicate of the
  principal is a real need. It raises the `principal_identity_transfer` warning, which
  `requiresAck`: the user must tick a box naming every absorbed identity that will become a
  principal identity.

The rationale is security. Channel identities on the principal's contact confer principal
trust: a message from one is treated as the CEO. A merge that quietly moved a third party's
email or phone onto the principal's contact would be a privilege escalation done with one
click. The acknowledgement makes the transfer an explicit act, and the server rejects an
apply that lacks it (400 `ack_required`) however the client behaves.

### Contact references travel with the contact, in both merges

A new `reattachContactReferences(secondaryId, primaryId, client)` re-points, inside the
merge transaction: `contact_calendars` (demoting the moved rows' `is_primary` when the
primary already has one), `grant_recommendations` (dropping permissions the primary already
has), `conversation_resolved_entities`,
`tasks.waiting_on_contact_id`, `voice_sessions.caller_contact_id`,
`working_memory.sender_contact_id`, and the `originator.contactId` JSONB field in `tasks`,
`scheduled_jobs`, `bullpen_threads`, `secret_capture_tokens` and `pending_delegations`. The
contact-row merge also writes the resolved canonical attributes and the summed counters, not
only `displayName`, `role`, `notes` and `tier`.

Both the node merge and the existing Contacts-page `ContactService.mergeContacts` run the
same shared helper, so there is exactly one place that knows how to fold a contact. The
Contacts-page merge keeps its API; it gains the reference re-pointing and copies
non-conflicting canonical attributes (null on the primary, set on the secondary). That fixes
the data loss without waiting for the node merge.

### Audit

After a successful apply, `NodeMergeService` publishes `kg.nodes_merged` on the system
layer (the route only maps errors to statuses). The event carries both nodes' ids, types and labels, the result label, `crossType`, the
contact merge ids, the summary counts, the chosen resolutions and the console originator as
`actor`. The audit row targets the survivor (`target_type = 'kg_node'`).

## Consequences

**Easier.** Duplicates the ADR-040 model produces on purpose (same-name people) and
cross-type duplicates the extraction pipeline produces by accident can both be repaired from
the console. A merge costs no embedding calls beyond the one label refresh, drops nothing
silently, and is all-or-nothing. Contact merges stop losing calendars, grant
recommendations, and task, message, voice and working-memory references, whichever page
starts them.

**Partly recoverable.** The tombstone carries `merged_into`, and the audit payload carries
the resolutions. Some rows are deleted outright:

- **Duplicate facts:** collapsed duplicate and near-duplicate fact nodes. The kept fact
  takes the higher confidence, the latest confirmation and the higher sensitivity.
- **Losing facts in a conflict:** when the user keeps one side, the other fact node is
  deleted. Its value goes into the kept fact's `previous_values`.
- **Edges:** collapsed edges, and edges that would become self-loops. A deleted fact's
  edges to other nodes move to the fact it was folded into; one that would duplicate an
  edge that fact already has is deleted.

A deleted fact node's own `previous_values` history moves to the kept fact. What a
deleted node does not keep is its id, its provenance row, and, for duplicates, its exact
wording. An undo is possible for the node and its moved data. It cannot bring back
deleted rows, and it is not built.

**Known limitation.** A concurrent writer that resolved the absorbed node before the lock
was taken, and inserts an edge or fact after the commit, attaches it to the tombstone. The
row locks and the token recheck close the window for everything the merge reads, but not for
a writer that holds a stale node id. It is rare, and visible: the node is archived with
`merged_into`. Fixing it means a redirect in the write path, which this change does not add.

**Accepted trade-offs.**

- Two code paths now fold KG nodes: the new engine for the console, and `mergeEntities` for
  the Contacts-page merge and the dedup tooling. They differ on purpose (the former is
  previewed, transactional and archives; the latter is best-effort and hard-deletes), and
  converging them is future work.
- Merging into an organization re-points contacts rather than merging them, so the user may
  be left with several contacts on one org node. The preview says so and points at the
  Contacts page.
- The merge is a console-only, human-driven feature. There is no agent-facing merge skill,
  and `fact` nodes and merges of more than two nodes are not supported.
- `src/kg-merge` depends on `src/memory` and `src/contacts`, never the other way round. No
  migration is needed.

## Related

- #2233 (this change)
- ADR-040 (contact-anchored KG node identity), the model that makes same-name duplicates
  routine and defines the person/organization contact rules this merge follows
- ADR-039 (decisions in the ledger), whose dedup exclusions the contact merge re-points via
  `reattachDedupExclusions`
- #1711 (contact merge loses KG memory on a foreign-key violation), which moved the
  `mergeEntities` fold to after the secondary contact is gone
- #1695 (`mergeContacts` made transactional), which this extends with contact references
- Spec 12 (*Merging nodes*), spec 09 (contact merge)
