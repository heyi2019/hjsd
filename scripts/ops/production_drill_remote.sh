#!/usr/bin/env bash
set -Eeuo pipefail

token="${1:-}"
expected_archive_hash="${2:-}"
[[ "$token" =~ ^[0-9a-f]{20}$ && "$expected_archive_hash" =~ ^[0-9a-f]{64}$ ]] || exit 2
stage="/tmp/heijin-server-drill-$token"
database="heijin_erp_drill_$token"
dump="/tmp/heijin-drill-$token.dump"
[[ -d "$stage" && ! -L "$stage" && -f "$stage/source.tar" ]] || exit 2
created=0
snapshot_created=0
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  cleanup_status=0
  if [[ "$created" == 1 ]]; then
    docker compose exec -T db sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)"' sh "$database" </dev/null >/dev/null 2>&1 || cleanup_status=1
  fi
  if [[ "$snapshot_created" == 1 ]]; then
    docker compose exec -T db sh -c 'case "$1" in /tmp/heijin-drill-*.dump) rm -f -- "$1";; *) exit 2;; esac' sh "$dump" </dev/null || cleanup_status=1
  fi
  if [[ "$stage" == "/tmp/heijin-server-drill-$token" && ! -L "$stage" ]]; then
    rm -rf -- "$stage" || cleanup_status=1
  else
    cleanup_status=1
  fi
  if [[ "$cleanup_status" == 0 ]]; then echo '服务器隔离演练资源已清理'; else echo '临时资源清理未完成，请检查服务器隔离资源' >&2; status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cd /opt/heijin/deploy

actual_hash="$(sha256sum "$stage/source.tar" | cut -d' ' -f1)"
[[ "$actual_hash" == "$expected_archive_hash" ]] || { echo '候选源码校验失败' >&2; exit 1; }
tar -xf "$stage/source.tar" -C "$stage"
[[ -f "$stage/VERSION" && -f "$stage/backend/alembic.ini" && -f "$stage/deploy/scripts/schema_diff.py" ]] || exit 1
backend_container="$(docker compose ps -q backend)"
[[ -n "$backend_container" ]]
backend_image="$(docker inspect --format '{{.Image}}' "$backend_container")"
network="$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$backend_container")"
[[ "$backend_image" =~ ^sha256:[0-9a-f]{64}$ && "$network" =~ ^[a-zA-Z0-9_.-]+$ ]] || { echo '无法确认服务器运行时' >&2; exit 1; }

echo '==> 服务器内部创建生产快照，不传输数据'
docker compose exec -T db sh -c '
  set -eu
  test "$POSTGRES_DB" = heijin_erp
  case "$1" in /tmp/heijin-drill-*.dump) ;; *) exit 2;; esac
  umask 077
  (set -C; : > "$1")
' sh "$dump" </dev/null >"$stage/dump.log" 2>&1
snapshot_created=1
docker compose exec -T db sh -c '
  set -eu
  test "$POSTGRES_DB" = heijin_erp
  exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-privileges -f "$1"
' sh "$dump" </dev/null >>"$stage/dump.log" 2>&1

echo '==> 恢复到服务器独立临时库'
docker compose exec -T db sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE \"$1\""' sh "$database" </dev/null >"$stage/create.log" 2>&1
created=1
docker compose exec -T db sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "REVOKE CONNECT ON DATABASE \"$1\" FROM PUBLIC"' sh "$database" </dev/null >"$stage/revoke.log" 2>&1
docker compose exec -T db sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --no-privileges --single-transaction "$2"' sh "$database" "$dump" </dev/null >"$stage/restore.log" 2>&1

