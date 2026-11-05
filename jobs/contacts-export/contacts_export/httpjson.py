"""A small JSON-over-HTTP helper (standard library only). Retries rate limits; never logs bodies or tokens."""
import json
import time
import urllib.error
import urllib.request

TIMEOUT = 60
MAX_RETRIES = 8


class HttpError(Exception):
    def __init__(self, status, where):
        super().__init__("HTTP %s from %s" % (status, where))
        self.status = status


def request(method, url, token, body=None, where="server", sleep=time.sleep):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as err:
            if err.code == 429 and attempt < MAX_RETRIES - 1:
                wait = 5.0
                try:
                    wait = min(120.0, json.loads(err.read()).get("retry_after_ms", 5000) / 1000.0)
                except Exception:  # an unreadable rate-limit body just means the default wait
                    pass
                sleep(wait)
                continue
            raise HttpError(err.code, where)
        except urllib.error.URLError:
            if attempt < MAX_RETRIES - 1:
                sleep(min(60, 2 ** attempt))
                continue
            raise HttpError(0, where)
    raise HttpError(0, where)
