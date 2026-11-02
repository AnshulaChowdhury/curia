# ADR-059: The accounting rules graph lives on the books Mac mini; Curia holds a read-only pushed snapshot

Date: 2026-11-02
Status: Accepted

## Context

The books system keeps its accounting rules as files in the `mowmowaccounting` repo (reviewed in git) and loads them into an Oxigraph graph on the books Mac mini, where the SHACL shapes and consistency checks run. Anshula wants to see those rules on Curia's Knowledge Graph page: pick the accounting graph and see the rules, accounts, tax codes, locations, classes and payees drawn as nodes and edges.

Where should the graph live, and how does the page get it? Alternatives:

- **Curia queries the Mac mini's Oxigraph directly.** It would show live data, but it needs an inbound path from Railway to a machine on a home network, or an exposed port, and makes the page depend on that machine being up. The books Mac mini accepts no inbound connections (it only calls out).
- **Curia holds the graph itself** (a second triple store, or the rules in Postgres). That duplicates the source of truth, and the rule files, shapes and checks would live in two places that can drift.
- **The Mac mini pushes a snapshot; Curia stores the latest and serves it.** The graph, shapes and checks stay where the rule files are; Curia needs no new store technology and no path into the Mac mini.

The graph view is for looking, not for editing: rules are changed by pull request on the rule files, and a proposed rule is approved on the Books page.

## Decision

The graph stays on the Mac mini. After a rule change and nightly, the Mac mini sends a **snapshot** to `POST /books/graph` using the books token. Curia validates it strictly (known fields only, bounded sizes, every edge pointing at a real node), keeps **only the latest** in a one-row table (`books_graph_snapshot`), and serves it to signed-in users at `GET /api/books/graph`.

The snapshot holds rules, accounts, tax codes, locations, classes and payees. It never holds transactions, amounts or bank descriptions. It uses the node and edge shape `GET /api/kg/graph` already returns, so the page reuses the xyflow node and edge components and the d3-force layout from ADR-058.

The Knowledge Graph page gets a **second, selectable graph**: a control in the page header switches between Memory (the existing graph, unchanged) and Accounting (`/kg?graph=accounting`). The Accounting view is read-only: it has a text filter, a type filter, a detail panel showing a node's fields as plain text, and an empty state until the first snapshot arrives. Rule status is shown (confirmed, proposed with a dashed outline, retired struck through).

## Consequences

- The page shows the graph as of the last snapshot, not live. The received-at and generated-at times are shown so staleness is visible, and the page says so when no snapshot has arrived.
- If the Mac mini is down, the page still works; it just stops updating. The missing-run and heartbeat alerts cover the Mac mini being down.
- A bad or hostile snapshot cannot do more than be refused: the endpoint needs the books token, rejects anything outside the known shape, and everything in it is rendered as text. A snapshot is replaced wholesale, so there is nothing to migrate or merge.
- The snapshot format is a contract between the exporter (`books/graph/export.py` in `mowmowaccounting`) and `src/books/graph-store.ts`. Both reject or ignore nothing silently: an unknown field fails the push with a message the sender logs.
- Edits to rules are not possible from this page. That is deliberate for now; if it changes, it is a new decision.
