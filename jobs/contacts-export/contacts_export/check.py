"""The installer's end-to-end check: proves the token reaches Curia, and that Matrix accepts its token (no data is read)."""
import sys

from .config import Config, ConfigError
from .curia import Curia
from .httpjson import HttpError
from .matrix import Matrix


def main():
    try:
        cfg = Config()
        Curia(cfg.curia_url, cfg.curia_token).ping()
        print("curia: ok")
        Matrix(cfg.matrix_url, cfg.matrix_token).whoami()
        print("matrix: ok")
    except (ConfigError, HttpError) as err:
        print("check failed: %s" % err, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