query_database() {
  docker compose exec -T db sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -A -t -c "$2"' sh "$database" "$1" </dev/null
}
rows_sql="SELECT (SELECT count(*) FROM orders), (SELECT count(*) FROM cashflow), (SELECT count(*) FROM pools), (SELECT count(*) FROM teams), (SELECT count(*) FROM users), (SELECT count(*) FROM game_type_options)"
labels_sql="SELECT md5(coalesce(json_agg(s ORDER BY s)::text,'[]')) FROM ( SELECT 'pool:'||id||':'||name AS s FROM pools UNION ALL SELECT 'team:'||id||':'||name FROM teams UNION ALL SELECT 'game:'||id||':'||name FROM game_type_options UNION ALL SELECT 'channel:'||g.id||':'||e.n||':'||coalesce(e.item->>'label',e.item #>> '{}','') FROM game_type_options g CROSS JOIN LATERAL json_array_elements(CASE WHEN json_typeof(g.channel_regions::json)='array' THEN g.channel_regions::json ELSE '[]'::json END) WITH ORDINALITY AS e(item,n) UNION ALL SELECT 'option:'||o.code||':'||e.n||':'||coalesce(e.item->>'label',e.item #>> '{}','') FROM option_sets o CROSS JOIN LATERAL json_array_elements(CASE WHEN json_typeof(o.options::json)='array' THEN o.options::json ELSE '[]'::json END) WITH ORDINALITY AS e(item,n) WHERE o.code <> 'GAME_REFERENCE_ARCHIVE' ) q"
before_rows="$(query_database "$rows_sql")"
before_labels="$(query_database "$labels_sql")"
[[ "$(query_database 'SELECT count(*) FROM alembic_version')" == 1 ]]

echo '==> 在临时库运行候选版本迁移并核对 ORM 结构'
cat > "$stage/run_migration.py" <<'PY'
import os
import re
import subprocess
import sys
from importlib.metadata import version
from pathlib import Path
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

name = os.environ['DRILL_DATABASE']
if not re.fullmatch(r'heijin_erp_drill_[0-9a-f]{20}', name):
    raise SystemExit('invalid temporary database')
source = make_url(os.environ['DATABASE_URL'])
if source.get_backend_name() != 'postgresql' or source.host != 'db' or source.database != 'heijin_erp':
    raise SystemExit('unexpected production database configuration')
env = dict(os.environ)
env['DATABASE_URL'] = source.set(database=name).render_as_string(hide_password=False)
env['PYTHONPATH'] = '/candidate/backend'
dockerfile = Path('/candidate/backend/Dockerfile').read_text(encoding='utf-8')
bases = re.findall(r'(?m)^FROM\s+python:(\d+)\.(\d+)-alpine(?:\s|$)', dockerfile)
if not bases or tuple(map(int, bases[-1])) != sys.version_info[:2]:
    raise SystemExit('服务器运行时 Python 与候选镜像不一致')
for line in Path('/candidate/backend/requirements.lock.txt').read_text(encoding='utf-8').splitlines():
    if not line or line[0].isspace() or line.startswith('#'):
        continue
    requirement = re.fullmatch(r'([A-Za-z0-9_.-]+)==([^\s;]+)', line)
    if not requirement or version(requirement[1]) != requirement[2]:
        raise SystemExit('服务器运行时依赖与候选锁文件不一致')
engine = create_engine(env['DATABASE_URL'])
with engine.connect() as connection:
    if connection.scalar(text('SELECT current_database()')) != name:
        raise SystemExit('incorrect temporary database')
engine.dispose()
if len(sys.argv) > 1 and sys.argv[1] == 'b4':
    subprocess.run(['python3', 'scripts/split_sale_form_scopes.py'], env=env, check=True)
    raise SystemExit(0)
subprocess.run(['alembic', 'upgrade', 'head'], env=env, check=True)
subprocess.run(['python3', '-m', 'scripts.ensure_idempotency_records', '--apply'], env=env, check=True)
subprocess.run(['python3', '/candidate/deploy/scripts/schema_diff.py', name], env=env, check=True)
from alembic.config import Config
from alembic.script import ScriptDirectory
expected = ScriptDirectory.from_config(Config('/candidate/backend/alembic.ini')).get_current_head()
engine = create_engine(env['DATABASE_URL'])
with engine.connect() as connection:
    if connection.scalar(text('SELECT version_num FROM alembic_version')) != expected:
        raise SystemExit('临时库迁移编号与候选版本不一致')
