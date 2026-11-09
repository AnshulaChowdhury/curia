"""One pass: ask Curia whether a run is wanted; if so count every chat room not yet done and send the counts."""
import re
import sys
from datetime import datetime

from .config import Config, ConfigError
from .curia import Curia
from .httpjson import HttpError
from .matrix import Matrix
from .reduce import room_hash

BATCH_ROOMS = 10


def parse_since_ms(since):
    return int(datetime.strptime(since[:19], "%Y-%m-%dT%H:%M:%S").timestamp() * 1000) if since else 0


def run_once(curia, matrix, log=print):
    req = curia.run_request()
    if not req:
        log("no run requested")
        return "idle"
    run_id, since_ms = req["runId"], parse_since_ms(req.get("since"))
    done = set(req.get("doneRooms", []))
    try:
        me = matrix.whoami()
        pending, batch = 0, []
        for room_id in matrix.joined_rooms():
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
            batch.append({"roomHash": h, "network": net, "members": members})
            pending += 1
            if len(batch) >= BATCH_ROOMS:
                curia.post_rooms(run_id, batch)
                batch = []
        if batch:
            curia.post_rooms(run_id, batch)
        curia.finish(run_id, "done")
        log("run finished: %d rooms counted" % pending)
        return "done"
    except HttpError as err:
        curia.finish(run_id, "failed", "http_%s" % err.status)
        log("run stopped: %s" % err)
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
