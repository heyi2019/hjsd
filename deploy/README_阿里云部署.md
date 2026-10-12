# 黑金时代 ERP · 阿里云部署指南

> 目标：在阿里云 ECS 上用 Docker Compose 跑起后端（FastAPI + SQLite）与前端（React + Vite + Nginx）。
> 已就绪的部署包：`backend/Dockerfile`、`frontend/Dockerfile`、`frontend/nginx.conf`、`deploy/docker-compose.yml`、`deploy/env/.env.production.example`、`deploy/scripts/deploy.sh`。

## 零、本地构建注意事项（macOS + Docker Desktop 已实测通过）

完整跑通 `docker compose build` + `up`，后端健康检查与 nginx 同源反代均正常。两个实战踩坑已修进部署包：

1. **后端基础镜像用 `python:3.12-slim` 而非 3.13**：`pandas==2.2.2` 在 3.13 上无预编译 wheel，而 `python:3.13-slim` 不含 C 编译器，pip 会退化为源码编译并失败。3.12 上 pandas/numpy 均为 wheel，安装快且稳。**阿里云 ECS 同理，请勿改回 3.13-slim。**
2. **前端构建上下文为项目根**：`ui_guards.mjs` 在构建期需读取 `backend/app/domain/enums.py` 校验前后端枚举对齐，故 `docker-compose.yml` 中 frontend 的 `build.context` 为 `..`（项目根），Dockerfile 内 `COPY backend/app /backend/app`；根目录 `.dockerignore` 已排除 `node_modules` 等避免上下文过大。
3. **拉取镜像遇网络问题**：本机 macOS 上若构建报 `failed to fetch oauth token ... EOF`（docker.io 被本机代理干扰），给 Docker 配置代理或国内镜像加速器后再 build。**更正：阿里云 ECS 上 docker.io 直连是被拒的（实测 Connection refused），必须配镜像源——详见第 5 条。**
4. **前端 API 基址注入（已实测定位，加固）**：`frontend/.env.local` 里是本地联调地址（`http://192.168.x.x:8123/api/v1`）。实测 Vite 6 优先级为 **进程环境变量 > `.env.local`**：Dockerfile 中 `ENV VITE_API_BASE=/api/v1` 会覆盖它，产物为同源 `/api/v1`（正确）；但一旦**去掉该 ENV 或不经 Docker 直接 `npm run build`**，内网地址就会被烤进生产包，前端所有请求打到不可达 IP。**加固**：`.dockerignore` 已排除 `**/.env.local`，`frontend/Dockerfile` 的 `ENV VITE_API_BASE=/api/v1` 严禁删除；**上传包亦已剔除所有 `.env`（含根 `.env` 与 `deploy/.env`，避免泄漏 JWT 密钥）**，服务器上须用模板重新生成。
5. **ECS（华南2 河源 · 免费试用经济型e）出网三大坑——首次部署实测，务必照做**：
   - **dockerhub 直连被拒**：`registry-1.docker.io` 实测 Connection refused。预装的 8 个镜像源里
     5 个连不通（000）、`docker.m.daocloud.io` 401/502（已停服）、阿里云个人加速器
     `*.mirror.aliyuncs.com` **404（配额耗尽——拉成第一个镜像后即失效）**。
     → **可用源：`https://docker.1panel.live`**（实测 200）。写入 `/etc/docker/daemon.json`
     的 `registry-mirrors` 后 `systemctl restart docker`。
     ⚠️ **坏源绝不能留在列表里**：Docker 拿到 404 会判定 "not found" 并立即停止，不再回退到后面的源
     （实测删掉 daocloud 后三个基础镜像才拉成功）。
   - **pypi 极慢**：`pypi.org` 实测仅 **15 kB/s**（整体要 30+ 分钟）；改用
     `mirrors.aliyun.com/pypi/simple/` 提升到 22–76 kB/s。→ 后端 Dockerfile 已固定
     `pip install -i https://mirrors.aliyun.com/pypi/simple/`。
   - **npm 慢**：`registry.npmjs.org` 装 165 包耗时 **7 分钟**；改用 `registry.npmmirror.com`
     只需 **39 秒**（18×）。→ 前端 Dockerfile 已固定 `npm install --registry=https://registry.npmmirror.com`。
   - 首次冷构建因此约 **20 分钟**；镜像层缓存后，后续重启/重部署为**秒级**。

---

## 一、阿里云 ECS 选购清单（推荐）

| 项目 | 推荐配置 | 说明 |
|------|----------|------|
| 地域 | 华东1（杭州）/ 华南1（深圳）/ 华北2（北京） | 选离你/用户近的；**地域一旦选定不可更换** |
| 实例规格 | **2 vCPU · 4 GiB**（如 ecs.c7.large 或共享型 s6） | ERP 轻量，2核4G 留足余量；最低 2核2G 也能跑 |
| 镜像 | **Ubuntu 22.04 64位** | Docker 兼容好，文档多 |
| 系统盘 | ESSD PL0 / 40–60 GB | 代码+镜像+SQLite 足够 |
| 带宽 | 固定 3–5 Mbps **或** 按使用流量（5 Mbps 上限） | 内部系统流量小，按流量更省 |
| 公网 IP | 分配固定公网 IP（按固定带宽计费更稳定） | 需从外网访问必选 |
| 安全组 | 入方向放 **22(SSH) / 80(HTTP) / 443(HTTPS)** | 其余默认拒绝 |
| 购买方式 | 包年包月（比按量省 ~40%） | 长期部署首选 |

