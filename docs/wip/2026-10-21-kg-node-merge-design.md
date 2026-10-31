# Knowledge-graph node merge (web console) — design

Status: approved for build (2026-10-21)
Related: ADR-040 (contact-anchored node identity), ADR-039 (dedup exclusions), #1711, #1695, spec 12 (KG web explorer), spec 09 (contacts)

## 1. Problem

The knowledge graph accumulates duplicates. Some are the same kind of thing: two
`person` nodes for one human, each with its own contact record. Others are the
same entity stored as the wrong kind: an `event` called "Acme" that is really the
organization Acme, or an `organization` node that is really a person. Today the
principal can merge two *contacts* from the Contacts page. That folds the KG
nodes best-effort, after the commit, through `EntityMemory.mergeEntities`. Nothing
merges two *nodes*, and nothing handles a cross-type merge. `mergeEntities` itself:

- is not transactional,
- re-stores every fact through `storeFact`, so it pays one embedding call per
  fact, is rate-limited at 50 per source, and silently drops a fact that
  `storeFact` rejects,
- hard-deletes the secondary node,
- does no conflict detection at all.

The contact merge also loses associated data:

- **Cascade-deleted:** `contact_calendars`, `grant_recommendations` and
  `conversation_resolved_entities`.
- **Nulled:** `tasks.waiting_on_contact_id`, `voice_sessions` and
  `working_memory`.
- **Left stale:** `originator.contactId`.
- **Never carried over:** the canonical attributes (title, organization,
  timezone, …).

## 2. Goals / non-goals

Goals
1. From the KG explorer, pick a node, pick a second node (from suggested
   duplicates or search), review the merge, and apply it.
2. Same-type merges. For person + person, the linked contact records are merged
   too, with all of their associated data.
3. Cross-type merges, such as event → organization or organization → person. The
   **survivor's type is the result type**, and the user can swap the direction
   before applying.
4. Facts, properties, aliases and edges are merged and de-duplicated.
   Contradictions are shown as **conflicts** with a pre-selected default the
   user can change.
5. Apply is one Postgres transaction. It is gated on an unchanged preview (plan
   token), audited, and recoverable: the absorbed node is archived as a
   tombstone, not deleted.

Non-goals (this PR)
- Undo. The tombstone and audit payload make it possible later.
- An agent-facing merge skill.
- Moving the Contacts-page merge (`mergeContacts`) onto the new engine. It does
  gain the associated-data fixes (§6.4).
- Merging `fact` nodes, or merging more than two nodes at once.

## 3. Vocabulary

- **Survivor**: the node that remains, keeping its id and type.
- **Absorbed**: the node folded into the survivor. It ends up archived with
  `properties.merged_into = <survivor id>`.
- **Plan**: the pure computation from a snapshot of both sides. It holds the
  conflicts, blockers, warnings and operations.
- **Resolutions**: the user's answers to the conflicts.
- **Plan token**: a SHA-256 over the canonical snapshot. Apply recomputes it
  under row locks and refuses (409) if it changed.

## 4. Survivorship rules

### 4.1 Node scalars (no prompt; shown in the summary)

