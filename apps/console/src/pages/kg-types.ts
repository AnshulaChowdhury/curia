// Shared knowledge-graph types and badge maps for the KG explorer and the
// node-merge dialog. Mirrors the node shape served by GET /api/kg/nodes and
// GET /api/kg/graph (src/channels/http/routes/kg.ts).

export interface ApiKgNode {
  id: string;
  label: string;
  type: string;
  confidence: number;
  decayClass: string;
  sensitivity: string;
  properties: Record<string, unknown>;
  source: string;
  createdAt: string;
  lastConfirmedAt: string;
  // Served by GET /api/kg/nodes (and the merge endpoints) since the node-merge
  // work; absent from GET /api/kg/graph payloads, hence optional.
  aliases?: string[];
  identitySource?: 'label' | 'contact';
}

// Badge CSS classes for node type.
export const TYPE_BADGE: Record<string, string> = {
  person:       'badge badge-kg-person',
  organization: 'badge badge-kg-organization',
  project:      'badge badge-kg-project',
  decision:     'badge badge-kg-decision',
  event:        'badge badge-kg-event',
  concept:      'badge badge-kg-concept',
  fact:         'badge badge-kg-fact',
};

// Badge CSS classes for sensitivity level.
export const SENS_BADGE: Record<string, string> = {
  public:       'badge badge-kg-public',
  internal:     'badge badge-kg-internal',
  confidential: 'badge badge-kg-confidential',
  restricted:   'badge badge-kg-restricted',
};

export function typeBadgeClass(type: string): string {
  return TYPE_BADGE[type] ?? 'badge badge-kg-fact';
}

export function sensitivityBadgeClass(sensitivity: string): string {
  return SENS_BADGE[sensitivity] ?? 'badge badge-kg-internal';
}
