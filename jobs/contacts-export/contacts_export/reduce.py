"""Pure logic: recognise bridge partners and turn message events into counts. No I/O, and message content is never read."""
import hashlib
import re
from datetime import datetime, timezone

# mautrix bridges name each remote person "@<network>_<id>:<server>". Bridge bots have no underscore ("whatsappbot").
NETWORKS = ("whatsapp", "gmessages", "signal", "instagram")
GHOST_RX = re.compile(r"^@(" + "|".join(NETWORKS) + r")_([A-Za-z0-9._=+/-]{1,128}):")
PHONE_DIGITS_RX = re.compile(r"^[0-9]{7,15}$")
MAX_ROOM_MEMBERS = 50  # bigger groups are noise, not conversations


def room_hash(room_id):
    return hashlib.sha256(room_id.encode()).hexdigest()[:16]


def parse_ghost(user_id):
    """('whatsapp', '14155550142') for a bridged partner, else None."""
    m = GHOST_RX.match(user_id or "")
    return (m.group(1), m.group(2)) if m else None


def phone_of(network, ghost_id):
    return "+" + ghost_id if network == "whatsapp" and PHONE_DIGITS_RX.match(ghost_id) else None


def iso(ts_ms):
    return datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class RoomCounter:
    """Counts message events for one room. Reads only `sender` and `origin_server_ts`."""

    def __init__(self, my_user_id, since_ms):
        self.me = my_user_id
        self.since_ms = since_ms
        self.members = {}  # ghost key -> {fromThem, fromMe, first, last}
        self.from_me = 0
        self.first_me = None
        self.last_me = None
        self.oldest_ms = None

    def add(self, event):
        if event.get("type") != "m.room.message":
            return
        ts = event.get("origin_server_ts")
        sender = event.get("sender")
        if not isinstance(ts, int) or not isinstance(sender, str):
            return
        self.oldest_ms = ts if self.oldest_ms is None else min(self.oldest_ms, ts)
        if ts < self.since_ms:
            return
        if sender == self.me:
            self.from_me += 1
            self.first_me = ts if self.first_me is None else min(self.first_me, ts)
            self.last_me = ts if self.last_me is None else max(self.last_me, ts)
            return
        ghost = parse_ghost(sender)
        if ghost is None:
            return
        row = self.members.setdefault(ghost, {"fromThem": 0, "first": ts, "last": ts})
        row["fromThem"] += 1
        row["first"] = min(row["first"], ts)
        row["last"] = max(row["last"], ts)

    def reached_window_start(self):
        return self.oldest_ms is not None and self.oldest_ms < self.since_ms

    def result(self, names):
        """Members payload. In a one-to-one chat every message from me is credited to the partner; in a group, to none."""
        out = []
        keys = sorted(self.members)
        for key in keys:
            network, ghost_id = key
            row = self.members[key]
            first, last = row["first"], row["last"]
            mine = self.from_me if len(keys) == 1 else 0
            if mine:
                first = min(first, self.first_me)
                last = max(last, self.last_me)
            item = {"ghostId": ghost_id, "fromThem": row["fromThem"], "fromMe": mine, "firstSeen": iso(first), "lastSeen": iso(last)}
            name = names.get(key)
            if name and "@" not in name:
                item["displayName"] = name[:200]
            phone = phone_of(network, ghost_id)
            if phone:
                item["phone"] = phone
            out.append(item)
        return out