| Field | Rule |
|---|---|
| `id`, `type` | survivor's |
| `label` | user choice (default: survivor's). The other label becomes an alias. |
| `aliases` | Union of: survivor aliases, the unchosen label, absorbed aliases. Lower-cased, de-duplicated, minus the final label, capped at `MAX_ALIASES_PER_ENTITY` (10). Overflow is listed as `droppedAliases` in the preview. |
| `properties` | Union. A key present on both sides with deep-unequal values is a **property conflict** (§4.2). Reserved keys are never copied from the absorbed node: `merged_into`, `merged_at`, `is_agent`. |
| `confidence` | max |
| `decay_class` | most durable: permanent > slow_decay > fast_decay |
| `sensitivity` | max. This ratchet only goes up and is never user-selectable downward. |
| `created_at` | min |
| `last_confirmed_at` | max |
| `source` | survivor's |
| `warned_at` / `warn_reason` | survivor's if set, else absorbed's |
| `embedding` | recomputed only if the label changes. It is computed **before** the transaction. If embedding fails, keep the old embedding and add a result warning (`embedding_not_refreshed`). |
| `identity_source` | `contact` if the survivor is a person node that has a contact after the merge, otherwise unchanged. Organizations stay `label` per ADR-040. |

### 4.2 Property conflicts
These are keys on both sides with different values. The options are
`survivor | absorbed`. The default is the side with the newer
`last_confirmed_at`, which is the existing `mergeEntities` rule; on a tie the
survivor wins.

### 4.3 Facts
A fact is a `kg_nodes` row with `type='fact'`, linked to its entity by a
`relates_to` edge in either direction. The merge collects the facts of each side.
A fact linked to both sides is kept once, and the absorbed side's link is dropped.

1. **Attribute facts** are facts with a `properties.attribute`. Group them by
   normalized attribute, meaning trimmed and lower-cased.
   - **Same value** (normalized `properties.value`, or the normalized label when
     there is no value): an automatic duplicate. The survivor's fact node is
     kept, its `confidence` and `last_confirmed_at` become the max of the two,
     and its `sensitivity` the max. The absorbed side's fact node is deleted.
   - **Different value**: a **fact conflict**. The options are
     `survivor | absorbed | both`, and the default is the newer
     `last_confirmed_at`. With `survivor` or `absorbed`, the kept fact's
     `properties.previous_values` gets the dropped value appended, as
     `{ value, source, replaced_at, reason: 'node_merge' }`, matching the shape
     `storeFact` uses. The dropped fact node is deleted. With `both`, both facts
     stay attached to the survivor.
   - If one side has several facts with the same attribute, they are grouped:
     the conflict compares the newest fact on each side, and the others move
     unchanged.
2. **Non-attribute facts**
   - **Exact duplicate** labels are collapsed automatically, as above.
     Normalization: lower-case, collapse whitespace, strip trailing `.`/`!`.
   - **Near-duplicates**: cosine similarity of the two fact embeddings is at
     least the embedding profile's `factDedup` threshold (ADR-051). Only
     vectors stamped with the live model are compared. The options are `merge | keep_both`, and the default is
     `merge`, which keeps the higher-confidence fact and treats the pair as an
     exact duplicate. Pairs with a null embedding are skipped. Each absorbed fact
     pairs with at most one survivor fact (its best match).
3. Every other absorbed fact **moves**. Its `relates_to` edge is re-pointed from
   the absorbed node to the survivor. The fact node keeps its id, embedding,
   timestamps and provenance, with no `storeFact` call and no embedding call.

### 4.4 Edges (all non-fact edges of the absorbed node)
- An edge between the survivor and the absorbed node would become a self-loop,
  so it is **dropped**.
- If the re-pointed edge would collide with a live survivor edge on
  `idx_kg_edges_unique` (the unordered pair plus the type), it is **collapsed**.
  The survivor edge gets max `confidence`, max `last_confirmed_at` and the most
  durable decay class. Properties are merged, with the survivor winning. The
  absorbed edge is deleted.
- Otherwise it is **moved**: the endpoint is updated in place, so the id and
  timestamps are preserved.
- Execution order matters for the unique index: delete the collapsed and dropped
  edges first, then update the endpoints of the moved ones.

### 4.5 Absorbed node
After everything has moved, the absorbed node has no edges. It is archived:
- `archived_at = now()`
- `properties = properties || {merged_into, merged_at}`

The label and type are kept, so the audit trail and old links still resolve.

## 5. Contacts

Let `Cs` be the contacts whose `kg_node_id` is the survivor and `Ca` those whose
`kg_node_id` is the absorbed node.

| Survivor type | Contacts plan |
|---|---|
| `person` | Everything folds into **one** contact. The surviving contact is `Cs[0]` if present; otherwise the earliest-created contact in `Ca`, re-pointed to the survivor node. Every other contact in `Cs ∪ Ca` is contact-merged into it (§6). A person node with more than one contact in `Cs` is a pre-existing inconsistency: **blocker** `survivor_multiple_contacts`. The resulting kind is `person`. A structural survivor contact (principal, agent) keeps its kind. |
| `organization` | Each contact in `Ca` is **re-pointed** to the survivor node. Kind becomes `organization`, unless the contact is structural. Contacts are not merged with each other, because several org contacts may share one org node. The preview gives the user an info line: "N contacts now link to <org>; merge duplicates on the Contacts page". |
| any other type | `Ca` must be empty, otherwise **blocker** `absorbed_has_contacts_incompatible_type`, with the message "merge in the other direction, or into a person or organization". `Cs` is left as is. |

A contact in `Ca` that would be deleted (contact-merged away) and is structural
(`isStructuralContact`) is a **blocker** `absorbed_structural_contact`.

### 5.1 Contact field conflicts (only when a contact merge happens)
- **Display name**: follows the node `label` choice, so there is no separate
  prompt. Exception: a structural survivor contact keeps its own display name.
- **Field conflicts**: `role`, `preferred_name`, `title`, `organization`,
  `primary_email`, `primary_phone`, `timezone`, `locale`, `location`,
  `pronouns`, `linkedin_url`, `bio` and `birthday`. Both values non-null and
  different is a **contact field conflict** (`survivor | absorbed`, default
  survivor). If exactly one side is non-null, it is taken.
- **No prompt; listed in the summary**:
  - `notes`: joined with `\n---\n`, which is the existing rule.
  - `tier`: the existing `computeGoldenRecord` rule (blocked on either side
    wins, otherwise the higher rank, and a structural survivor keeps its tier).
  - `contact_confidence`: max.
  - `last_seen_at`: max.
  - `inbound_message_count` and `outbound_message_count`: summed.
- **Identities**: union. Exact duplicates on `(channel, identifier)`, plus a
  case-insensitive match for email, are dropped from the absorbed side, which is
  the existing `reattachIdentities` behaviour. The preview lists every identity
  and marks the duplicates.
- **Auth overrides**: for active overrides with the same `permission` but a
  different `granted` value on each side, it is an **auth override conflict**
  (`survivor | absorbed`; the default is whichever side denies, the security-safe
  reading). If the user picks `absorbed`, the survivor's row is revoked or removed before reattach. An equal pair is a
  duplicate and the survivor's row is kept.

### 5.2 The principal and the agent
- A node that is the agent node (`properties.is_agent = 'true'`) or linked to the
  agent contact gives **blocker** `agent_node` on either side.
- If the absorbed node is the principal's node (linked to a contact with
  `system_role='principal'`), it is **blocker** `absorbed_is_principal`, and the
  preview's `suggestedDirection` says to swap.
