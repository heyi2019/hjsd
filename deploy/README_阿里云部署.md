# 宜游轩 ERP · 阿里云部署指南

> 当前发布状态（2026-11-02 实测）：阿里云 ECS 已运行 PostgreSQL 16（`deploy-db-1` healthy），后端经 `postgresql+psycopg` 连接库 `heijin_erp`。生产库实测 **Alembic 版本 `0003`、41 张表、业务数据全空**（`orders`/`stocks`/`cashflow` 均 0），仅存 2 个登录账号与 29 条审计日志。而活动迁移链已压平为单一 `0001`——`0002→0013` 已不存在，`alembic upgrade head` 会在解析 `0003` 时失败。首次上线按既裁决走**覆盖式重建**（删除旧库、从上线包恢复），**不得用 stamp 冒充已升级**（详见 `docs/ERP_数据库架构检查与治理方案_V1.1_20261103.md` 第一、五节）。
>
> **数据库引擎切换与部署脚本同步已完成（2026-11-02）。** ECS 上 `deploy/scripts/` 三件（`backup_daily.sh` / `deploy.sh` / `pull_backup.sh`）此前仍是 SQLite 旧版，已于 11-02 23:47 与仓库同步并实测（每日备份改为 `pg_dump -Fc` + 三重完整性闸门）。下文标记为「历史 SQLite 流程」的内容仅供回退与取数参考，不得用于 PostgreSQL 正式备份。

## 零、当前发布模型与切库门槛

```text
GitHub Actions（linux/amd64 构建）
  ├─ heijin-backend:<version>
  ├─ heijin-frontend:<version>
  └─ postgres:16-alpine（必须随离线包预置，ECS 不依赖 Docker Hub 拉取）
              ↓
阿里云 ECS / Docker Compose
  ├─ db       PostgreSQL，持久卷 erp_pgdata，仅绑定 127.0.0.1:5432
  ├─ backend  DATABASE_URL 指向 db:5432
  └─ frontend 对外暴露 80/443
```

数据库发布分为两个明确阶段：

1. **已完成的切库**：SQLite 数据已导入 PostgreSQL，`erp_pgdata` 为正式业务数据卷；原 SQLite 卷在验收期保留，只作回退依据。
2. **后续应用发布**：只发布经 CI 验证的应用镜像与部署文件；数据库结构由 Alembic 升级，数据备份改为 PostgreSQL 的 `pg_dump` / `pg_restore`。

切库前必须全部满足以下条件：

- 发布离线包包含 `postgres:16-alpine`，或 ECS 已通过受验证的镜像源预拉并校验该镜像；不能假定 Docker Hub 可访问。
- `deploy/.env` 配置强随机 `POSTGRES_PASSWORD` 与 PostgreSQL `DATABASE_URL`，且 PostgreSQL 端口不对公网开放。
- 线上数据库版本 `0064` 已只读核对；发布前必须在备份副本上演练「空库建到 `0001` + 数据导入」，通过行数、关键表、管理员登录、业务读写与健康检查验证。
- 自动发布脚本能显式执行、记录并校验迁移；失败时保持 SQLite 原卷和 PostgreSQL 空卷，不能半切换。
- PostgreSQL 备份、恢复和异地留存已演练；旧的 SQLite 备份脚本不可继续充当正式数据库的灾备方案。

---

## 一、本地构建注意事项（macOS + Docker Desktop 已实测通过）

完整跑通 `docker compose build` + `up`，后端健康检查与 nginx 同源反代均正常。两个实战踩坑已修进部署包：

