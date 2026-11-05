// export-validate.ts — checks what the Mac mini's Matrix exporter sends. Strict: unknown fields are refused, so message
// text or ids cannot ride along by accident. Counts, a display name, a phone, two dates per partner. Nothing else.

import { BRIDGES } from './bridges.js';
import type { RoomFacts, MemberFact } from './export-store.js';

export const MAX_ROOMS_PER_POST = 50;
export const MAX_MEMBERS_PER_ROOM = 500;
const MAX_COUNT = 10_000_000;
const NETWORKS: readonly string[] = BRIDGES.map((b) => b.id);
const ROOM_KEYS = new Set(['roomHash', 'network', 'members']);
const MEMBER_KEYS = new Set(['ghostId', 'displayName', 'phone', 'fromThem', 'fromMe', 'firstSeen', 'lastSeen']);
const HASH_RX = /^[0-9a-f]{16}$/;
const GHOST_RX = /^[A-Za-z0-9._=+/-]{1,128}$/;
const PHONE_RX = /^\+[1-9][0-9]{6,14}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;
const isDate = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/** The rooms, or a short reason the body is refused (never an echo of the body). */
export function parseRooms(body: unknown): { ok: true; rooms: RoomFacts[] } | { ok: false; error: string } {
  if (!isObj(body) || !Array.isArray(body['rooms'])) return { ok: false, error: 'rooms must be a list' };
  const rooms = body['rooms'] as unknown[];
  if (rooms.length === 0 || rooms.length > MAX_ROOMS_PER_POST) return { ok: false, error: `send 1 to ${MAX_ROOMS_PER_POST} rooms per request` };
  const out: RoomFacts[] = [];
  for (const r of rooms) {
    if (!isObj(r) || Object.keys(r).some((k) => !ROOM_KEYS.has(k))) return { ok: false, error: 'a room has a field that is not allowed' };
    if (typeof r['roomHash'] !== 'string' || !HASH_RX.test(r['roomHash'])) return { ok: false, error: 'roomHash must be 16 hex characters (a hash, never a room id)' };
    if (typeof r['network'] !== 'string' || !NETWORKS.includes(r['network'])) return { ok: false, error: 'unknown network' };
    if (!Array.isArray(r['members']) || r['members'].length > MAX_MEMBERS_PER_ROOM) return { ok: false, error: 'members must be a list of at most 500' };
    const members: MemberFact[] = [];
    for (const m of r['members'] as unknown[]) {
      if (!isObj(m) || Object.keys(m).some((k) => !MEMBER_KEYS.has(k))) return { ok: false, error: 'a member has a field that is not allowed' };
      if (typeof m['ghostId'] !== 'string' || !GHOST_RX.test(m['ghostId'])) return { ok: false, error: 'ghostId is malformed' };
      if (!isCount(m['fromThem']) || !isCount(m['fromMe'])) return { ok: false, error: 'fromThem and fromMe must be counts' };
      if (m['displayName'] !== undefined && (typeof m['displayName'] !== 'string' || m['displayName'].length > 200)) return { ok: false, error: 'displayName is malformed' };
      if (m['phone'] !== undefined && (typeof m['phone'] !== 'string' || !PHONE_RX.test(m['phone']))) return { ok: false, error: 'phone must be E.164' };
      if ((m['firstSeen'] !== undefined && !isDate(m['firstSeen'])) || (m['lastSeen'] !== undefined && !isDate(m['lastSeen']))) return { ok: false, error: 'dates must be ISO-8601' };
      members.push({
        ghostId: m['ghostId'], fromThem: m['fromThem'], fromMe: m['fromMe'],
        ...(typeof m['displayName'] === 'string' ? { displayName: m['displayName'] } : {}),
        ...(typeof m['phone'] === 'string' ? { phone: m['phone'] } : {}),
        ...(typeof m['firstSeen'] === 'string' ? { firstSeen: m['firstSeen'] } : {}),
        ...(typeof m['lastSeen'] === 'string' ? { lastSeen: m['lastSeen'] } : {}),
      });
    }
    out.push({ roomHash: r['roomHash'], network: r['network'], members });
  }
  return { ok: true, rooms: out };
}