**预算参考（包年包月，2核4G + 5Mbps 带宽 + 40G 盘）**：约 **¥1200–2200/年**（活动价更低，大促可到 ¥800 档）。
> 若只对内网/临时演示，可选 **轻量应用服务器**（2核2G 约 ¥60–100/年），但镜像与运维自由度低于 ECS，不推荐长期生产。

---

## 二、购买步骤（阿里云控制台）

1. 进入 **ECS 控制台 → 实例 → 创建实例**。
2. 基础配置：选地域、实例规格（2核4G）、镜像（Ubuntu 22.04）。
3. 存储：系统盘 ESSD 40G。
4. 带宽：公网带宽按固定 5Mbps（或按使用流量）。
5. 安全组：新建/选用已放行 22/80/443 的安全组。
6. 登录方式：**密钥对**（推荐）或 root 密码（务必强密码）。
7. 确认下单，等待实例「运行中」，记下 **公网 IP**。

---

## 三、服务器初始化（SSH 登录后）

```bash
# 1. 安装 Docker + Compose 插件（Ubuntu 22.04）
sudo apt update && sudo apt install -y ca-certificates curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER      # 退出重登后免 sudo
docker --version && docker compose version

# 2. 放行防火墙（若开了 ufw）
sudo ufw allow 22,80,443/tcp
```

---

## 四、部署项目

方式 A：git 拉取（推荐，便于更新）
```bash
git clone <你的仓库地址> heijin && cd heijin/deploy
```
方式 B：本地打包上传
```bash
# 本机执行，排除本地依赖、构建产物、数据库和环境变量后再传
cd /Users/aries/黑金时代
tar \
  --exclude=node_modules \
  --exclude=.venv \
  --exclude='*.db' \
  --exclude='.env' \
  --exclude='*/.env' \
  --exclude='.env.local' \
  --exclude='*/.env.local' \
  --exclude=frontend/dist \
  --exclude=frontend/test-results \
  --exclude=.workbuddy \
  -czf heijin.tar.gz .
scp heijin.tar.gz user@<ECS公网IP>:~/ && ssh user@<ECS公网IP> 'tar xzf heijin.tar.gz'
```

配置并启动：
```bash
cd deploy
cp env/.env.production.example .env
# 编辑 .env：JWT_SECRET_KEY 用 `openssl rand -hex 32` 生成，CORS_ORIGINS 填你的域名
nano .env

# 首次部署时设置管理员密码；脚本会在迁移完成后创建/更新 admin 账号。
export ADMIN_PASSWORD='请替换为至少 8 位的强密码'

chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

浏览器访问 `http://<ECS公网IP>/` 即前端；API 在 `http://<ECS公网IP>/api/v1`。

---

## 五、（可选）域名 + HTTPS

```bash
# 1. 域名解析 A 记录指向 ECS 公网 IP
# 2. 安装 certbot 并签发（需先放行 80/443，且 80 此时被 nginx 占用——可临时停服或用工期webroot）
sudo apt install -y certbot
sudo certbot certonly --standalone -d your-domain.com
# 3. 把证书挂进 frontend 容器，nginx.conf 增加 443 监听（见下方说明）
```

> 生产建议强制 HTTPS：在 `frontend/nginx.conf` 增加 `listen 443 ssl` 并将证书挂载到容器，同时 80 重定向到 443。证书续期：`certbot renew`。

---

## 六、运维

```bash
docker compose ps                 # 状态
docker compose logs -f backend    # 看后端日志
docker compose restart            # 重启
docker compose down               # 停止
docker compose pull && docker compose up -d   # 更新（若镜像改了需先 build）
```

**数据备份**（SQLite 单文件）：
```bash
docker compose exec -T backend tar czf - -C /app data > erp_db_$(date +%F).tar.gz
# 恢复：docker compose down; 解包到卷；docker compose up -d
```

---

## 七、生产注意事项

1. **JWT_SECRET_KEY 必须替换**，否则任何人可伪造 token。
2. **CORS_ORIGINS** 填真实域名；同源反代下也可留空，但显式更安全。
3. **SQLite 单写点**：当前为单实例单进程（uvicorn 单 worker），足够 ERP 内部使用。若后续并发高或要主备，把 `DATABASE_URL` 换成 PostgreSQL（`postgresql+psycopg://...`）——业务代码零改动，`alembic upgrade head` 即可建表。
4. **备份**：SQLite 是单文件，按第六节定期打包 `data` 卷即可；换 PG 后改用 `pg_dump`。
5. 数据库与旧库（`heijin.db`/`heijin_v2.db`）物理隔离，配置已强制校验，勿手动改 `DATABASE_URL` 指向旧库。
