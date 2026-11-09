"""Status lines for the run: printed (launchd.out) and sent to Curia so the Sources drawer can show them.
Names, phone numbers and room ids may appear (the owner asked for that). Message text never does: nothing here reads it."""
import sys

from .httpjson import HttpError

FLUSH_AT = 20
MAX_LEN = 400


class RunLog:
    def __init__(self, curia, run_id=None, echo=print):
        self.curia, self.run_id, self.echo = curia, run_id, echo
        self.buf = []

    def _add(self, level, msg):
        msg = str(msg)[:MAX_LEN]
        self.echo("%s %s" % (level, msg))
        self.buf.append({"level": level, "message": msg})
        if len(self.buf) >= FLUSH_AT:
            self.flush()

    def info(self, msg): self._add("info", msg)
    def warn(self, msg): self._add("warn", msg)
    def error(self, msg): self._add("error", msg)

    def flush(self):
        """Best effort: a log that cannot be sent must never stop the run."""
        while self.buf:
            chunk, self.buf = self.buf[:50], self.buf[50:]
            try:
                self.curia.post_log(self.run_id, chunk)
            except HttpError as err:
                print("log not sent: %s" % err, file=sys.stderr)
                self.buf = []
                return