- If the survivor is the principal's node, the merge is allowed, which is the
  case of removing a duplicate of the principal. It raises **warning**
  `principal_identity_transfer` (`requiresAck: true`), which lists every absorbed
  identity that will become a principal identity. Principal identities grant
  principal-level trust, so this needs an explicit checkbox.

## 6. Associated contact data

### 6.1 Already handled by the existing transactional helpers
`reattachIdentities`, `reattachAuthOverrides` and `reattachDedupExclusions`.

### 6.2 New: `reattachContactReferences(secondaryId, primaryId, client)`
This is a new backend method in `src/contacts`, and it runs in the merge
transaction.
- `contact_calendars`: re-point. If the primary already has an `is_primary`
  calendar, the moved rows get `is_primary=false` first.
- `grant_recommendations`: re-point, dropping the secondary's rows whose
  `permission` the primary already has.
- `conversation_resolved_entities`: re-point, deleting rows that would violate
  its unique key (check the migration-088 constraint).
- `tasks.waiting_on_contact_id`,
  `voice_sessions.caller_contact_id` and `working_memory.sender_contact_id`:
  re-point.
- `originator` JSONB `contactId` in `tasks`, `scheduled_jobs`,
  `bullpen_threads`, `secret_capture_tokens` and `pending_delegations`: run
  `jsonb_set(originator, '{contactId}', to_jsonb($primary::text))` where
  `originator->>'contactId' = $secondary`.
- It returns per-table counts, which are logged and returned in the result.

### 6.3 New: canonical attributes and counters
The contact-row merge writes the resolved canonical attributes and counters
(§5.1), not only `displayName`, `role`, `notes` and `tier`.

### 6.4 Contacts-page merge
`ContactService.mergeContacts` calls the same `reattachContactReferences` inside
its existing transaction. It also copies non-conflicting canonical attributes,
meaning those that are null on the primary and set on the secondary. This fixes
the data loss for the existing Contacts-page merge without changing its API.

### 6.5 Shared helper
Factor the transactional body of `mergeContacts` into a shared helper, for
example `mergeContactRowsInTx(client, primary, secondary, fields)`. Both the
contact merge and the node merge use it, so there is exactly one place that knows
how to fold a contact.

## 7. Execution

`NodeMergeService.apply(input)`:
1. Validate the ids (UUID, different, both exist, not archived, neither is
   `fact`). Load the snapshot without locks, compute the plan, and compare the
   token. On a mismatch return 409 `stale_preview` early.
