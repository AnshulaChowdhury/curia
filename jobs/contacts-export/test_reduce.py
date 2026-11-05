import unittest

from contacts_export.reduce import RoomCounter, parse_ghost, phone_of, room_hash

ME = "@me:example.org"


def ev(sender, ts, body="SECRET TEXT", kind="m.room.message"):
    return {"type": kind, "sender": sender, "origin_server_ts": ts, "content": {"body": body}}


class ReduceTests(unittest.TestCase):
    def test_recognises_bridge_partners_not_bots_or_people(self):
        self.assertEqual(parse_ghost("@whatsapp_14155550142:example.org"), ("whatsapp", "14155550142"))
        self.assertEqual(parse_ghost("@signal_ab12-cd:example.org"), ("signal", "ab12-cd"))
        self.assertIsNone(parse_ghost("@whatsappbot:example.org"))
        self.assertIsNone(parse_ghost("@dana:example.org"))

    def test_phone_only_for_whatsapp_numbers(self):
        self.assertEqual(phone_of("whatsapp", "14155550142"), "+14155550142")
        self.assertIsNone(phone_of("whatsapp", "abc"))
        self.assertIsNone(phone_of("signal", "14155550142"))

    def test_room_hash_is_a_stable_16_hex_digest_that_hides_the_room_id(self):
        h = room_hash("!abc:example.org")
        self.assertRegex(h, r"^[0-9a-f]{16}$")
        self.assertEqual(h, room_hash("!abc:example.org"))

    def test_one_to_one_chat_credits_my_messages_to_the_partner(self):
        c = RoomCounter(ME, 0)
        for e in [ev("@whatsapp_14155550142:x", 1000), ev("@whatsapp_14155550142:x", 3000), ev(ME, 2000), ev(ME, 4000)]:
            c.add(e)
        [m] = c.result({("whatsapp", "14155550142"): "Dana Smith"})
        self.assertEqual((m["fromThem"], m["fromMe"]), (2, 2))
        self.assertEqual(m["firstSeen"], "1970-01-01T00:00:01Z")
        self.assertEqual(m["lastSeen"], "1970-01-01T00:00:04Z")
        self.assertEqual(m["displayName"], "Dana Smith")
        self.assertEqual(m["phone"], "+14155550142")

    def test_group_chat_does_not_credit_my_messages_to_anyone(self):
        c = RoomCounter(ME, 0)
        for e in [ev("@signal_a:x", 1), ev("@signal_b:x", 2), ev(ME, 3)]:
            c.add(e)
        self.assertEqual([m["fromMe"] for m in c.result({})], [0, 0])

    def test_ignores_non_messages_old_messages_and_people_who_are_not_bridged(self):
        c = RoomCounter(ME, 5000)
        for e in [ev("@signal_a:x", 4000), ev("@signal_a:x", 6000), ev("@signal_a:x", 7000, kind="m.reaction"), ev("@dana:x", 6000)]:
            c.add(e)
        [m] = c.result({})
        self.assertEqual(m["fromThem"], 1)
        self.assertTrue(c.reached_window_start())

    def test_output_never_contains_message_text(self):
        c = RoomCounter(ME, 0)
        c.add(ev("@signal_a:x", 1, body="my password is hunter2"))
        self.assertNotIn("hunter2", repr(c.result({})))

    def test_an_address_is_not_used_as_a_name(self):
        c = RoomCounter(ME, 0)
        c.add(ev("@signal_a:x", 1))
        [m] = c.result({("signal", "a"): "dana@example.com"})
        self.assertNotIn("displayName", m)


if __name__ == "__main__":
    unittest.main()
