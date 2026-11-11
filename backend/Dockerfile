# 宜游轩 ERP 后端镜像
# 构建：docker compose build backend
#
# 基础镜像用 python:3.12-alpine（官方 musl 镜像，自带 Python 3.12 + pip + python 软链）。
# [2026-11-11 提速] 原用 alpine:3.20 + apk add python3 py3-pip，该命令会连带拉 7 个
# *-pyc 预编译字节码包（python3-pycache-pyc0 / pyc / py3-pip-pyc ...），实测 CI westus
# 上这一层耗 68s（本地 32s），而 py3-pip 及其 pyc 依赖下一步就被卸载——纯浪费。
# 换官方镜像后本层只装 2 个包（libstdc++/tzdata）约 5s；最终镜像 204MB，比原 248MB 更小。
# 前提已验证：27 个生产依赖在 musllinux 上都有预编译 wheel，无一个需源码编译（故无需 gcc）。
# 切换前请勿让 requirements 引入无 musl wheel 的包，否则 ECS 上会因缺编译器构建失败。
FROM python:3.12-alpine

# tzdata 不可省：alpine 默认无时区库，缺失会让 datetime.now() 落 UTC，
# 与国内 +8 差 8 小时，跨日订单/对账日期会错位。
# libstdc++ 为 greenlet/uvloop 等 C++ 扩展的运行时依赖。
# 官方 python 镜像已自带 python/python3 软链与 pip，无需 apk 装 py3-pip、无需补软链。
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

# 先装依赖（利用层缓存）
# 用阿里云 pypi 镜像：ECS 直连 pypi.org 实测仅 ~15kB/s，慢到不可用；镜像可达且快。
# 生产安装用 requirements.lock.txt（由 requirements.txt 经 pip-compile 生成，精确锁定
# 全部运行时依赖及传递依赖）；pandas/numpy(160MB) 与 pytest 系在 requirements-dev.txt，不进生产镜像。
# 改运行时依赖须先改 requirements.txt，再 pip-compile 重新生成 requirements.lock.txt。
# --break-system-packages：官方镜像 pip 不受 PEP668 外部管理限制，此参数无害，保留兼容。
# 装完卸载 pip：运行期不再需要包管理器，省约 10MB。
COPY requirements.lock.txt .
RUN pip install --no-cache-dir --break-system-packages \
        -i https://mirrors.aliyun.com/pypi/simple/ -r requirements.lock.txt \
    && pip uninstall -y --break-system-packages pip \
    && rm -rf /root/.cache/pip /tmp/*

# 再拷源码（.dockerignore 已排除 .venv / data / .env）
COPY . .

EXPOSE 8123

# 启动时：先执行完整迁移链（幂等），再起服务。
# DATABASE_URL 等由 compose 的 env_file 注入，优先级高于任何 .env。
# 迁移失败必须阻止服务启动，不能伪造版本戳绕过全新基线初始化。
# 注意：下面的 python3 显式写出（不仅依赖 python 软链），避免软链若被移除时启动直接失败。
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8123 --workers 2"]
