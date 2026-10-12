# 宜游轩 ERP 后端镜像
# 构建：docker compose build backend
# 用 3.12 而非 3.13：pandas 2.2.2 无 3.13 预编译 wheel，3.13-slim 又缺 C 编译器会导致源码编译失败。
# 3.12 上 pandas/numpy 均为预编译 wheel，安装快且稳；生产 ECS 同样适用。
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# 先装依赖（利用层缓存）
# 用阿里云 pypi 镜像：ECS 直连 pypi.org 实测仅 ~15kB/s，慢到不可用；镜像可达且快。
COPY requirements.txt .
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ -r requirements.txt

# 再拷源码（.dockerignore 已排除 .venv / data / .env）
COPY . .

EXPOSE 8123

# 启动时：先执行迁移（幂等），再起服务。
# DATABASE_URL 等由 compose 的 env_file 注入，优先级高于任何 .env。
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8123"]
