"""Settings come from the environment (the job's 600 env file). Values are never printed."""
import os

REQUIRED = ("CONTACTS_API_TOKEN", "CURIA_URL", "MATRIX_ACCESS_TOKEN", "MATRIX_HOMESERVER_URL")


class ConfigError(Exception):
    pass


class Config:
    def __init__(self, env=None):
        env = os.environ if env is None else env
        missing = [k for k in REQUIRED if not env.get(k, "").strip()]
        if missing:
            raise ConfigError("missing settings: " + ", ".join(missing))
        self.curia_token = env["CONTACTS_API_TOKEN"].strip()
        self.curia_url = env["CURIA_URL"].strip().rstrip("/")
        self.matrix_token = env["MATRIX_ACCESS_TOKEN"].strip()
        self.matrix_url = env["MATRIX_HOMESERVER_URL"].strip().rstrip("/")
        for name, url in (("CURIA_URL", self.curia_url), ("MATRIX_HOMESERVER_URL", self.matrix_url)):
            if not url.startswith(("https://", "http://")):
                raise ConfigError(name + " must start with http:// or https://")
