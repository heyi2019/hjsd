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
docker compose run --rm backend alembic upgrade head

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
