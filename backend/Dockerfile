# 宜游轩 ERP 后端镜像
# 构建：docker compose build backend
#
# ── 基础镜像 ────────────────────────────────────────────────
# 用 python:3.12-alpine（官方 musl 镜像，自带 Python 3.12 + pip + python 软链）。
# [2026-11-11 提速] 原用 alpine:3.20 + apk add python3 py3-pip，该命令连带拉 7 个
# *-pyc 包，CI westus 上这一层耗 68s（本地 32s），而 py3-pip 及 pyc 依赖下一步就卸载——纯浪费。
# 换官方镜像后该层只装 2 个包约 5s。前提已验证：27 个生产依赖在 musllinux 上都有预编译 wheel，
# 无一个需源码编译（故无需 gcc）。切换前勿让 requirements 引入无 musl wheel 的包。
#
# ── 多阶段构建（2026-11-12 瘦身）────────────────────────────
# 单阶段 pip install 会在 site-packages 留下 ~997 个 .pyc（16.7MB 展开）与 C 扩展符号表；
# pyc 是 gzip 可压的水分，符号表 strip 后更小。但单阶段里 apk add/del binutils 的层无法回收，
# 实测反而 +10MB。故拆 builder/runtime：builder 装 binutils 完成 strip + 删 pyc，运行层只 COPY
# 结果，不带任何构建期工具链。实测 gzip 单阶段 37.76MB → 多阶段 29.92MB（−20.8%）。
# 复用要点：① strip 必须在 pip install 同一 RUN 内做（分层叠加，另起一层 rm/strip 不减体积）；
# ② 不用 --target 装依赖，否则 alembic/uvicorn 控制台脚本落在 /usr/local/bin 而 COPY 不到。
FROM python:3.12-alpine AS builder

# builder 仅需 binutils(strip)；镜像源换阿里云（ECS 直连 dl-cdn 慢）。
RUN sed -i 's|https://dl-cdn.alpinelinux.org/alpine|https://mirrors.aliyun.com/alpine|g' /etc/apk/repositories \
    && apk add --no-cache binutils

COPY requirements.lock.txt .

# 生产安装用 requirements.lock.txt（由 requirements.txt 经 pip-compile 生成，精确锁定运行时依赖）；
# pandas/numpy 与 pytest 系在 requirements-dev.txt，不进生产镜像。
# pypi 用阿里云镜像：ECS 直连 pypi.org 实测 ~15kB/s 不可用。
# 装到标准位置（不 --target）：控制台脚本 alembic/uvicorn 落在 /usr/local/bin，稍后随运行层带走。
# strip .so 去符号表；删 __pycache__/*.pyc 去掉 pip compileall 生成的字节码水分。
RUN pip install --no-cache-dir --break-system-packages \
        -i https://mirrors.aliyun.com/pypi/simple/ -r requirements.lock.txt \
    && find /usr/local/lib/python3.12/site-packages -type f \( -name '*.so' -o -name '*.so.*' \) -exec strip --strip-unneeded {} + 2>/dev/null \
    && find /usr/local/lib/python3.12/site-packages -type d -name __pycache__ -prune -exec rm -rf {} + \
    && find /usr/local/lib/python3.12/site-packages -name '*.pyc' -delete \
    && pip uninstall -y --break-system-packages pip \
    && rm -rf /root/.cache/pip /tmp/*

# ── 运行层 ─────────────────────────────────────────────────
FROM python:3.12-alpine

# tzdata 不可省：alpine 默认无时区库，缺失会让 datetime.now() 落 UTC，与国内 +8 差 8 小时，
# 跨日订单/对账日期会错位。libstdc++ 为 greenlet(SQLAlchemy asyncio) 等 C++ 扩展运行时依赖。
RUN sed -i 's|https://dl-cdn.alpinelinux.org/alpine|https://mirrors.aliyun.com/alpine|g' /etc/apk/repositories \
    && apk add --no-cache libstdc++ tzdata \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && rm -rf /var/cache/apk/*

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Asia/Shanghai

# 从 builder 带已 strip、已删 pyc 的依赖 + 控制台脚本（alembic/uvicorn）。
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# 拷源码（.dockerignore 已排除 .venv / data / .env / backups / **/__pycache__ / **/*.pyc）。
COPY . .

EXPOSE 8123

# 启动：先执行完整迁移链（幂等），再起服务。DATABASE_URL 由 compose env_file 注入。
# 迁移失败必须阻止服务启动，不能伪造版本戳绕过全新基线初始化。
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8123 --workers 2"]