engine.dispose()
PY
chmod 600 "$stage/run_migration.py"
if ! docker run --rm --network "$network" --env-file /opt/heijin/deploy/.env -e "DRILL_DATABASE=$database" \
  -v "$stage/VERSION:/candidate/VERSION:ro" -v "$stage/backend:/candidate/backend:ro" -v "$stage/deploy:/candidate/deploy:ro" \
  -v "$stage/run_migration.py:/candidate/run_migration.py:ro" -w /candidate/backend \
  --entrypoint python3 "$backend_image" /candidate/run_migration.py </dev/null >"$stage/migration.log" 2>&1; then
  echo '候选代码迁移或结构比对失败' >&2
  sed -n '/ORM 表数/p; /^    -/p' "$stage/migration.log" >&2
  python3 - "$stage/migration.log" <<'PY'
import re
import sys
text = open(sys.argv[1], encoding='utf-8', errors='replace').read()
for name in dict.fromkeys(re.findall(r'(?m)^([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Validation)):', text)):
    print('异常类型:', name, file=sys.stderr)
for name in dict.fromkeys(re.findall(r"No module named ['\"]([A-Za-z0-9_.]+)['\"]", text)):
    print('缺少模块:', name, file=sys.stderr)
for location in re.findall(r'File "(/candidate/[^\"]+)", line ([0-9]+)', text):
    print('代码位置:', *location, file=sys.stderr)
PY
  exit 1
fi

after_rows="$(query_database "$rows_sql")"
after_labels="$(query_database "$labels_sql")"
[[ "$before_rows" == "$after_rows" ]] || { echo '迁移前后主要记录数量不同' >&2; exit 1; }
[[ "$before_labels" == "$after_labels" ]] || { echo '迁移前后配置名称摘要不同' >&2; exit 1; }
sed -n '/ORM 表数/p' "$stage/migration.log"
echo '迁移版本、主要记录数和配置名称摘要核验通过'

echo '==> 在临时库演练售出表单配置补齐'
options_sql="SELECT id, md5(coalesce(options::text,'')) FROM option_sets WHERE editable IS TRUE ORDER BY id"
fields_sql="SELECT id, md5(json_build_object('label',label,'required',required,'is_active',is_active,'sort_order',sort_order,'field_type',field_type,'options',options,'required_when',required_when)::text) FROM order_form_fields ORDER BY id"
query_database "$options_sql" >"$stage/options-before"
query_database "$fields_sql" >"$stage/fields-before"
if ! docker run --rm --network "$network" --env-file /opt/heijin/deploy/.env -e "DRILL_DATABASE=$database" \
  -v "$stage/VERSION:/candidate/VERSION:ro" -v "$stage/backend:/candidate/backend:ro" -v "$stage/deploy:/candidate/deploy:ro" \
  -v "$stage/run_migration.py:/candidate/run_migration.py:ro" -w /candidate/backend \
  --entrypoint python3 "$backend_image" /candidate/run_migration.py b4 </dev/null >"$stage/b4.log" 2>&1; then
  echo '售出表单配置补齐演练失败' >&2
  exit 1
fi
query_database "$options_sql" >"$stage/options-after"
query_database "$fields_sql" >"$stage/fields-after"
python3 - "$stage" <<'PY'
from pathlib import Path
import sys
stage = Path(sys.argv[1])
for category in ('options', 'fields'):
    def read(suffix):
        return dict(line.split('|', 1) for line in (stage / f'{category}-{suffix}').read_text().splitlines())
    before, after = read('before'), read('after')
    changed = sum(after.get(key) != value for key, value in before.items())
    added = len(after.keys() - before.keys())
    print(f'{category}: 已有配置变化 {changed} 项，新增 {added} 项')
    if changed:
        raise SystemExit('已有可编辑配置在 B4 演练中变化，停止发布')
PY
query_database "SELECT order_type_code,count(*) FROM order_form_fields WHERE order_type_code IN ('SALEREC','SALETH','SALEDG') GROUP BY order_type_code ORDER BY order_type_code"
echo '售出表单配置补齐演练通过'