1. **后端基础镜像用 `alpine:3.20`（Python 3.12.13），前端运行阶段同样用 alpine + apk nginx，前端构建阶段用 `node:22-alpine`**：镜像为 `deploy-backend` **207MB** + `deploy-frontend` **20.3MB**（此前 slim/nginx-alpine 方案为 299MB + 78.4MB）。四项前提已验证：
   - 全部 24 个依赖在 **x86_64 与 aarch64 的 musllinux 上都有预编译 wheel**（用 `pip download --only-binary=:all: --platform musllinux_1_1_x86_64 --platform musllinux_1_2_x86_64` 实测，零源码编译，故镜像内无需 gcc）；
   - **`tzdata` 必须装**（Dockerfile 已含）：alpine 默认无时区库，缺失会让 `datetime.now()` 落 UTC，与国内 +8 差 8 小时，跨日订单与对账日期会错位；
   - **alpine 无 `python` 软链**，Dockerfile 已补 `/usr/local/bin/python -> /usr/bin/python3`，否则 `deploy.sh` 里既有的 `python scripts/*.py` 调用全部报 `not found`；`docker-compose.yml` 的 healthcheck 用的是 `python3`，不可写成 `python`。
   - **前端构建阶段用 `node:22-alpine`**（原 `node:20-alpine`）：node 20 已接近 EOL，且实测两者产出**字节级一致**——`dist/assets/index-*.js` 的 hash 同为 `index-BgcbdH21.js`，换版本不改产物。选择 22 的额外好处是本机已有该镜像，Docker Hub 不通时仍能离线构建。
   ⚠️ **上线前先在 ECS 上 `docker pull alpine:3.20 node:22-alpine` 确认镜像源能拉到**——这两个是构建硬依赖，任一拉不到会直接中断构建。注意源里要有 `alpine` 与 `node`，不能只有 `python` 系列。
   ⚠️ **构建缓存被清后即失去离线能力**：`docker builder prune -af` 会删掉 base 镜像的 metadata 缓存。若无外网且本地无 `node:22-alpine`/`alpine:3.20` 镜像，`docker compose build` 会在 `FROM` 行就报 TLS handshake timeout。
   ⚠️ 后续往 `requirements.txt` 加运行时依赖时，必须确认该包有 musllinux wheel，否则 ECS 上会因缺编译器构建失败；改完须重新 `pip-compile requirements.txt -o requirements.lock.txt --strip-extras` 生成锁定文件（生产镜像装的是 requirements.lock.txt 而非 requirements.txt）。
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

## 二、阿里云 ECS 选购清单（推荐）

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

## 三、购买步骤（阿里云控制台）

1. 进入 **ECS 控制台 → 实例 → 创建实例**。
2. 基础配置：选地域、实例规格（2核4G）、镜像（Ubuntu 22.04）。
3. 存储：系统盘 ESSD 40G。
4. 带宽：公网带宽按固定 5Mbps（或按使用流量）。
5. 安全组：新建/选用已放行 22/80/443 的安全组。
6. 登录方式：**密钥对**（推荐）或 root 密码（务必强密码）。
7. 确认下单，等待实例「运行中」，记下 **公网 IP**。

---

## 四、服务器初始化（SSH 登录后）

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

## 五、部署项目（历史 SQLite 流程，仅用于现网回退与数据取证）

> 本节命令尚未切换到 PostgreSQL，不能用于新的切库发布。切库上线应以本文「零、当前发布模型与切库门槛」为准，待离线 PostgreSQL 镜像、环境变量、自动迁移、备份恢复四项接入后，再补充可执行的正式 runbook。

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
# 编辑 .env：JWT_SECRET_KEY 用 `openssl rand -hex 32` 生成（≥32 位，否则生产启动校验拒绝）。
# CORS_ORIGINS：前端由 nginx 同源反代 /api/v1/，浏览器不跨域，可整行删除或留空；
#   仅当前端部署在独立域名/端口时才填（生产禁止 *）。
nano .env

# 首次部署时设置管理员密码；脚本会在迁移完成后创建/更新 admin 账号。
# 密码不要写进 .env：该文件由 env_file 注入 backend 常驻进程环境。此处临时 export 即可。
export ADMIN_PASSWORD='请替换为至少 12 位的强密码'

chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

`deploy.sh` 依次执行：构建镜像 → （库已存在则）迁移前备份 → `alembic upgrade head` →
**预置经营规则定义与默认版本（幂等）** → 启动服务 → 创建管理员 → 健康检查。

> 为什么必须预置经营规则：规则编码是系统闭集（REBATE / COMMISSION / INSTALLMENT / WRITE_DOWN / REFUND / DG_MIXED），
> 迁移只建表不预置。缺定义时 `make_snapshot` 返回空快照且**不报错**——下单不失败，但返点/提成/分期规则静默失效。

浏览器访问 `http://<ECS公网IP>/` 即前端；API 在 `http://<ECS公网IP>/api/v1`。

### 存量旧库（带旧版本戳）怎么办

迁移在发布前已压平为单基线 `0001`，旧版本戳（`0002`~`0023`）归档不再参与解析。`deploy.sh` 的迁移步骤是
`alembic upgrade head || python scripts/stamp_baseline.py`，与容器启动的 CMD 一致：

- 版本戳是旧号、但**结构已等价** → `stamp_baseline.py` 自动对齐到 `0001` 并继续部署；
- 版本戳是旧号、且**结构落后** → 打印缺口清单（缺表 / 缺列 / 缺索引）并**报错退出**，
  绝不把落后的库伪装成已迁移。

