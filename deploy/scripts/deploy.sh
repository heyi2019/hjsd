#!/usr/bin/env bash
# 宜游轩 ERP 一键部署（在阿里云 ECS 上执行）
set -euo pipefail
cd "$(dirname "$0")/.."

# CI/回滚可显式传入版本；先暂存，避免下面加载 ECS .env 时被遗留的
# APP_VERSION 覆盖。未显式传入时，版本仍只从 backend/app/version.py 解析。
requested_app_version="${APP_VERSION:-}"

if [ ! -f .env ]; then
  echo "✗ 缺少 deploy/.env"
  echo "  请先执行： cp env/.env.production.example .env"
  echo "  并填入 JWT_SECRET_KEY（openssl rand -hex 32）与 CORS_ORIGINS"
  exit 1
fi

# 让管理员初始化与 docker compose 使用同一份部署配置；.env 由运维维护且不入库。
set -a
. ./.env
set +a

if [ -n "$requested_app_version" ]; then
  APP_VERSION="$requested_app_version"
else
  unset APP_VERSION || true
fi

# 版本号唯一事实源是 backend/app/version.py：这里解析后导出，供镜像 tag 与容器内 /health 使用。
# 不从 .env 读，避免"改了代码忘改配置"导致线上显示旧版本。
# 解析失败只降级为 latest 并告警——版本标识不该成为部署关键路径上的阻断点。
# 部署/回滚可显式覆盖版本（回滚时由 CI 传入 APP_VERSION=旧版本）；
# 正常发布不设置该变量，仍从 version.py 单一事实源解析。
if [ -z "${APP_VERSION:-}" ]; then
  APP_VERSION="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' ../backend/app/version.py 2>/dev/null | head -1 || true)"
fi
if [ -z "$APP_VERSION" ]; then
  APP_VERSION="latest"
  echo "⚠ 未能从 ../backend/app/version.py 解析版本号，镜像 tag 回落 latest" >&2
fi
export APP_VERSION
echo "==> 发布版本 V${APP_VERSION}（镜像 tag 同此值）"

# 离线路径：ERP_SKIP_BUILD=1 表示镜像已由 docker load 导入，不走构建。
# 价值在于彻底切断「ECS 必须能访问 Docker Hub / alpine 源 / pypi / npm」这条链——
# 镜像在联网机器上构建完毕，ECS 只做 load，四个网络依赖全部归零。
if [ "${ERP_SKIP_BUILD:-0}" = "1" ]; then
  echo "==> 离线模式：跳过构建，校验已导入镜像"
  for svc in backend frontend; do
    img="heijin-${svc}:${APP_VERSION}"
    if ! docker image inspect "$img" >/dev/null 2>&1; then
      echo "✗ 缺少镜像 ${img}" >&2
      echo "  请先导入离线包：gunzip -c heijin-images-${APP_VERSION}-amd64.tar.gz | docker load" >&2
      exit 1
    fi
    # 架构必须逐字节对上：arm64 镜像在 x86_64 上会 exec format error，
    # 而 compose 的启动报错只显示 exit 1，很难联想到架构。
    arch="$(docker image inspect "$img" --format '{{.Architecture}}')"
    if [ "$arch" != "amd64" ]; then
      echo "✗ ${img} 架构为 ${arch}，本机需要 amd64" >&2
      echo "  请在联网的 x86_64 机器上构建，或用 buildx --platform linux/amd64 交叉构建后导出" >&2
      exit 1
    fi
    echo "  ✓ ${img} (${arch})"
  done
else
# 基础镜像预检：Docker Hub 在部分网络（尤其 ECS 国内节点）不可达，而失败点落在 Dockerfile
# 的 FROM 行、报错形似代码问题（TLS handshake timeout）。这里提前拉取，把网络问题变成明示。
# 三个基础镜像：python:3.12-alpine=后端 FROM；alpine:3.20=前端运行阶段 FROM；
# node:22-alpine=前端构建阶段 FROM。缺一即构建失败。
echo "==> 检查基础镜像"
for img in python:3.12-alpine alpine:3.20 node:22-alpine; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    echo "  ✓ ${img} 已存在"
    continue
  fi
  echo "  拉取 ${img} ..."
  if docker pull "$img" >/dev/null; then
    echo "  ✓ ${img} 已拉取"
    continue
  fi
  cat >&2 <<EOF
