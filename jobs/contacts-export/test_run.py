import unittest

from contacts_export.config import Config, ConfigError
from contacts_export.httpjson import HttpError
from contacts_export.reduce import RoomCounter, room_hash
from contacts_export.run import run_once

ME = "@me:x"


class FakeCuria:
    def __init__(self, request):
        self.request, self.posted, self.finished = request, [], None

    def run_request(self):
        return self.request

    def post_rooms(self, run_id, rooms):
        self.posted.append((run_id, rooms))

    def finish(self, run_id, status, kind=None):
        self.finished = (run_id, status, kind)

    def post_log(self, run_id, lines):
        self.logged = getattr(self, "logged", []) + lines


class FakeMatrix:
    def __init__(self, rooms, fail_on=None):
        self.rooms, self.fail_on, self.counted = rooms, fail_on, []

    def whoami(self):
        return ME

    def joined_rooms(self):
        return list(self.rooms)

    def peek(self, room_id):
        return [(ev[0], "") for ev in self.rooms[room_id]][:3]

    def count_room(self, room_id, me, since_ms):
        self.counted.append(room_id)
        if room_id == self.fail_on:
            raise HttpError(500, "matrix")
        c = RoomCounter(me, 0)
        for ev in self.rooms[room_id]:
            c.add({"type": "m.room.message", "sender": ev[0], "origin_server_ts": ev[1]})
        return (c, {}) if c.members else None


class RunTests(unittest.TestCase):
    def test_idle_when_nothing_is_requested(self):
        self.assertEqual(run_once(FakeCuria(None), FakeMatrix({}), log=lambda *_: None), "idle")

    def test_counts_rooms_skips_done_ones_and_finishes(self):
        rooms = {"!a:x": [("@whatsapp_14155550142:x", 1000), (ME, 2000)], "!b:x": [("@dana:x", 1)], "!done:x": [("@signal_z:x", 1)]}
        curia = FakeCuria({"runId": "exp-1-aaaaaaaa", "since": "2016-01-01T00:00:00Z", "doneRooms": [room_hash("!done:x")]})
        matrix = FakeMatrix(rooms)
        self.assertEqual(run_once(curia, matrix, log=lambda *_: None), "done")
        self.assertNotIn("!done:x", matrix.counted)
        sent = [r for _, batch in curia.posted for r in batch]
        self.assertEqual(len(sent), 2)  # the unbridged room is still recorded as done, with no members
        by = {r["roomHash"]: r for r in sent}
        self.assertEqual(by[room_hash("!a:x")]["members"][0]["fromMe"], 1)
        self.assertEqual(by[room_hash("!b:x")]["members"], [])
        self.assertEqual(curia.finished, ("exp-1-aaaaaaaa", "done", None))

    def test_a_matrix_failure_reports_failed_and_keeps_what_was_sent(self):
        rooms = {"!a:x": [("@signal_a:x", 1)], "!boom:x": [("@signal_b:x", 1)]}
        curia = FakeCuria({"runId": "exp-1-aaaaaaaa", "since": "2016-01-01T00:00:00Z", "doneRooms": []})
        self.assertEqual(run_once(curia, FakeMatrix(rooms, fail_on="!boom:x"), log=lambda *_: None), "failed")
        self.assertEqual(curia.finished, ("exp-1-aaaaaaaa", "failed", "http_500"))

    def test_the_log_names_partners_and_lists_skipped_chats_but_never_message_text(self):
        rooms = {"!a:x": [("@whatsapp_14155550142:x", 1000), (ME, 2000)], "!b:x": [("@dana:x", 1)]}
        curia = FakeCuria({"runId": "exp-1-aaaaaaaa", "since": "2016-01-01T00:00:00Z", "doneRooms": []})
        run_once(curia, FakeMatrix(rooms), log=lambda *_: None)
        text = "\n".join(l["message"] for l in curia.logged)
        self.assertIn("counted !a:x [whatsapp]", text)
        self.assertIn("+14155550142", text)  # phone shown in the log, as the owner asked
        self.assertIn("skipped !b:x: @dana:x", text)  # shows how the unmatched account is named
        self.assertIn("run finished", text)

    def test_an_unexpected_error_still_closes_the_run(self):
        class Boom(FakeMatrix):
            def whoami(self):
                raise ValueError("bad json")
        curia = FakeCuria({"runId": "exp-1-aaaaaaaa", "since": None, "doneRooms": []})
        self.assertEqual(run_once(curia, Boom({}), log=lambda *_: None), "failed")
        self.assertEqual(curia.finished, ("exp-1-aaaaaaaa", "failed", "ValueError"))

    def test_config_requires_every_setting_and_http_urls(self):
        with self.assertRaises(ConfigError):
            Config({})
        env = {"CONTACTS_API_TOKEN": "t" * 30, "CURIA_URL": "curia.example", "MATRIX_ACCESS_TOKEN": "m" * 30, "MATRIX_HOMESERVER_URL": "https://m.example"}
        with self.assertRaises(ConfigError):
            Config(env)
        env["CURIA_URL"] = "https://curia.example/"
        self.assertEqual(Config(env).curia_url, "https://curia.example")


if __name__ == "__main__":
    unittest.main()