遇到第二种（旧库结构落后）时，先取备份再决定：

```bash
# 1) 先把库取到宿主机 —— 这是唯一必须保留的东西（pg_dump 自定义格式 + sha256）
bash scripts/backup_daily.sh
# 产物：deploy/../backups/heijin_erp_pg_<时间戳>.dump（+ .sha256），落在宿主机磁盘

# 2-A) 库内数据不要 → 删卷重建，走首次部署流程
docker compose down -v      # ⚠ 会连同 PG 数据卷 erp_pgdata 一起删除，务必先做完第 1 步

# 2-B) 库内数据要保留 → 不要删卷；先把缺口补齐（或把数据导出到新库重导），再跑 deploy.sh
```

### 首次上线后必做（空库起始时）

| 顺序 | 事项 | 说明 |
|---|---|---|
| 1 | 核对经营规则配置 | 预置版本是占位口径（返点 5%、分期 3 期等），在「设置 → 经营规则」按实际改；每次保存生成新版本并发布 |
| 2 | 建团队 | `teams` 空库为 0 条；不影响登录（用户 `team_ids` 默认 `[]`），但团队管理页是空的 |
| 3 | 补游戏类型 | 空库只有 2 类（迁移内置），按实际在收的游戏补齐 |
| 4 | 核对资金池 | 空库只有 `HJ_INVEST` / `HJ_PROFIT`；运营支出若需独立池，手工新建 |

---

## 六、（可选）域名 + HTTPS

```bash
# 1. 域名解析 A 记录指向 ECS 公网 IP
# 2. 安装 certbot 并签发（需先放行 80/443，且 80 此时被 nginx 占用——可临时停服或用工期webroot）
sudo apt install -y certbot
sudo certbot certonly --standalone -d your-domain.com
# 3. 把证书挂进 frontend 容器，nginx.conf 增加 443 监听（见下方说明）
```

> 生产建议强制 HTTPS：在 `frontend/nginx.conf` 增加 `listen 443 ssl` 并将证书挂载到容器，同时 80 重定向到 443。证书续期：`certbot renew`。

---

## 七、运维

```bash
docker compose ps                 # 状态
docker compose logs -f backend    # 看后端日志
docker compose restart            # 重启
docker compose down               # 停止
docker compose pull && docker compose up -d   # 更新（若镜像改了需先 build）
```

**数据备份**（`pg_dump -Fc` 在线快照；`deploy.sh` 每次部署前自动执行一次，默认保留 30 份。
**日常快照必须另挂 `backup_daily.sh` 的 cron**——两次部署之间不会有任何备份）：
```bash
bash deploy/scripts/backup_daily.sh
# 产物：deploy/../backups/heijin_erp_pg_<时间戳>.dump + 同名 .sha256
# 位置：宿主机磁盘（不在 docker 卷里，down -v 不会带走）

# 恢复：先停 backend → 单事务 pg_restore → 自动重启；恢复前会自动再备份一次当前库
bash deploy/scripts/restore_pg.sh --backup /opt/heijin/backups/heijin_erp_pg_<时间戳>.dump --yes
```

> **不要用 `tar` 直接打包 PG 数据目录**：运行中的 `pgdata` 不是一致快照。`pg_dump` 在 db 容器内执行、
> 无需停服；产物为自定义格式归档，恢复走 `pg_restore --single-transaction`——失败整体回滚，不会留下半套表。

### 备份异地留存（必做，否则不构成灾备）

`backup_daily.sh` 已把备份写在**宿主机磁盘**（默认 `/opt/heijin/backups`），不在 docker 卷里，
`down -v` 不会带走它。但它仍与库同一台机器：磁盘故障、机器丢失、欠费停机都会让「库 + 备份」一起消失——
只能防部署失败，不能防灾难。

两步补齐：

**① ECS 上每日自动备份**（部署时备份只在部署前触发，日常不产生快照）：
```bash
# deploy/scripts/backup_daily.sh 已随仓库上传；db 容器未就绪时明确报错退出，不会伪装成功
crontab -e
20 3 * * * /bin/bash /opt/heijin/deploy/scripts/backup_daily.sh >> /var/log/heijin_backup.log 2>&1
```

**② 本机（或另一台机器）每日拉取**，形成物理分离的第二份：
```bash
# 首次手动执行，确认 SSH 免密与远端备份目录（默认 /opt/heijin/backups）
bash deploy/scripts/pull_backup.sh --host root@<ECS_IP>

# 成功后再挂 cron（本机每日 04:10 拉一次，保留 30 份）
10 4 * * * /bin/bash /path/to/黑金时代/deploy/scripts/pull_backup.sh --host root@<ECS_IP> >> ~/heijin_pull.log 2>&1
```