✗ 无法拉取 ${img}，构建会在 Dockerfile 的 FROM 行失败。
  这是 ECS 最常见的阻塞项（TLS handshake timeout / connection reset），不是镜像或代码问题。

  解决方式（任选其一）：
    1) 配镜像加速器：
         sudo mkdir -p /etc/docker
         echo '{"registry-mirrors":["https://<你的ID>.mirror.aliyuncs.com"]}' | sudo tee /etc/docker/daemon.json
         sudo systemctl daemon-reload && sudo systemctl restart docker
       （加速地址在阿里云「容器镜像服务 → 镜像工具 → 镜像加速器」页面获取）
    2) 从能联网的机器导出后上传：
         docker save ${img} | gzip > ${img//[:.]/_}.tar.gz
         scp <文件> root@<ECS_IP>:/tmp/ && ssh root@<ECS_IP> 'gunzip -c /tmp/xx.tar.gz | docker load'
       注意：必须是 linux/amd64 镜像。Apple Silicon 等 arm64 机器构建的镜像不能用于 ECS。
EOF
  exit 1
done

echo "==> 构建镜像"
docker compose build
fi

# 迁移前必须有一份可信的库快照：迁移改的是结构，出错往往不可逆。
# 备份逻辑只有一处真相（backup_daily.sh，pg_dump -Fc + sha256 + 完整性闸门），
# 这里只负责「先把 db 拉起来 → 备份 → 备份失败就中止发布」。
echo "==> 确保 db 服务就绪（迁移前备份依赖它）"
docker compose up -d db

db_ready=0
for _ in $(seq 1 20); do
  if docker compose exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -q' </dev/null >/dev/null 2>&1; then
    db_ready=1; break
  fi
  sleep 2
done
if [ "$db_ready" -ne 1 ]; then
  echo "✗ db 在 40s 内未就绪，已中止发布（不在没有备份的情况下改结构）" >&2
  exit 1
fi

echo "==> 迁移前备份 PostgreSQL 正式库"
if ! bash scripts/backup_daily.sh; then
  echo "✗ 迁移前备份失败，已中止发布（不在没有备份的情况下改结构）" >&2
  exit 1
fi

# 全新数据库没有任何业务表，先用当前唯一活动迁移 0001 建结构；
# 若只残留 alembic_version 等元表、业务表完全不存在，清掉残留迁移标记再初始化。
# 已有业务表仍走下面的正常迁移流程，不自动覆盖业务数据。
schema_probe="$(docker compose exec -T db psql \
  -U "${POSTGRES_USER:-erp_app}" -d "${POSTGRES_DB:-heijin_erp}" -tAc \
  "select
     (select count(*) from information_schema.tables where table_schema=current_schema()),
     coalesce(to_regclass('public.alembic_version')::text, 'NONE'),
     coalesce(to_regclass('public.users')::text, 'NONE'),
     coalesce(to_regclass('public.policy_definitions')::text, 'NONE')" \
  | tr -d '\r' || true)"
IFS='|' read -r schema_tables schema_alembic schema_users schema_policies <<< "$schema_probe"
schema_tables="$(printf '%s' "$schema_tables" | tr -d '[:space:]')"
schema_alembic="$(printf '%s' "$schema_alembic" | tr -d '[:space:]')"
schema_users="$(printf '%s' "$schema_users" | tr -d '[:space:]')"
schema_policies="$(printf '%s' "$schema_policies" | tr -d '[:space:]')"
if [ "$schema_tables" = "0" ]; then
  echo "==> 检测到全新数据库，初始化活动迁移链"
  docker compose run --rm backend alembic upgrade head
elif [ "$schema_users" = "NONE" ] && [ "$schema_policies" = "NONE" ]; then
  echo "==> 检测到仅有迁移元表的半初始化数据库，重置迁移标记并初始化活动迁移链"
  docker compose exec -T db psql \
    -U "${POSTGRES_USER:-erp_app}" -d "${POSTGRES_DB:-heijin_erp}" \
    -v ON_ERROR_STOP=1 -c "drop table if exists alembic_version"
  docker compose run --rm backend alembic upgrade head
elif [ "$schema_alembic" = "NONE" ]; then
  echo "✗ 数据库已有表但缺少 alembic_version，拒绝无版本迁移" >&2
  exit 1
fi

# 发布不变量基线：只采集，不写业务数据。版本化迁移允许调整结构与 Alembic 版本，
# 但发布通道不能改写用户、配置和历史业务记录。
# 用户与库名与 compose 的 db 服务同源；宿主未 export 时按 compose 默认值回落。
db_snapshot() {
  docker compose exec -T db psql \
    -U "${POSTGRES_USER:-erp_app}" -d "${POSTGRES_DB:-heijin_erp}" -tAc \
    "select
       (select count(*) from information_schema.tables where table_schema=current_schema()),
       coalesce((select to_regclass('public.db_version')::text), 'NONE'),
       (select count(*) from policy_definitions),
       (select count(*) from option_sets),
       (select count(*) from order_form_fields where order_type_code='SALE'),
       (select count(*) from order_form_fields),
       (select count(*) from users),
       (select version_num from alembic_version)"
}

# psql 返回异常（连接失败 / 列数不符 / 空值）时立即中止，不能让下面的算术比较
# 退化成 "[: : integer expression expected" 这种无法定位的报错。
validate_state() {
  local label="$1" state="$2" tables _dbver policies options sale fields users _alembic
  IFS='|' read -r tables _dbver policies options sale fields users _alembic <<< "$state"
  if ! [[ "$tables" =~ ^[0-9]+$ && "$policies" =~ ^[0-9]+$ && "$options" =~ ^[0-9]+$ \
          && "$sale" =~ ^[0-9]+$ && "$fields" =~ ^[0-9]+$ && "$users" =~ ^[0-9]+$ ]]; then
    printf '✗ %s库状态采集格式异常，已中止发布：%q\n' "$label" "$state" >&2
    exit 1
  fi
}

echo "==> 采集发布前库状态基线（只读）"
pre_state="$(db_snapshot)"
validate_state "发布前" "$pre_state"
IFS='|' read -r pre_tables pre_dbversion pre_policies pre_optionsets pre_sale_rows pre_fields pre_users pre_alembic <<< "$pre_state"
echo "  ${pre_state}"

echo "==> 执行数据库迁移"
# 已有数据库只应用当前活动迁移链，不覆盖业务数据。
docker compose run --rm backend alembic upgrade head

echo "==> 迁移完成（发布通道不写入业务数据）"

echo "==> 启动服务"
if ! docker compose up -d; then
  # Docker Compose 在重建依赖服务的瞬间可能返回旧容器 ID 不存在；
  # 等待一次让 Docker 完成清理后重试，真实启动错误仍会在第二次失败时退出。
  echo "⚠ 首次启动返回错误，等待 Docker 清理依赖容器后重试"
  sleep 5
  docker compose up -d
fi

if [ -n "${ADMIN_PASSWORD:-}" ]; then
  echo "==> 初始化管理员账号"
  docker compose exec -T -e ADMIN_PASSWORD="$ADMIN_PASSWORD" backend \
    python scripts/create_admin.py
else
  echo "⚠ 未设置 ADMIN_PASSWORD，服务已启动但尚未初始化管理员账号"
  echo "  首次部署前请执行：export ADMIN_PASSWORD='至少 8 位强密码'"
  echo "  然后重新运行 ./scripts/deploy.sh"
fi

echo "==> 服务状态"
docker compose ps

echo "==> 后端健康检查"
health_response=""
health_ok=0
for attempt in {1..30}; do
  if health_response="$(curl -fsS --max-time 5 http://127.0.0.1/api/health 2>/dev/null)"; then
    printf '%s\n' "$health_response"
    echo "  OK（第 ${attempt} 次检查）"
    health_ok=1
    break
  fi
  sleep 2
done

if [ "$health_ok" -ne 1 ]; then
  echo "  ✗ 健康检查在 60 秒内未通过，请查 docker compose logs backend frontend" >&2
  docker compose logs --tail=80 backend frontend >&2 || true
  exit 1
fi

echo "==> 发布后不变量校验（只读）"
post_state="$(db_snapshot)"
validate_state "发布后" "$post_state"
IFS='|' read -r post_tables post_dbversion post_policies post_optionsets post_sale_rows post_fields post_users post_alembic <<< "$post_state"
echo "  ${post_state}"

invariant_fail=0
assert_unchanged() {
  local label="$1" before="$2" after="$3"
  if [ "$before" = "$after" ]; then
    printf '  ✓ %s: %s\n' "$label" "$after"
  else
    printf '  ✗ %s 发生变化：%s → %s\n' "$label" "$before" "$after" >&2
    invariant_fail=1
  fi
}

printf '  ✓ 表数：%s → %s（由版本化迁移管理）\n' "$pre_tables" "$post_tables"
printf '  ✓ alembic 版本戳：%s → %s（由版本化迁移管理）\n' "$pre_alembic" "$post_alembic"
assert_unchanged "db_version 表" "$pre_dbversion" "$post_dbversion"
assert_unchanged "policy_definitions 行数" "$pre_policies" "$post_policies"
assert_unchanged "option_sets 行数" "$pre_optionsets" "$post_optionsets"
assert_unchanged "历史 SALE 行数" "$pre_sale_rows" "$post_sale_rows"
assert_unchanged "用户行数" "$pre_users" "$post_users"

if [ "$post_fields" -lt "$pre_fields" ]; then
  echo "  ✗ 字段总数倒退：${pre_fields} → ${post_fields}" >&2
  invariant_fail=1
else
  echo "  ✓ 字段总数：${pre_fields} → ${post_fields}（只增不减）"
fi

if [ "$invariant_fail" -ne 0 ]; then
  echo "✗ 发布后不变量校验失败，请按上线执行单回滚段处置" >&2
  exit 1
fi

# 部署前备份与正式库同处 erp_db 卷，卷丢失会一起没；异地留存必须在另一台机器上做。
echo "==> 备份提醒（本次已做部署前快照，日常快照需另挂 cron）"
echo "  ECS: crontab -e → 20 3 * * * /bin/bash $(pwd)/scripts/backup_daily.sh"
echo "  本机: bash deploy/scripts/pull_backup.sh --host root@<ECS_IP>"
