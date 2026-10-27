#!/usr/bin/env bash
# 宜游轩 ERP 一键部署（在阿里云 ECS 上执行）
set -euo pipefail
cd "$(dirname "$0")/.."

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

# 版本号唯一事实源是 backend/app/version.py：这里解析后导出，供镜像 tag 与容器内 /health 使用。
# 不从 .env 读，避免"改了代码忘改配置"导致线上显示旧版本。
# 解析失败只降级为 latest 并告警——版本标识不该成为部署关键路径上的阻断点。
APP_VERSION="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' ../backend/app/version.py 2>/dev/null | head -1 || true)"
if [ -z "$APP_VERSION" ]; then
  APP_VERSION="latest"
  echo "⚠ 未能从 ../backend/app/version.py 解析版本号，镜像 tag 回落 latest" >&2
fi
export APP_VERSION
echo "==> 发布版本 V${APP_VERSION}（镜像 tag 同此值）"

echo "==> 构建镜像"
docker compose build

if docker compose run --rm backend test -f /app/data/heijin_erp_v1.db; then
  echo "==> 迁移前备份正式库"
  docker compose run --rm backend \
    python /app/scripts/backup_db.py \
    --db /app/data/heijin_erp_v1.db \
    --out-dir /app/data/backups \
    --keep 30
else
  echo "==> 首次部署：正式库尚不存在，跳过备份"
fi

echo "==> 执行数据库迁移"
# 迁移已压平为单基线 0001：存量库若仍带旧版本戳（0002~0023），
# `alembic upgrade head` 会报 Can't locate revision 并退出。
# 与 Dockerfile CMD 保持同一兜底：upgrade 失败时交 stamp_baseline.py,
# 只有确认「库结构与 ORM 等价」才对齐版本戳；结构真的落后则打印缺口清单并报错退出
# （绝不把落后的库伪装成已迁移）。首次部署空库时 upgrade 直接成功，不会走到兜底。
docker compose run --rm backend sh -c 'alembic upgrade head || python scripts/stamp_baseline.py'

# 经营规则定义是系统闭集（REBATE / COMMISSION / INSTALLMENT / WRITE_DOWN / REFUND / DG_MIXED），
# 迁移只建表不预置，缺定义时 make_snapshot 返回空快照且不报错（静默失效）。
# 脚本幂等：定义按 (policy_code, GLOBAL) 判重、已有版本的跳过，可反复执行。
echo "==> 预置经营规则定义与默认版本（幂等）"
docker compose run --rm backend python scripts/seed_policy_definitions.py --apply

echo "==> 启动服务"
docker compose up -d

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
sleep 5
if curl -fsS http://127.0.0.1/api/v1/health; then
  echo "  OK"
else
  echo "  ✗ 健康检查未通过，请查 docker compose logs backend" >&2
  exit 1
fi

# 部署前备份与正式库同处 erp_db 卷，卷丢失会一起没；异地留存必须在另一台机器上做。
echo "==> 备份提醒（本次已做部署前快照，日常快照需另挂 cron）"
echo "  ECS: crontab -e → 20 3 * * * /bin/bash $(pwd)/scripts/backup_daily.sh"
echo "  本机: bash deploy/scripts/pull_backup.sh --host root@<ECS_IP>"
