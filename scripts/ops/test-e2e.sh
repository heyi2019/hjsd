#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -x /Users/aries/Applications/Python_3.13/bin/python3 && "${CI:-}" != "true" ]]; then
  python3 "$ROOT_DIR/backend/scripts/setup_test_environment.py" --check
  PY=/Users/aries/Applications/Python_3.13/bin/python3
  export PYTHONPATH="$ROOT_DIR/dependencies/python313-runtime:$ROOT_DIR/backend${PYTHONPATH:+:$PYTHONPATH}"
  export ERP_E2E_PYTHON="$PY"
else
  PY=python3
  export PYTHONPATH="$ROOT_DIR/backend${PYTHONPATH:+:$PYTHONPATH}"
  export ERP_E2E_PYTHON="$PY"
fi
cd "$ROOT_DIR/frontend"
exec "$PY" "$ROOT_DIR/backend/scripts/ephemeral_test_db.py" e2e -- npx playwright test "$@"