2. Validate the resolutions against the plan:
   - unknown conflict ids give 400,
   - a missing resolution means the default,
   - every `requiresAck` warning code must be in `acknowledgements`, else 400
     `ack_required`,
   - any blocker gives 422 `blocked`.
3. If the chosen label differs from the survivor's current label, compute the
   embedding (outside the transaction).
4. Run the transaction on a single client (`BEGIN`):
   - `SELECT … FOR UPDATE` both nodes (ordered by id, to avoid deadlocks) and
     every contact in `Cs ∪ Ca`.
   - Reload the snapshot on this client, recompute the token, and on a mismatch
     roll back and return 409.
   - Execute the operations:
     1. contact merges and re-points (§5/§6), including `kg_node_id` re-points,
        which must happen before the absorbed node is archived;
     2. facts (§4.3);
     3. edges (§4.4);
     4. survivor node update (§4.1);
     5. absorbed node archive (§4.5).
   - `COMMIT`.
5. After commit:
   - `notifyIdentitiesChanged(survivingContactId)` when contacts were merged or
     the survivor contact is the principal;
   - the `onContactMerged` callback for each merged-away contact, which publishes
     the existing `contact.merged`;
   - publish **`kg.nodes_merged`** (§9).
   Failures here are logged at `error` and never undo the commit.

The node writes are new SQL that takes a `PoolClient`, under `src/kg-merge/`.
Do not route them through `KnowledgeGraphStore`/`EntityMemory` methods that use
the pool. `mergeEntities` stays as it is for its existing callers.

Known limitation (documented in the ADR): a concurrent writer that resolved the
absorbed node before the lock and inserts an edge after commit attaches it to the
tombstone. That is rare, and visible because the node is archived with
`merged_into`.

## 8. HTTP API (`src/channels/http/routes/kg.ts`, same auth and `KG_RATE`)

### `POST /api/kg/nodes/merge`
Request:
```ts
{ survivorId: string; absorbedId: string; dryRun?: boolean /* default true */;
  planToken?: string /* required when dryRun === false */;
  resolutions?: NodeMergeResolutions }
```
Responses:
- `200`: a `NodeMergePreview` when dry-run, a `NodeMergeResult` when applied.
- `400`: `{ error, code: 'invalid_request' | 'ack_required' | 'unknown_resolution' }`
- `404`: `{ error, code: 'node_not_found' }`, for a missing or archived node.
- `409`: `{ error, code: 'stale_preview' }`
- `422`: `{ error, code: 'blocked', blockers }`
- `500`: logged.

### `GET /api/kg/nodes/:id/merge-candidates?limit=8` (max 20)
Returns `{ candidates: { node: ApiKgNode, score: number, reasons: ('same_label'|'alias_match'|'similar_embedding')[] }[] }`.
- Candidates are live, non-fact nodes other than the node itself, of **any**
  type (cross-type duplicates are the point).
- A case-insensitive label or alias equality match in either direction scores
  1.0.
- Embedding cosine at or above the profile's `fuzzyAmbiguityFloor` scores the
  similarity, between vectors stamped with the live model. This is an exact scan
  over live non-fact nodes, not the HNSW index (see §14).
- The two sets are unioned and sorted by score.

### Changes to existing routes
- `GET /api/kg/nodes`: exclude archived nodes. Add `aliases` and
  `identitySource` to each node.
- `GET /api/kg/graph?node_id=` for an archived node with `merged_into` returns
  `404 { error, code: 'node_merged', mergedInto }`.