脚本行为与安全语义：

| 项 | 说明 |
|---|---|
| 传输 | `ssh` + 远端 `tar` 流式拉到本机，只搬备份目录，不碰容器与卷 |
| 校验 | 每份比对 `.sha256` sidecar + `pg_dump` 归档魔数（PGDMP） |
| **失败保护** | 先落 `$DEST/.incoming` 暂存区，**全部校验通过才原子替换**；校验失败时本地一份不动，坏备份留在暂存区供排查 |
| 保留 | 本地滚动保留最近 N 份（默认 30），文件名时间戳即排序依据 |
| 默认目录 | `~/heijin_backups`（可用 `--dest` 或 `ERP_BACKUP_DEST` 覆盖） |

> 若 ECS 与本机之间无公网可达（本机在 NAT 后），改为 ECS 侧推送对象存储：
> `ossutil cp /app/data/backups/ oss://<bucket>/heijin/ -r -u`，再本地按需下载。

恢复演练（建议每季度做一次，验证备份真的能用）：
```bash
# 本机校验通过的最新一份 → 传回 ECS → 用 restore_pg.sh 回滚
bash deploy/scripts/pull_backup.sh --host root@<ECS_IP> --dest /tmp/restore_check
ls -1t /tmp/restore_check/*.dump | head -1
```

---

## 八、生产注意事项

1. **JWT_SECRET_KEY 必须替换**，否则任何人可伪造 token。
2. **CORS_ORIGINS**：前端经 nginx 同源反代访问 API，浏览器不跨域，**留空即可**（留空 = 不启用 CORS，是正确状态）；仅当前端独立域名时才填真实来源，生产禁止 `*`（启动校验会拒绝）。
3. **公网 IP 不是 HTTPS**：`http://<ECS公网IP>` 仅适合临时受控验收；账号密码和令牌不能在这种连接上长期传输。正式开放前必须绑定域名、签发证书，并强制将 80 跳转到 443。裸 IP 通常无法取得受浏览器信任的 TLS 证书。
4. **安全组最小开放**：80/443 可对公网开放；SSH 22 必须仅允许运维人员的固定公网 IP。不要将 8123、数据库端口或 Docker API 映射/开放到公网。
   - 主机侧可执行 `sudo bash deploy/scripts/harden_host.sh`（须用普通 sudo 用户，脚本拒绝 root 运行）：关闭密码与 root 登录、`MaxAuthTries 3`、ufw 默认拒绝入站仅放行 22/80、fail2ban 封禁 SSH 爆破、自动安装安全更新。
   - **两层防护分工**：脚本的 ufw 对 22 是全网放行，IP 白名单由云安全组负责；只做一层等于没做。
   - 执行后**保持当前 SSH 会话不退出**，另开终端确认密钥登录成功后，再关闭原会话。
5. **网关防护已内置**：Nginx 会限制单 IP 并发、对 API 限流，并对登录接口执行更严格的限流（超额返回 429）；同时发送防点击劫持、MIME 嗅探和权限策略响应头。生产 API 文档（`/docs`、`/redoc`、`/openapi.json`）已关闭。
6. **正式数据库目标**：PostgreSQL 使用 `erp_pgdata` 持久卷，服务端口只能绑定 `127.0.0.1:5432`；业务容器经 Compose 内网访问，安全组不开放 5432。
7. **切库纪律**：不得直接修改 `DATABASE_URL` 让线上服务指向空 PostgreSQL。必须先冻结写入、备份 SQLite、执行迁移工具、校验数据和业务链路，再完成流量切换；旧 SQLite 卷在验收期内保留，作为可验证的回退源。
8. **备份**：正式备份 = `deploy/scripts/backup_daily.sh`（db 容器内 `pg_dump -Fc` + `.sha256` + 完整性闸门 + 宿主机滚动保留），恢复 = `restore_pg.sh`（校验和 → 单事务 `pg_restore` → 自动重启 backend）。SQLite 备份链（`backup_db.py`/`restore_db.py`）已下线，不要再用；也不要对运行中的 PG 数据目录直接 `tar`。
9. 数据库与旧库（`heijin.db`/`heijin_v2.db`）物理隔离；切库前勿手动改 `DATABASE_URL` 指向历史库，切库后勿将其改回 SQLite 以规避 PostgreSQL 故障。
