# ADR-058: Draw the Knowledge Graph view with xyflow, laid out by d3-force in a Web Worker

Date: 2026-11-01
Status: Accepted

## Context

The console's Knowledge Graph page (`apps/console/src/pages/KgPage.tsx`, spec 12) drew the graph with Cytoscape.js and the fCoSE layout. Nobody chose Cytoscape for the console. The first explorer was a standalone Cytoscape page served from `node_modules`, and #780 ported it into the React console unchanged. No ADR recorded the choice.

Two problems followed from that:

- **The graph ignored the theme.** Cytoscape draws on a `<canvas>` from its own JavaScript stylesheet, so node, label, outline and edge colours were hex literals. The console's light and dark themes, and the Moonray palette, never reached the graph.
- **Nodes could only be dots with labels.** Anything richer, such as a type badge on a node, meant fighting Cytoscape's styling model.

**[xyflow](https://xyflow.com) (React Flow)** renders each node as a React component styled with ordinary CSS, so it follows the theme. It has two known costs:

1. **No automatic layout.** Positions have to come from somewhere else.
2. **Each node is a DOM element**, so cost grows with node count. The usual bottleneck is running a force simulation in React state: every tick re-renders every node.

How many nodes are on the canvas matters. The page never loads the whole graph. It opens on a neighbourhood (the principal's node at depth 2, or 20 recent nodes) and grows one hop per click. That is tens to low hundreds of nodes in normal use. Once all data is imported, a long expansion session could reach about a thousand.

Alternatives considered:

- **Keep Cytoscape and read colours from CSS variables at runtime.** It is the smallest change and scales well on canvas. It fixes the colours but keeps the dot-only nodes and a styling system separate from the rest of the console.
- **sigma.js (WebGL).** It is built for tens of thousands of nodes and suits a whole-graph overview. The page has no such view and is not getting one, so its strengths don't apply, and it has the same separate-styling problem as Cytoscape.
- **xyflow with the layout on the main thread.** It is the simplest xyflow setup and the version that stutters at scale.

## Decision

Draw the graph with **xyflow** (`@xyflow/react`), and lay it out with **d3-force running in a Web Worker**. Keep the page's behaviour the same: search, filters, colour-by modes, neighbourhood loading, click to expand, double-click to zoom, the detail drawer, and node merge.

To make xyflow cope with large neighbourhoods, three measures are mandatory:

1. **Layout off the main thread** (`kg-layout.ts`, `kg-layout.worker.ts`, `kg-layout-client.ts`).
   - The page sends one request per render or expansion, and the worker returns every node's final position in one message. The simulation never ticks through React.
   - Expansion warm-starts from the current positions, with new nodes placed beside the node that was clicked.
   - Each request carries a sequence number, so a slow answer to an older request is dropped.
   - If a worker cannot start, or crashes, the same code runs on the main thread.
   - The forces carry over the fCoSE tuning: facts close to their entity, strong relationships tighter, springs weakened by low confidence and fast decay, more repulsion for hub types, a label-wide collision radius and weak gravity.
2. **Fewer details when zoomed out** (`kg-graph-view.tsx`).
   - Below zoom 0.75, node and edge labels are hidden.
   - One component watches the zoom level and toggles a single class on the canvas, so zooming re-renders no nodes.
3. **Cheap nodes and edges** (`kg-graph-view.tsx`, `kg-graph-model.ts`).
   - Node and edge components are memoised, and `nodeTypes`/`edgeTypes` are defined at module scope.
   - When the page redraws, nodes whose appearance didn't change keep the same object, so their components don't re-render (`buildFlow`'s cache).
   - Edges are straight, with one shared arrowhead and no animation.
   - Node CSS uses plain fills and borders: no shadows, filters or `backdrop-filter`.
   - xyflow's selection, connection and delete handling are off; the page decides what is selected.

While the page waits on the server or the layout, the Moonray loader (`AnimatedMoonrayMark`) shows: centred over the canvas for a load, small in the corner for an expansion, and at the top of the search results. It fades in after 150 ms, so quick answers never flash it, and it never blocks the canvas.

Filtering still hides nodes rather than removing them. Filtered nodes, and every edge touching them, get xyflow's `hidden`, and they still count in the status line and the filter checklists. Graph colours are CSS variables and classes in `app.css`, so they follow the theme.

`onlyRenderVisibleElements` (drawing only what is on screen) is deliberately not used yet. It helps only when zoomed in, and the zoomed-out view is handled by measure 2. Try it if profiling shows panning while zoomed in is slow.

## Consequences

- **Easier:** the graph follows the console theme. Nodes are React components, so richer nodes (badges, icons) are ordinary JSX and CSS. The logic is unit-tested without a browser (`kg-layout.test.ts`, `kg-graph-model.test.ts`). The KG page's script is smaller: 248 kB (78.5 kB gzipped) against 613 kB (186 kB gzipped), plus a 16 kB worker.
- **Layout time is the remaining cost.** Measured on synthetic graphs in Node, after warm-up, a full layout takes about 0.2 s at 200 nodes and 1.2 s at 1,000. It runs in the worker, so the page stays responsive, but at the top end the new graph appears after about a second.
- **Expansion no longer animates.** fCoSE eased nodes to their new places over 400 ms. Here the new positions are applied in one step. Animating them would mean either per-frame React updates (the cost this ADR avoids) or CSS transitions that move nodes while their edges jump. Revisit if the jump proves disorienting.
- **Dependencies:** `@xyflow/react` and `d3-force` (+ `@types/d3-force`) are added to the console. `cytoscape`, `cytoscape-fcose`, `cose-base` and `layout-base` are removed from the root package.
- **xyflow's attribution link** shows in the canvas corner. Hiding it is allowed under its MIT licence, but xyflow asks unpaid users to keep it, so it stays.
- **Not addressed:** a whole-graph overview. If one is wanted, it should be a separate canvas or WebGL view (Cytoscape or sigma.js) that opens nodes in this explorer, not a larger xyflow canvas. Folding fact nodes into their entity is also left for later. It would shrink every view, whatever renders it.
