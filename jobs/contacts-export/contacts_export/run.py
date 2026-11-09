"""One pass: ask Curia whether a run is wanted; if so count every chat room not yet done and send the counts."""
import re
import sys
from datetime import datetime

from .config import Config, ConfigError
from .curia import Curia
from .httpjson import HttpError
from .matrix import Matrix
from .reduce import room_hash
from .runlog import RunLog

BATCH_ROOMS = 10


def parse_since_ms(since):
    return int(datetime.strptime(since[:19], "%Y-%m-%dT%H:%M:%S").timestamp() * 1000) if since else 0


MAX_SKIP_LINES = 15  # skipped chats whose members are listed, to show how the bridge accounts are really named


def _member_line(m):
    who = m.get("displayName") or m["ghostId"]
    ident = m.get("phone") or m["ghostId"]
    return "%s %s (they %d, you %d)" % (who, ident, m["fromThem"], m["fromMe"])


def run_once(curia, matrix, log=print):
    req = curia.run_request()
    if not req:
        log("no run requested")
        return "idle"
    run_id, since_ms = req["runId"], parse_since_ms(req.get("since"))
    done = set(req.get("doneRooms", []))
    rl = RunLog(curia, run_id, echo=log)
    rl.info("run started, counting messages since %s; %d chats already done" % ((req.get("since") or "the beginning")[:10], len(done)))
    try:
        me = matrix.whoami()
        rl.info("signed in to Matrix as %s" % me)
        rooms = matrix.joined_rooms()
        rl.info("%d joined chats" % len(rooms))
        pending, partners, skipped, batch = 0, 0, 0, []
        for room_id in rooms:
            h = room_hash(room_id)
            if h in done:
                continue
            counted = matrix.count_room(room_id, me, since_ms)
            net = None
            members = []
            if counted:
                counter, names = counted
                members = counter.result(names)
                net = sorted(counter.members)[0][0] if counter.members else None
            if net is None:
                # Not a bridged chat worth keeping; still recorded as done so a restart skips it.
                net, members = "whatsapp", []
                skipped += 1
                if skipped <= MAX_SKIP_LINES:
                    try:
                        listed = ", ".join("%s%s" % (u, " (%s)" % n if n else "") for u, n in matrix.peek(room_id)[:6])
                    except HttpError:
                        listed = "members not readable"
                    rl.info("skipped %s: %s" % (room_id, listed))
            else:
                partners += len(members)
                rl.info("counted %s [%s]: %s" % (room_id, net, "; ".join(_member_line(m) for m in members) or "no messages in range"))
            batch.append({"roomHash": h, "network": net, "members": members})
            pending += 1
            if len(batch) >= BATCH_ROOMS:
                curia.post_rooms(run_id, batch)
                batch = []
                rl.flush()
        if batch:
            curia.post_rooms(run_id, batch)
        curia.finish(run_id, "done")
        rl.info("run finished: %d chats looked at, %d people with messages, %d chats skipped (no bridge partner or too big)" % (pending, partners, skipped))
        rl.flush()
        return "done"
    except HttpError as err:
        rl.error("run stopped: %s" % err)
        curia.finish(run_id, "failed", "http_%s" % err.status)
        rl.flush()
        return "failed"
    except Exception as err:  # noqa: BLE001 - report any failure to Curia instead of leaving the run open
        rl.error("run stopped by %s: %s" % (type(err).__name__, err))
        curia.finish(run_id, "failed", type(err).__name__[:60])
        rl.flush()
        return "failed"


def main():
    try:
        cfg = Config()
    except ConfigError as err:
        print("config: %s" % err, file=sys.stderr)
        return 2
    curia = Curia(cfg.curia_url, cfg.curia_token)
    matrix = Matrix(cfg.matrix_url, cfg.matrix_token)
    return 0 if run_once(curia, matrix) in ("idle", "done") else 1


if __name__ == "__main__":
    sys.exit(main())
