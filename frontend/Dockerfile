# 宜游轩 ERP 前端镜像（多阶段构建）
# 构建上下文为项目根（docker-compose.yml 中 context: ..），
# 以便 ui_guards.mjs 能读取 backend/app/domain/enums.py 校验前后端枚举对齐。
FROM node:20-alpine AS build

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
# 使用锁文件保证生产构建可重复；ECS 直连 npmjs.org 较慢，使用 npmmirror。
RUN npm ci --registry=https://registry.npmmirror.com

COPY frontend/ ./

# ui_guards.mjs 需比对后端枚举定义；构建期挂载后端源码供其只读校验
COPY backend/app /backend/app

# 生产使用同源相对路径，由 nginx 反代 /api/v1 到后端，浏览器零跨域
ENV VITE_API_BASE=/api/v1
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY frontend/nginx.global.conf /etc/nginx/nginx.conf
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
