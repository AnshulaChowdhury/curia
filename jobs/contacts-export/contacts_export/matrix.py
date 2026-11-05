"""Read-only Matrix client-server calls. Only joined rooms, member names and message senders/timestamps are used."""
import json
import urllib.parse

from . import httpjson
from .reduce import MAX_ROOM_MEMBERS, RoomCounter, parse_ghost

PAGE = 100
MAX_PAGES_PER_ROOM = 5000


class Matrix:
    def __init__(self, base_url, token, sleep=None):
        self.base = base_url + "/_matrix/client/v3"
        self.token = token
        self._kw = {"sleep": sleep} if sleep else {}

    def _get(self, path, where):
        return httpjson.request("GET", self.base + path, self.token, where=where, **self._kw)[1]

    def whoami(self):
        return self._get("/account/whoami", "matrix whoami")["user_id"]

    def joined_rooms(self):
        return self._get("/joined_rooms", "matrix joined_rooms").get("joined_rooms", [])

    def member_names(self, room_id):
        """{(network, id): display name} for bridged partners, and the number of joined members."""
        joined = self._get("/rooms/%s/joined_members" % urllib.parse.quote(room_id, safe=""), "matrix members").get("joined", {})
        names = {}
        for user_id, info in joined.items():
            ghost = parse_ghost(user_id)
            if ghost:
                names[ghost] = (info or {}).get("display_name") or ""
        return names, len(joined)

    def count_room(self, room_id, my_user_id, since_ms):
        """Walks the room backwards, counting senders; stops at the window start. Returns (RoomCounter, names) or None to skip."""
        names, size = self.member_names(room_id)
        if not names or size > MAX_ROOM_MEMBERS:
            return None
        counter = RoomCounter(my_user_id, since_ms)
        flt = urllib.parse.quote(json.dumps({"types": ["m.room.message"]}))
        token = None
        for _ in range(MAX_PAGES_PER_ROOM):
            path = "/rooms/%s/messages?dir=b&limit=%d&filter=%s" % (urllib.parse.quote(room_id, safe=""), PAGE, flt)
            if token:
                path += "&from=" + urllib.parse.quote(token)
            page = self._get(path, "matrix messages")
            for event in page.get("chunk", []):
                counter.add(event)
            token = page.get("end")
            if not token or not page.get("chunk") or counter.reached_window_start():
                break
        return counter, names
