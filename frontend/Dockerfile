# 宜游轩 ERP 前端镜像（多阶段构建）
# 构建上下文为项目根（docker-compose.yml 中 context: ..），
# 以便 ui_guards.mjs 能读取 backend/app/domain/enums.py 校验前后端枚举对齐。
FROM node:22-alpine AS build

WORKDIR /app

# [2026-11-04] 仓库根改为 npm workspaces（根 package.json + 根 package-lock.json），
# frontend/ 下不再有锁文件。安装必须在根层做，否则 `npm ci` 找不到锁文件直接失败；
# 装完 node_modules 在 /app 根，frontend 通过 workspace 链接复用，不必重复安装。
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY patches/ ./patches/
# 使用锁文件保证生产构建可重复；ECS 直连 npmjs.org 较慢，使用 npmmirror。
RUN npm ci --registry=https://registry.npmmirror.com

COPY frontend/ ./frontend/
COPY VERSION ./VERSION

# ui_guards.mjs 按 cwd(frontend)/../backend/app/domain/enums.py 读取枚举做对齐校验，
# 故后端源码必须落在 /app/backend/app；放 /backend/app 会 ENOENT 直接中断构建。
COPY backend/app /app/backend/app

WORKDIR /app/frontend
# 生产使用同源相对路径，由 nginx 反代 /api 到后端，浏览器零跨域
ENV VITE_API_BASE=/api
RUN npm run build

# 运行阶段用 alpine + apk nginx，17.7MB，替代 nginx:1.27-alpine 的 76.8MB。
# 只跑静态文件与反代，不需要官方镜像附带的动态模块。
# 已验证：limit_req_zone / limit_conn_zone / add_header / realip 均在 apk 版 nginx 编译进核心。
FROM alpine:3.20

# tzdata 保证日志时间与国内一致；nginx 包自带 nginx 用户，worker 进程以该身份运行。
RUN sed -i 's|https://dl-cdn.alpinelinux.org/alpine|https://mirrors.aliyun.com/alpine|g' /etc/apk/repositories \
    && apk add --no-cache nginx tzdata \
    && mkdir -p /run/nginx /var/log/nginx /etc/nginx/conf.d /etc/nginx/snippets \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && rm -rf /var/cache/apk/*

# 构建阶段 WORKDIR 是 /app/frontend（根层安装、包内构建），产物在 frontend/dist。
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.global.conf /etc/nginx/nginx.conf
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
# 安全头片段：被 server 块与三个自带 add_header 的 location 共同 include。
# 必须放 snippets/ 而非 conf.d/，否则会被 conf.d/*.conf 的 include 当成站点加载。
COPY frontend/security-headers.conf /etc/nginx/snippets/security-headers.conf

# apk 版 nginx 默认用 /etc/nginx/http.d/，本镜像已在 nginx.global.conf 里改为
# include /etc/nginx/conf.d/*.conf，故自带默认站点不会被加载，无端口冲突。
# 443 由 nginx.conf 里的 ssl server 块监听；证书在运行时挂载到 /etc/nginx/certs，
# 不打进镜像（私钥不进镜像层，换证书只需重启容器）。
EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