### Types
These live in `src/kg-merge/types.ts`. The console mirrors them in
`apps/console/src/pages/kg-merge-types.ts`, since there is no shared package.
```ts
type Side = 'survivor' | 'absorbed';
interface NodeMergeResolutions {
  label?: Side;
  properties?: Record<string, Side>;                     // key → side
  facts?: Record<string, Side | 'both'>;                 // fact-conflict id → choice
  nearDuplicateFacts?: Record<string, 'merge' | 'keep_both'>;
  contactFields?: Record<string, Side>;                  // field name → side
  authOverrides?: Record<string, Side>;                  // permission → side
  acknowledgements?: string[];                           // warning codes
}
interface MergeNodeSummary { id: string; label: string; type: string; aliases: string[];
  identitySource: 'label' | 'contact'; sensitivity: string; confidence: number; decayClass: string;
  lastConfirmedAt: string; factCount: number; edgeCount: number;
  contacts: { id: string; displayName: string; kind: string | null; systemRole: string | null; tier: string; identityCount: number }[]; }
interface MergeFactSummary { id: string; label: string; attribute: string | null; value: string | null;
  confidence: number; lastConfirmedAt: string; source: string; sensitivity: string; }
interface NodeMergePreview {
  dryRun: true; planToken: string;
  survivor: MergeNodeSummary; absorbed: MergeNodeSummary;
  crossType: boolean;
  suggestedDirection: { swap: boolean; reason: string | null };
  result: { type: string; labels: { survivor: string; absorbed: string }; defaultLabel: Side;
            aliases: string[]; droppedAliases: string[];   // for the default label
            sensitivity: string; confidence: number; decayClass: string; identitySource: 'label' | 'contact' };
  blockers: { code: string; message: string }[];
  warnings: { code: string; message: string; requiresAck: boolean; details?: string[] }[];
  conflicts: {
    properties: { key: string; survivorValue: unknown; absorbedValue: unknown; default: Side }[];
    facts: { id: string; attribute: string; survivor: MergeFactSummary; absorbed: MergeFactSummary; default: Side | 'both' }[];
    nearDuplicateFacts: { id: string; survivor: MergeFactSummary; absorbed: MergeFactSummary; similarity: number; default: 'merge' | 'keep_both' }[];
    contactFields: { field: string; label: string; survivorValue: string | null; absorbedValue: string | null; default: Side }[];
    authOverrides: { permission: string; survivorGranted: boolean; absorbedGranted: boolean; default: Side }[];
  };
  contactPlan: { action: 'none' | 'merge' | 'repoint'; survivingContactId: string | null;
    mergedContactIds: string[]; repointedContactIds: string[]; resultingKind: string | null;
    identities: { channel: string; identifier: string; from: Side; duplicate: boolean; verified: boolean }[] };
  summary: { factsMoved: number; factsCollapsed: number; edgesMoved: number; edgesCollapsed: number; edgesDropped: number };
}
interface NodeMergeResult {
  dryRun: false; survivorId: string; absorbedId: string; mergedAt: string;
  node: ApiKgNode;                       // the survivor after merge, same shape as GET /api/kg/nodes
  summary: NodeMergePreview['summary'] & { conflictsResolved: number; contactReferencesRepointed: number };
  contactMerge: { survivingContactId: string; mergedContactIds: string[]; repointedContactIds: string[] } | null;
  warnings: string[];
}
```
Conflict ids are deterministic. For a fact conflict, use
`fact:<survivorFactId>:<absorbedFactId>`; for a near-duplicate, `near:<s>:<a>`.
That way a re-preview with unchanged data yields the same ids.

`suggestedDirection.swap` is true (with a reason) when any of these hold:
- the absorbed node is the principal's,
- the absorbed node has contacts and the survivor's type cannot take them,
- the absorbed node is a person with a contact and the survivor is a contactless
  node of a different type. In this case the result would lose personhood, so the
  reason should say so.

## 9. Audit: `kg.nodes_merged`

- **Bus event** in `src/bus/events.ts`: payload interface, event interface,
  `BusEvent` union member, and a `createKgNodesMerged` factory.
- **Permissions**: published from the HTTP route the same way `system.ts`
  publishes `system.restart`. Add it to `publishAllowlist`/`subscribeAllowlist`
  in `src/bus/permissions.ts` to match.
- **Payload**:
  - survivor and absorbed id, type and label;
  - result label and `crossType`;
  - `contactMerge` (ids);
  - the summary counts and `conflictsResolved`;
  - the chosen resolutions;
  - the console originator from `resolveConsoleOriginator`, as `actor`;
  - `mergedAt`.
- **Field extraction** in `src/audit/field-extraction.ts`:
  `target_type='kg_node'`, `target_id=survivorId`.

## 10. Console UX (`apps/console`)

### 10.1 Entry point
The node detail drawer gets a footer with a **Merge…** button. It is hidden for
`fact` nodes. It is disabled for the agent node, with a `title` explaining why.

### 10.2 Merge dialog
`MergeNodesDialog`, built on a new generic `components/Modal.tsx`:
- `role="dialog"`, `aria-modal`, `aria-labelledby`,
- Esc and the backdrop close it,
- focus moves into the dialog on open and returns to the opener on close.

