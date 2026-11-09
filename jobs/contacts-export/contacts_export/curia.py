"""The Curia side of the contract (see README). Bearer: the contacts import token."""
from . import httpjson


class Curia:
    def __init__(self, base_url, token, sleep=None):
        self.base = base_url
        self.token = token
        self._kw = {"sleep": sleep} if sleep else {}

    def _call(self, method, path, body=None):
        return httpjson.request(method, self.base + path, self.token, body, where="curia", **self._kw)

    def ping(self):
        return self._call("GET", "/contacts/export/ping")[1]

    def run_request(self):
        status, body = self._call("GET", "/contacts/export/run-request")
        return body if status == 200 else None

    def post_rooms(self, run_id, rooms):
        self._call("POST", "/contacts/export/rooms", {"runId": run_id, "rooms": rooms})

    def finish(self, run_id, status, error_kind=None):
        body = {"runId": run_id, "status": status}
        if error_kind:
            body["errorKind"] = error_kind
        self._call("POST", "/contacts/export/finish", body)

    def post_log(self, run_id, lines):
        body = {"lines": lines}
        if run_id:
            body["runId"] = run_id
        self._call("POST", "/contacts/export/log", body)
