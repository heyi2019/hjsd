# 宜游轩 ERP 后端镜像
# 构建：docker compose build backend
#
# 基础镜像选 alpine（Python 3.12.13）而非 python:3.12-slim，镜像 205MB vs 299MB。
# 前提已验证：全部 24 个依赖在 x86_64/aarch64 的 musllinux 上都有预编译 wheel，
# 无一个需要源码编译（故无需 gcc）。切换前请勿让 requirements 引入无 musl wheel 的包，
# 否则 ECS 上会因缺编译器直接构建失败。
FROM alpine:3.20

# tzdata 不可省：alpine 默认无时区库，缺失会让 datetime.now() 落 UTC，
# 与国内 +8 差 8 小时，跨日订单/对账日期会错位。
# libstdc++ 为 greenlet/uvloop 等 C++ 扩展的运行时依赖。
# py3-pip 只在构建期用，末尾随 pip 一起卸载。
# 最后补 python 软链：alpine 只有 python3，而官方 python 镜像有 python 软链。
# 补上后 deploy.sh 与文档里既有的 `python scripts/*.py` 调用可零改动继续工作。
RUN apk add --no-cache python3 py3-pip libstdc++ tzdata \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && ln -sf /usr/bin/python3 /usr/local/bin/python

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Asia/Shanghai

# 先装依赖（利用层缓存）
# 用阿里云 pypi 镜像：ECS 直连 pypi.org 实测仅 ~15kB/s，慢到不可用；镜像可达且快。
# requirements.txt 仅含运行时依赖；pandas/numpy(160MB) 与 pytest 系已移到 requirements-dev.txt。
# --break-system-packages：alpine 的 python3 由 apk 管理，pip 默认拒绝写入系统 site-packages。
# 装完卸载 pip 与 py3-pip：运行期不再需要包管理器，省约 10MB。
COPY requirements.txt .
RUN pip install --no-cache-dir --break-system-packages \
        -i https://mirrors.aliyun.com/pypi/simple/ -r requirements.txt \
    && pip uninstall -y --break-system-packages pip \
    && apk del py3-pip \
    && rm -rf /root/.cache/pip /tmp/* /var/cache/apk/*

# 再拷源码（.dockerignore 已排除 .venv / data / .env）
COPY . .

EXPOSE 8123

# 启动时：先执行迁移（幂等），再起服务。
# DATABASE_URL 等由 compose 的 env_file 注入，优先级高于任何 .env。
# 迁移已压平为单基线 0001，旧库（版本戳 0002~0023）无法再 upgrade；
# 故 upgrade 失败时交给 stamp_baseline.py：只有确认库结构与 ORM 等价才对齐版本戳，
# 结构真的落后则报错退出，避免把缺表的库伪装成已迁移。
# 注意：下面的 python3 显式写出（不仅依赖 python 软链），避免软链若被移除时启动直接失败。
CMD ["sh", "-c", "alembic upgrade head || python3 scripts/stamp_baseline.py && uvicorn app.main:app --host 0.0.0.0 --port 8123"]