**Step 1 — Pick a node.**
- The current node is shown as a card.
- **Likely duplicates**: from `merge-candidates`, with reason chips ("Same
  name", "Alias", "Similar").
- **Search**: a debounced (250 ms) `GET /api/kg/nodes?query=`, excluding the
  current node and facts.
- Rows show a type badge, the label and up to 3 aliases. Choosing one goes to
  step 2.

**Step 2 — Review.**
- **Header**: two cards, **Keep** (survivor) ⇄ **Merge in** (absorbed), with a
  **Swap** button that re-previews.
  - The node the user started from is the survivor initially. If the preview
    says `suggestedDirection.swap`, show an inline suggestion: "Suggested: keep
    <other> instead — <reason>. [Swap]".
  - Cross-type banner: "‘Acme Summit’ (Event) will become part of ‘Acme’
    (Organization). The result is an Organization."
- **Blockers** (red): listed, and **Merge** is disabled.
- **Warnings** (amber): requires-ack warnings each get a checkbox, and Merge
  stays disabled until all are ticked. `details` render as a list, for example
  the identities becoming principal identities.
- **Name**: a radio between the two labels, with the resulting aliases (and any
  dropped aliases) shown under it.
- Conflict sections, each shown only when non-empty and each with a count:
  - **Properties**: a radio per key, showing both values (JSON-stringified when
    not a string).
  - **Conflicting facts**: a radio per conflict, showing both facts' label,
    value, confidence and last-confirmed date (`keep this one` / `keep that one`
    / `keep both`).
  - **Possible duplicate facts**: a checkbox per pair, "Combine" (default on).
  - **Contact record**: the plan sentence ("‘Jane Doe’ and ‘J. Doe’ will become
    one contact"), the field conflicts as radios, the identities list (marking
    duplicates and verified ones), and the auth-override conflicts.
- **What happens**: a plain-language summary built from `summary`, `result` and
  `contactPlan`. For example: "12 facts move · 3 duplicate facts combined · 7
  connections move · 1 duplicate connection combined · the connection between
  these two is removed · sensitivity becomes confidential".
- **Footer**: Back · Cancel · **Merge into ‘<survivor label>’** (primary). The
  label shows "(N conflicts reviewed)" when N > 0. The dialog is the
  confirmation; there is no extra `window.confirm`.

### 10.3 Apply outcomes
- **Pending**: the buttons are disabled and the Merge button shows "Merging…".
- **409 `stale_preview`**: re-preview automatically. Keep the user's choices
  whose ids still exist. Show "The graph changed while you were reviewing —
  please re-check."
- **422 / 400**: show the error and its blockers inline.
- **Success**:
  - close the dialog,
  - load the survivor's neighborhood,
  - select the survivor,
  - `syncUrl(q, survivorId)`,
  - drop the absorbed node from the sidebar list,
  - show a dismissible success banner on the page: "Merged ‘X’ into ‘Y’".

### 10.4 Deep links
A `/api/kg/graph` 404 with `code: 'node_merged'` navigates to `mergedInto` and
shows "‘X’ was merged into this node".

### 10.5 Logic lives in `apps/console/src/pages/kg-merge-utils.ts`
The console has no DOM test harness, so all logic goes in this module, with a
node-env vitest beside it:
- `defaultResolutions(preview)`
- `mergeResolutions(prev, preview)`: keeps still-valid choices after a
  re-preview
- `conflictCount(preview)`
- `missingAcknowledgements(preview, acks)`
- `canApply(preview, acks)`
- `buildApplyRequest(preview, resolutions, acks)`
- `summaryLines(preview)`
- `resultAliases(preview, label)`
- `formatValue(unknown)`
- `candidateReasonLabel(reason)`

### 10.6 Styling
Styles go in `styles/app.css`, using the existing variables and `btn` classes,
with new `modal*` and `kg-merge-*` classes. They must work in both light and dark
themes.

## 11. Code layout

```
src/kg-merge/
  types.ts            snapshot, plan, resolutions, preview, result types
  snapshot.ts         loadMergeSnapshot(queryable, survivorId, absorbedId, { forUpdate })
  planner.ts          pure: planNodeMerge(snapshot) → MergePlan; planToken(snapshot)
  resolve.ts          pure: applyResolutions(plan, resolutions) → ExecutionPlan (validation errors typed)
  executor.ts         executeMerge(client, executionPlan, deps) — all node/fact/edge SQL
  service.ts          NodeMergeService { preview, apply, candidates }
  errors.ts           NodeNotFoundError, StalePreviewError, MergeBlockedError, InvalidResolutionError
src/contacts/…        mergeContactRowsInTx helper + reattachContactReferences (+ mergeContacts uses them)
src/channels/http/routes/kg.ts   new routes; KnowledgeGraphRouteOptions gains nodeMergeService
src/channels/http/http-adapter.ts, src/index.ts   wiring
src/bus/events.ts, src/bus/permissions.ts, src/audit/field-extraction.ts
apps/console/src/components/Modal.tsx
apps/console/src/pages/kg-merge-types.ts, kg-merge-utils.ts(+test), MergeNodesDialog.tsx, KgPage.tsx edits
```

`src/kg-merge` depends on `src/memory` and `src/contacts`, never the other way
round. No migration is needed.

## 12. Tests

- **`tests/unit/kg-merge/planner.test.ts`** (pure, exhaustive). Cases:
  - label and alias rules, including overflow;
  - property conflicts and their defaults;
  - fact grouping: same-value collapse, conflicting values, shared facts,
    near-duplicates, null embeddings;
  - edges: self-loop, collapse, move;
  - the scalar rules;
  - the contact-plan matrix (person, organization, other types);
  - the principal and agent guards;
  - `suggestedDirection`;
  - deterministic token and ids.
- **`tests/unit/kg-merge/resolve.test.ts`**: defaults, unknown ids, missing
  acks, blockers, and the `previous_values` construction.
- **`tests/integration/kg-node-merge.test.ts`** (real Postgres, `describeIf(DATABASE_URL)`):
  1. person + person, each with a contact. Verify:
     - one contact and one node remain;
     - identities are unioned;
     - calendars, grant recommendations, task `waiting_on` and the
       `originator.contactId` are re-pointed;
     - facts are de-duplicated, with the conflict resolved as chosen and
       `previous_values` written;
     - edges are moved and collapsed;
     - the absorbed node is archived with `merged_into`;
     - `kg.nodes_merged` is published.
  2. event → organization (no contacts). The type is kept, and the event's edges
     and facts are on the org.
  3. organization (with an org contact) → person (with a contact). One contact
     remains, kind is `person`, and identities are unioned.
  4. person with a contact → organization. The contact is re-pointed and its
     kind becomes `organization`.
  5. Blockers:
     - the absorbed node is the principal's;
     - the agent node;
     - a fact node;
     - an event survivor whose absorbed node has contacts;
     - a label collision with a third node.
  6. A stale token gives 409 and leaves nothing changed.
  7. A failure mid-transaction (inject one) leaves nothing changed.
  8. A principal survivor without the ack gives 400; with the ack it succeeds.
- **`tests/unit/channels/http/routes/kg.test.ts`**:
  - the new routes with a fake service: dry-run default, 400/404/409/422
    mapping, auth required;
  - archived nodes excluded from `GET /nodes`;
  - `node_merged` 404 on `/graph`.
- **Contact merge**: an integration assertion that `mergeContacts` now keeps
  `contact_calendars` and `tasks.waiting_on_contact_id`.
- **`apps/console/src/pages/kg-merge-utils.test.ts`**.

## 13. Docs
- ADR-052 "Knowledge-graph node merge", with a row in the ADR README.
- Spec 12: a "Merging nodes" section.
- Spec 09: the merge now carries all contact references.
- CHANGELOG `[Unreleased]`:
  - Added: console node merge.
  - Fixed: the contact merge keeps calendars, grants and task references.

## 14. Implementation notes (deviations found while building)

- `held_messages` was dropped in migration 059, so §6.2 has nothing to re-point there.
- The executor archives the absorbed node **before** updating the survivor. Otherwise a same-type merge that takes the absorbed label would break `idx_kg_nodes_unique`, which cannot be deferred.
- `previous_values` entries are `{ value, label, confidence, source, replaced_at, reason: 'node_merge' }`. When a fact conflict is resolved to one side, the kept fact takes the max sensitivity of the pair, so a dropped value is never stored below its original level. A deleted fact node's own `previous_values` history is carried onto the kept fact, ahead of the new entry.
- `label_collision` appears in the preview as an info warning; choosing the absorbed label then fails on apply with 422 blocker `label_collision`. The console disables that option.
- A preview of a `fact` node returns 200 with blocker `fact_node`. Merge candidates for a fact node are `[]`.
- `result.contactMerge` is `null` when contacts are only re-pointed (organization survivor). The ids appear in the preview's `contactPlan` and in the audit event.
- When several folded contacts disagree and the survivor has no value, a denied auth override beats a grant (security-safe) and the earliest-created contact wins a field. A `contacts_disagree` info warning lists each case.
- Fact rows are locked `FOR UPDATE` in the locked snapshot pass, as are the entity nodes and contacts.
- Post-commit failures appear in `result.warnings`: `embedding_not_refreshed` and `audit_event_not_recorded`. The console shows them in the success banner. The contact-merged callbacks and the principal identity refresh log and swallow their own errors, so they cannot be reported.
- When the merge service is not wired, the routes return 503 `unavailable`.
- `GET /api/kg/nodes` gained `exclude_facts=true` and alias matching. Graph nodes carry `aliases` and `archived`. Merge tombstones are excluded from graph results, and the `node_merged` 404 carries the absorbed `label`.
- **QA follow-up (2026-10-22, PR #2238):**
  - **Contacts as peers:** only a contact already on the survivor node anchors the "survivor" side. When the survivor node has no contact, every folded contact is a peer: the earliest-created contact wins each field, a deny beats a grant, and a `contacts_disagree` line records each case. A real survivor-vs-absorbed auth-override conflict defaults to the side that denies.
  - **Dropped third values:** a value from a third contact that a two-way field conflict cannot offer gets a `contacts_disagree` line saying it will be dropped.
  - **Chained fact operations:** fact operations forward through chains. A deleted fact passes the history, sensitivity and (for duplicates) confidence and confirmation time it had gathered to the fact it was folded into.
  - **Contact merge locking:** the shared contact fold locks both contact rows `FOR UPDATE` and computes counters from the locked rows. It also refuses a structural secondary itself. One `survivingTier` rule now serves both merge paths.
  - **Alias options:** `result.aliasOptions` gives the server-computed aliases for each label choice, so the console no longer re-implements the alias rule.
  - **Principal audit:** `kg.nodes_merged` records `principalIdentitiesTransferred` and `principalPrimaryFieldsFilled`. The acknowledgement details list any primary email or phone that will be filled.
  - **Archived nodes:** `GET /api/kg/nodes` hides only merge tombstones, as `/graph` does, and carries `archived`.
  - **Schema guard:** `tests/integration/kg-merge-schema-guard.test.ts` fails when a new foreign key to `contacts` or `kg_nodes` is not handled by the merge.
- **Rebased onto per-model embeddings (#2225, ADR-051):**
  - The ADR is now ADR-052; #2225 took 051.
  - A renamed survivor is embedded with the `document` purpose. Its vector is written together with `embedding_model`, as migration 103's CHECK requires, and is checked against the profile's width.
  - Near-duplicate facts use the profile's `factDedup` threshold and compare only vectors stamped with the live model. The settings are part of the plan token.
  - Embedding candidates use the profile's `fuzzyAmbiguityFloor`, about where entity resolution starts asking, and compare only vectors from the live model. The old fixed 0.80 matched no calibrated value.
  - The merge service gets the embedding service only when the knowledge graph's boot gate passed. Without it, merges still run: a rename keeps the old vector with a warning, and no near-duplicate facts or embedding candidates are offered.
- **Second CodeRabbit pass (2026-10-22):**
  - A deleted fact's live edges to nodes other than the two being merged move to the fact it was folded into, before the delete would cascade them. One that would duplicate an edge that fact keeps, or join it to itself, is dropped. The snapshot loads and locks these edges, and the executor refuses to delete a fact that still has any edge but its links to the merge nodes. No writer creates such edges today; the schema allows them.
  - Property keys, permission names and request keys are read and written as own properties, so `constructor` or `__proto__` behave like any other key.
- **Merge candidates use an exact scan (JustWork #13, 2026-10-22):** `idx_kg_nodes_embedding` covers every node, and an HNSW scan returns its `hnsw.ef_search` (40) nearest before `type <> 'fact'` is applied. Facts often name their entity, and when 40 of them sit closer than a duplicate, they fill all 40. With synthetic vectors on the test database, 60 facts at cosine 0.95 hid a duplicate at 0.85 in 6 of 6 runs; how often real facts outrank a duplicate depends on the model and has not been measured. Iterative index scans and a larger `ef_search` only lowered the miss rate. The query now orders by the computed similarity, which keeps the index out. It runs once per merge dialog, over live non-fact nodes only. `KnowledgeGraphStore.semanticSearch` has the same pattern with a type filter; that is tracked separately.
