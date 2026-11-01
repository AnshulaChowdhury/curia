// xyflow node and edge components for the Knowledge Graph canvas (ADR-058).
//
// Kept cheap because a canvas can hold hundreds of them: memoised (KgPage reuses the same
// node objects when nothing changed, so most skip re-rendering), plain CSS with no shadows
// or filters, straight edges, and no per-node store subscriptions. The zoomed-out view
// (labels hidden) is one class on the canvas, toggled by <ZoomLevelClass>, so zooming
// re-renders no nodes at all.

import { memo, useEffect } from 'react';
import type { RefObject } from 'react';
import { BaseEdge, Handle, Position, useStore } from '@xyflow/react';
import type { EdgeProps, EdgeTypes, NodeProps, NodeTypes } from '@xyflow/react';
import type { KgFlowEdge, KgFlowNode } from './kg-graph-model.js';

/** Below this zoom the canvas switches to dots only: no node or edge labels. */
export const LOD_ZOOM = 0.6;

const KgGraphNode = memo(function KgGraphNode({ data, selected }: NodeProps<KgFlowNode>) {
  const cls = ['kg-gnode', data.colorClass];
  if (data.isFact) cls.push('is-fact');
  if (data.focal) cls.push('is-focal');
  if (selected) cls.push('is-selected');
  return (
    <div className={cls.join(' ')} style={{ width: data.size, height: data.size, opacity: data.opacity }}>
      {/* Edges attach at the centre (see .kg-gnode-handle); KgGraphEdge trims them to the rim. */}
      <Handle type="target" position={Position.Top} isConnectable={false} className="kg-gnode-handle" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="kg-gnode-handle" />
      <span className="kg-gnode-label">{data.label}</span>
    </div>
  );
});

const KgGraphEdge = memo(function KgGraphEdge({
  id, sourceX, sourceY, targetX, targetY, data, markerEnd, style,
}: EdgeProps<KgFlowEdge>) {
  const dx = targetX - sourceX, dy = targetY - sourceY;
  const len = Math.hypot(dx, dy);
  const sr = data?.sourceR ?? 0, tr = (data?.targetR ?? 0) + 2; // +2 so the arrow tip clears the rim
  if (len <= sr + tr) return null; // overlapping nodes: nothing visible to draw
  const ux = dx / len, uy = dy / len;
  const x1 = sourceX + ux * sr, y1 = sourceY + uy * sr;
  const x2 = targetX - ux * tr, y2 = targetY - uy * tr;
  return (
    <BaseEdge
      id={id}
      path={`M ${x1},${y1} L ${x2},${y2}`}
      markerEnd={markerEnd}
      style={style}
      label={data?.label}
      labelX={(x1 + x2) / 2}
      labelY={(y1 + y2) / 2}
      labelShowBg={false}
    />
  );
});

// Module scope: xyflow re-creates every node if these objects change identity.
export const KG_NODE_TYPES: NodeTypes = { kg: KgGraphNode };
export const KG_EDGE_TYPES: EdgeTypes = { kg: KgGraphEdge };

/** Toggles `is-zoomed-out` on the canvas element when the zoom crosses LOD_ZOOM. */
export function ZoomLevelClass({ target }: { target: RefObject<HTMLElement | null> }) {
  const zoomedOut = useStore(s => s.transform[2] < LOD_ZOOM);
  useEffect(() => {
    target.current?.classList.toggle('is-zoomed-out', zoomedOut);
  }, [zoomedOut, target]);
  return null;
}
