#!/bin/sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
python3 "$ROOT_DIR/backend/scripts/setup_test_environment.py" --check
export PYTHONPATH="$ROOT_DIR/dependencies/python313-runtime:$ROOT_DIR/backend${PYTHONPATH:+:$PYTHONPATH}"
export TEST_REDIS_URL="${TEST_REDIS_URL:-redis://127.0.0.1:6389/0}"
exec /Users/aries/Applications/Python_3.13/bin/python3 "$ROOT_DIR/backend/scripts/ephemeral_test_db.py" test -- /Users/aries/Applications/Python_3.13/bin/python3 -m pytest "$@"
