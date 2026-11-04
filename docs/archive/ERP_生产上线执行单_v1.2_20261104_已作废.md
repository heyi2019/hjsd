# 宜游轩 ERP·生产上线执行单（覆盖式重建 + 换代码）

**文件编号**：ERP-OPS-001　**版本**：v1.2
**运行域**：工作经营　**阅读对象**：上线执行人（现场逐条照做）
**编写日期**：2026-11-04　**编写人**：何一（AI 协助整理，命令与检查点经实测核对）
**适用前提**：生产库 `heijin_erp` 业务数据为空（2026-11-02 实测 orders/stocks/cashflow 全 0），用 Release 包**整体覆盖**，不做数据合并、不跑增量迁移；同时把 ECS 上 11-01 的旧镜像换成当前代码。
**配套文档**：`docs/ERP_数据库架构检查与治理方案_V1.1_20261103.md`（现状、未闭环清单、上线路径与踩坑结论）

**版本记录**

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-11-03 | 覆盖式重建库的逐条命令、检查点、回滚 |
| v1.1 | 2026-11-03 | 补 B0「换代码」（原单只重建库、不换镜像，会得到新库配旧代码）；B6 与 D 段显式传 `APP_VERSION`；E 段补遗留 |
| v1.2 | 2026-11-04 | 上线包换为 `release_20261104_022127.dump`（种子已删 39 个「补充N」占位字段，**220 字段**），sha/大小/复检记录同步，5 处包名一并替换；C1 增加字段数验收；提交数等会随时间漂移的量改为现场取数 |

---

## 0. 常量（照抄，不要凭记忆改）

| 项 | 值 |
|---|---|
| SSH | `ssh heijin-prod`（root） |
| 部署目录 | `/opt/heijin/deploy` |
| 库 / 用户 | `heijin_erp` / `erp_app`（容器网络内 `db:5432`） |
| 上线包 | `release_20261104_022127.dump`（218,747 B） |
| 上线包 sha256 | `27a1fb121b1f9e078e2fca857aa7b32aa9f0a8fcbd26e5ac48157c36c3286c5e` |
| 回滚包 | `prod_final_20261102_234555.dump`（198,322 B，**已在 ECS `/opt/heijin/backups/`**） |
| 新镜像 tag | `1.0.2`（backend / frontend 同名，由 B0 构建） |
| 旧镜像 tag | `1.0.1`（ECS 已有，**回滚底座，全程不得删除**） |
| 代码指纹 | B0.3 提交的 `git rev-parse --short HEAD`，现场抄进本表 |
| 期望终态 | 40 表 / `alembic_version=0001` / 119 单 / 90 库存 / 370 流水 / 200 事件 / 6 用户 / 0 客户 / 0 分期 / 0 返点 / **220 字段** / **63 选项集** / `policy_definitions` 0 条 |

> **字段数 220 是本次上线的判别点**：种子（`catalog_seed.py` 的压缩 blob）、三个库、上线包三处已同步为 220（原 259 含 39 个「补充1…补充39」占位字段，已全部删除）。C1 若查到 **259**，说明恢复的是 11-03 的旧包 —— 停手重做 B1，不要往 C2 走。
>
> 上线包内自带 `alembic_version=0001`，**恢复后不要跑 `alembic upgrade head`**——那是 no-op，跑了会让人误以为做过迁移。（后端镜像启动命令里自带一次 `alembic upgrade head`，对 `0001` 库同样是 no-op，属预期。）

---

## A. 上线前（逐项打勾，缺一项不开窗口）

- [x] Release 库内容校验：40 表、119/90/370/200、0 客户、0 分期、0 返点、220 字段、63 选项集
- [x] 账号对齐生产：`admin`(id1) / `19873133890`(id2)，含原口令哈希
- [x] **预置员工账号 4 名**：`sansan`三三(ADMIN)、`xiaoxuan`小轩、`jixiang`吉祥、`kaiwen`凯文（后三人 OPERATOR），`owner_scope=ALL`、`pool_ids=[1,2]`、`must_change_password=true`；四人均实测登录 200，OPERATOR 访问 `/users` 返回 403。初始口令见交付说明，**首次登录强制改密**。
- [x] **上线包定稿与复检（交付物本身，2026-11-04 02:21）**：`release_20261104_022127.dump`，218,747 B，sha256 `27a1fb12…c3286c5e`，TOC 40 条 `TABLE DATA`。恢复到空库（`--no-owner --single-transaction`，用完已删）后逐项核对：**40 表 / `0001` / 119 单 / 90 库存 / 370 流水 / 200 事件 / 6 用户 / 0 客户 / 0 分期 / 0 返点 / 220 字段 / 63 选项集 / `policy_definitions` 0 条**；余额 投资款荷包 **57,579.17**（259 笔）、利润荷包 **54,253.06**（109 笔）。**要点：被验的是交付上线的那个包，不是更早的版本之一。**
- [x] 回滚包双端留档（ECS + 本地 sha256 一致）
- [x] ECS 备份/取回脚本已同步为 PG 版，cron `20 3 * * *` 生效
- [x] `restore_pg.sh` 已补齐到 ECS（sha256 双端一致、`bash -n` 通过）
- [ ] **B0 全部完成**（新镜像已在 ECS `docker load` 完成、源码侧四个文件已同步、结构一致性校验差异 0 条）
- [ ] 上线窗口确定（选低峰；**窗口内约 20 分钟**，构建已在窗口前完成）

---

## B0. 换代码（窗口前完成，不影响线上）

### B0.0 为什么必须单独做这一步

| 实测项 | 值 |
|---|---|
| ECS 正在跑 | `heijin-backend:1.0.1` / `heijin-frontend:1.0.1`（11-01 06:03 构建）。B6 前现场用 `ssh heijin-prod 'docker ps --format "{{.Image}}"'` 复核 |
| 代码落差 | 本地 `dev` 领先 `origin/main` 若干提交（**编写本单时为 217**；上线当天现场取：`git rev-list --count origin/main..dev`，做完 B0.3 的版本提交后 +1） |
| 版本事实源 | `backend/app/version.py` 的 `__version__`，当前 `1.0.1`；CI 与 `deploy.sh` 都从这里解析镜像 tag |
| ECS 已有镜像 | `1.0.0`、`1.0.1`（backend / frontend 各一） |
| ECS `deploy/.env` 的 `APP_VERSION` | **`1.0.0`**（残留值，不等于正在跑的 1.0.1；B0.7 改掉） |

**只重建库、不换镜像＝新库配旧代码。** 上线包的 40 表结构由**当前 ORM** `create_all` 生成，而 `1.0.1` 镜像的 ORM 停在 10-31，缺这期间新增的列与字段。恢复会成功、`/health` 可能返回 ok，但第一个查新列的请求就 `column ... does not exist`。

### B0.1 三条硬约束（违反任一条，C 段验收必挂）

1. **不许走 `deploy.sh`**——包括 GitHub Actions 的 `deploy-production.yml`（它就是调 `deploy.sh`）。原因：
   - `scripts/stamp_db_version.py` 内部 `_AUDIT_METADATA.create_all(checkfirst=True)` 会**自建 `db_version` 表** → 表数 40 变 **41**，C1 期望直接失败（生产现在的 41 表就是这么来的）；
   - `scripts/seed_policy_definitions.py --apply` 会写入规则定义与默认版本，破坏「`policy_definitions` 0 条」这一已验证基线；
   - 顺带澄清：ECS `.env` **没有** `ADMIN_PASSWORD`，`create_admin` 走 else 分支、**不会**重置 `admin` 口令——这条风险实测不存在，但前两条成立。
2. **起容器必须显式传 `APP_VERSION=1.0.2`**：`docker-compose.yml` 是 `image: heijin-backend:${APP_VERSION:-latest}`，而 ECS `deploy/.env` 里残留 **`APP_VERSION=1.0.0`**、且 ECS 上 1.0.0 镜像**还在**——不传参就静默起回 1.0.0（比 1.0.1 更旧）。
3. **构建上下文必须来自干净提交**：`backend/Dockerfile` 是 `COPY . .`、`frontend/Dockerfile` 是 `COPY frontend/ ./`，打的是**工作区**不是 git 提交。工作区常年有并发会话的未提交/未跟踪文件，直接构建会把半成品打进生产镜像。

### B0.2 锁基线：跑发版前回归

```bash
cd /Users/aries/黑金时代/backend
.venv/bin/python3 run_regression.py ci
```

**检查点**：退出码 0。此为「发版前」例外情形，允许全量；日常改动仍按针对性用例跑。

### B0.3 升版本（唯一事实源，单文件提交）

```bash
cd /Users/aries/黑金时代
# 只改这一行：__version__ = "1.0.1" → "1.0.2"
git diff -- backend/app/version.py
git add backend/app/version.py
git commit -- backend/app/version.py -m 'chore(release): 1.0.2'
git rev-parse --short HEAD          # ← 抄进第 0 节「代码指纹」
git status --short
```

**检查点**：`git status --short` 中 `backend/app/version.py` 已消失，**其余条目仍在**——那些是并发会话的在改稿，既不能随本次上线提交，也不能打进镜像。

> 严禁 `git add -A`：它会把别人的在改稿一起提交，并随 `git archive HEAD` 进入镜像。

### B0.4 从干净提交导出构建树

```bash
cd /Users/aries/黑金时代
BUILD=/tmp/heijin-build-1.0.2
rm -rf "${BUILD}" && mkdir -p "${BUILD}"
git archive HEAD | tar -x -C "${BUILD}"
grep -n '__version__' "${BUILD}/backend/app/version.py"
test ! -e "${BUILD}/frontend/node_modules" && echo "clean: no node_modules"
```

**检查点**：输出 `__version__ = "1.0.2"`；`clean: no node_modules`。构建树里不含任何未提交改动。

### B0.5 构建并导出 amd64 镜像（20–40 分钟，首次无层缓存）

```bash
cd /tmp/heijin-build-1.0.2
docker buildx build --platform linux/amd64 --load \
  -t heijin-backend:1.0.2 -f backend/Dockerfile backend
docker buildx build --platform linux/amd64 --load \
  -t heijin-frontend:1.0.2 -f frontend/Dockerfile .
docker image inspect heijin-backend:1.0.2  --format '{{.Architecture}} {{.Size}}'
docker image inspect heijin-frontend:1.0.2 --format '{{.Architecture}} {{.Size}}'
```

**检查点**：两行都以 `amd64` 开头。架构不对**别往下传**——ECS 上会 `exec format error`，而 compose 只显示 `exit 1`，现场极难联想到架构。

> **为什么在本地交叉构建而不是在 ECS `docker compose build`**：ECS 直连 Docker Hub 常 TLS 超时（`deploy.sh` 注释里的头号阻塞项），且失败点在 Dockerfile 的 `FROM` 行、报错形似代码问题。本地构建慢，但失败不污染生产、可重复、可在窗口前任意重试。
>
> **前端构建依赖后端源码**：`ui_guards.mjs` 要读 `backend/app/enums.py` 做前后端枚举对齐校验，故前端构建上下文是项目根——B0.4 导出的整棵树正是为此。

### B0.6 打包、传输、`docker load`（**保留 1.0.1 不动**）

```bash
cd /tmp
docker save heijin-backend:1.0.2 heijin-frontend:1.0.2 \
  | gzip > heijin-images-1.0.2-amd64.tar.gz
shasum -a256 heijin-images-1.0.2-amd64.tar.gz | tee heijin-images-1.0.2.sha256
scp heijin-images-1.0.2-amd64.tar.gz heijin-prod:/tmp/
```

```bash
ssh heijin-prod 'sha256sum /tmp/heijin-images-1.0.2-amd64.tar.gz'
```

**检查点一**：两端 sha256 逐字一致。不一致就重传（历史上 SFTP 出现过大文件截断）。

```bash
ssh heijin-prod 'gunzip -c /tmp/heijin-images-1.0.2-amd64.tar.gz | docker load; docker images | grep heijin'
```

**检查点二**：出现 `heijin-backend:1.0.2` 与 `heijin-frontend:1.0.2`，且 **`1.0.0` / `1.0.1` 四个旧镜像仍在**。缺了就是误用了 `docker system prune`，回滚底座已丢，停手。

### B0.7 同步镜像外的四个文件

镜像只管代码，下列文件在镜像**外**、运行时生效，必须与构建树保持一致：

| 文件 | 为什么必须同步 |
|---|---|
| `backend/app/version.py` | `deploy.sh` / `backup_daily.sh` 从它解析镜像版本，不同步会让后续部署把版本读回 1.0.1 |
| `deploy/docker-compose.yml` | 镜像引用方式与 healthcheck 定义 |
| `frontend/nginx.conf` | **宿主机文件以只读方式覆盖镜像内 `/etc/nginx/conf.d/default.conf`**，不同步＝新镜像配旧站点配置 |
| `deploy/scripts/*` | `schema_diff.py` 为结构校验工具，ECS 上还没有 |

```bash
cd /tmp/heijin-build-1.0.2
scp backend/app/version.py    heijin-prod:/opt/heijin/backend/app/version.py
scp deploy/docker-compose.yml heijin-prod:/opt/heijin/deploy/docker-compose.yml
scp frontend/nginx.conf       heijin-prod:/opt/heijin/frontend/nginx.conf
for f in deploy.sh backup_daily.sh restore_pg.sh pull_backup.sh \
         export_images.sh gen_selfsigned.sh harden_host.sh schema_diff.py; do
  scp "deploy/scripts/${f}" "heijin-prod:/opt/heijin/deploy/scripts/${f}"
done
```

> **不要 `scp -r deploy/scripts`**：那会把 `pg_container.sh`（本地自建集群管理）、`backup_local.sh`、`pg_pitr_backup.sh`、`restore_drill.sh` 一并搬到生产。`pg_container.sh` 在生产误跑会尝试起第二个 PG 容器。
>
> `frontend/security-headers.conf` 与 `nginx.global.conf` **不用同步**：它们被 `COPY` 进镜像、且不被挂载覆盖，以新镜像内的版本为准。

顺手把 `.env` 里那个会坑人的残留值改掉：

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && cp .env .env.bak-$(date +%Y%m%d%H%M) \
  && sed -i "s|^APP_VERSION=.*|APP_VERSION=1.0.2|" .env && grep "^APP_VERSION=" .env'
```

**检查点**：输出 `APP_VERSION=1.0.2`，同目录出现 `.env.bak-*`。

### B0.8 结构一致性验证（决定上线包还能不能用）

用**新代码的 ORM**去比对**上线包恢复出来的库**，差异必须为 0。这是「包是旧代码打的、上线跑新代码」这类事故的唯一探针。

```bash
cd /Users/aries/黑金时代
docker exec heijin-db-1 psql -U erp_app -d postgres \
  -c 'DROP DATABASE IF EXISTS heijin_erp_drill_102 WITH (FORCE)' \
  -c 'CREATE DATABASE heijin_erp_drill_102'
docker cp backups/release_20261104_022127.dump heijin-db-1:/tmp/r102.dump
docker exec heijin-db-1 pg_restore -U erp_app -d heijin_erp_drill_102 \
  --no-owner --no-privileges --single-transaction /tmp/r102.dump
```

```bash
cd /tmp/heijin-build-1.0.2
# ERP_ENV_FILE 指向本地库配置（不然构建树里没有 .env）；解释器用仓库 venv（依赖齐全）
ERP_ENV_FILE=/Users/aries/黑金时代/backend/.env \
  /Users/aries/黑金时代/backend/.venv/bin/python3 deploy/scripts/schema_diff.py heijin_erp_drill_102
echo "schema_diff_exit=$?"
```

**检查点**：`schema_diff_exit=0`，输出无差异条目。非 0 说明上线包与新代码结构不一致 → **停**，用新 ORM 重新生成基线并重做上线包，不要在旧包上硬上。

```bash
docker exec heijin-db-1 psql -U erp_app -d postgres \
  -c 'DROP DATABASE heijin_erp_drill_102 WITH (FORCE)'
docker exec heijin-db-1 rm -f /tmp/r102.dump
```

---

## B. 上线窗口（按顺序执行，每步看检查点）

### B1. 传包并校验

```bash
# 本地
scp backups/release_20261104_022127.dump heijin-prod:/opt/heijin/backups/
```

```bash
# ECS
cd /opt/heijin/backups
sha256sum release_20261104_022127.dump
```

**检查点**：输出必须等于 `27a1fb121b1f9e078e2fca857aa7b32aa9f0a8fcbd26e5ac48157c36c3286c5e`。不等就停下重传，别往下走。

### B2. 再备份一次当前库（覆盖前最后一份）

```bash
cd /opt/heijin/deploy && bash scripts/backup_daily.sh
```

**检查点**：末行必须以 `BACKUP_OK` 开头，且过程中**没有**出现 `备份表数不一致`。注意 `objects=` 是 TOC 总对象数（约 440 量级），**不是表数**；表数闸门在脚本内部比对（归档 TABLE 定义数 vs 源库表数，当前应为 41），不通过会直接 `die`，不会产出 `BACKUP_OK`。

### B3. 停后端（断开连接，避免 DROP 被阻塞）

```bash
cd /opt/heijin/deploy && docker compose stop backend
docker compose ps --services --status running      # 只应剩 db、frontend
```

### B4. 删库重建（**不可逆点**，此步之前的备份是唯一退路）

```bash
cd /opt/heijin/deploy
docker compose exec -T db psql -U erp_app -d postgres \
  -c "DROP DATABASE IF EXISTS heijin_erp WITH (FORCE)" \
  -c "CREATE DATABASE heijin_erp OWNER erp_app"
```

**检查点**：两条命令分别输出 `DROP DATABASE` / `CREATE DATABASE`。报 `being accessed by other users` 说明还有连接，回到 B3。

> `WITH (FORCE)` 会踢掉残留连接。**不要用 `dropdb`，也不要 `down -v`**（后者连数据卷一起删，回滚包也救不了正在跑的容器）。

### B5. 恢复上线包

```bash
cd /opt/heijin/deploy
CID=$(docker compose ps -q db)
docker cp /opt/heijin/backups/release_20261104_022127.dump "$CID":/tmp/release.dump
docker compose exec -T db pg_restore -U erp_app -d heijin_erp \
  --no-owner --no-privileges --single-transaction /tmp/release.dump
echo "restore_exit=$?"
docker exec "$CID" rm -f /tmp/release.dump
```

**为什么先 `docker cp`**：`pg_restore` 读自定义格式需要可寻址文件，从 stdin/管道读会报 `could not seek in file`。

**检查点**：`restore_exit=0`。非 0 时 `--single-transaction` 已整体回滚，库是空的（不是半套），可直接重跑本步。

### B6. 换镜像并启动（**必须带 `APP_VERSION`**）

```bash
cd /opt/heijin/deploy
APP_VERSION=1.0.2 docker compose up -d
docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
```

**检查点**：`backend` / `frontend` 两行的 IMAGE 列都是 `…:1.0.2`，`db` 仍是 `postgres:16-alpine` 且未被重建；backend 变 `healthy`。

> **不带 `APP_VERSION` 就 `up -d`，会起 1.0.0**（`.env` 残留值 + 1.0.0 镜像还在）。看到 IMAGE 是 `1.0.0` 立刻重跑本步，不要去查库。
>
> **不要走 `deploy.sh`**：它内含 `alembic upgrade head`（对 `0001` 是 no-op，无害）、`stamp_db_version.py`（自建 `db_version` 表 → 41 表）、`seed_policy_definitions.py`（写入规则定义）。后两者会破坏验收基线。

---

## C. 验收（全部通过才算上线完成）

### C1. 库层

```bash
cd /opt/heijin/deploy
docker compose exec -T db psql -U erp_app -d heijin_erp \
  -c "select version_num from alembic_version" \
  -c "select count(*) tables from information_schema.tables where table_schema='public'" \
  -c "select (select count(*) from orders) orders,(select count(*) from stocks) stocks,(select count(*) from cashflow) cf,(select count(*) from order_events) ev,(select count(*) from users) users" \
  -c "select (select count(*) from order_form_fields) fields,(select count(*) from option_sets) optionsets,(select count(*) from policy_definitions) policies"
```

**期望**：`0001` / **40** / **119 · 90 · 370 · 200 · 6** / **220 · 63 · 0**

> 看到 **41** 表，说明有人跑过 `deploy.sh` 或 `stamp_db_version.py`（它自建 `db_version` 表）。这不是数据问题，是流程走错了——按 E 段处理，别把它当验收通过。
>
> 看到 **259** 字段，说明恢复的是 11-03 旧包（含 39 个已删的「补充N」占位字段）。按 D 段回滚后重做 B1。

### C2. 余额（口径必须带 `direction`）

```bash
docker compose exec -T db psql -U erp_app -d heijin_erp -c "
select p.code, sum(case when c.direction='IN' then c.amount else -c.amount end) balance
from pools p left join cashflow c on c.pool_id=p.id and c.status='APPROVED'
group by p.code order by p.code"
```

**期望**：`HJ_INVEST 57579.17`、`HJ_PROFIT 54253.06`

> 不要用 `sum(amount)`——那是收入与支出绝对值相加（744,382.61），是错的。

### C3. 版本戳预检不误拦

```bash
docker compose run --rm --no-deps backend alembic current 2>&1 | tail -3
```

**期望**：`0001 (head)`，**不含** `Can't locate revision`。

### C4. 业务冒烟（必做，别跳）

1. 浏览器登录 `admin` → 能进主界面；
2. 进「设置 → 表单字段」→ 字段列表里**没有**「补充1…补充39」这类占位项，总数与 C1 的 220 一致；
3. 建一笔 HS 回收单 → 库存列表能看到该账号（库存条数 +1）；
4. **取消该单必须走冲销，不是直接取消**（见下）；
5. 取消后：库存列表该账号消失（条数回到原值）、账号详情显示已终止；
6. 打开资金页 → 两池余额与 C2 **完全一致**（冲销把 BUY 那笔反向抵消）。

> **第 4 步的坑（2026-11-03 01:00 实测）**：HS 建单自带 `initial_buy`，建单即产生一条已登记 `BUY` 事件，此时直接调取消会被拦下：
>
> ```
> POST /orders/{id}/cancel  →  422 VALIDATION_ERROR
> 订单已有登记事件，不能直接取消，请先冲销
> ```
>
> 顺带：对业务事件的流水直接调 `POST /cashflows/{id}/reverse` 也会被拒（`业务事件现金流必须通过业务事件冲销`）。正确路径是**在订单上登记取消事件并指向被冲销的那笔**：
>
> ```
> POST /orders/{id}/events
> {"event_type":"CANCEL","amount":"<与被冲销金额一致>","occurred_on":"<日期>",
>  "offset_event_id":<BUY 事件 id>,"pool_id":<原资金账户>,"reason":"..."}
> ```
>
> UI 里就是「更多 → 取消」触发的冲销登记，不需要手工拼请求——写在这里是为了让你在接口层排查时知道该看哪条路径。

> 健康检查只证明进程起来了，**不证明写路径可用**。这六步覆盖「登录 → 配置页字段数 → 写订单 → 生成库存 → 冲销取消 → 库存退出 → 余额回归」整条链路。

### C5. 前端可达

`https://<域名>` 打开无 502/白屏；`/api/v1/health` 返回 `database_status: ok`，且 `app_version` 为 **`1.0.2`**。

> `app_version` 仍是 `1.0.1` 或 `1.0.0`，说明 B6 没带 `APP_VERSION`（或前端容器没重建）。这是最容易漏看的一项，放在最后一行专门确认。

---

## D. 回滚（任一步失败，30 分钟内可退回上线前状态）

```bash
cd /opt/heijin/deploy
docker compose stop backend

docker compose exec -T db psql -U erp_app -d postgres \
  -c "DROP DATABASE IF EXISTS heijin_erp WITH (FORCE)" \
  -c "CREATE DATABASE heijin_erp OWNER erp_app"
CID=$(docker compose ps -q db)
docker cp /opt/heijin/backups/prod_final_20261102_234555.dump "$CID":/tmp/rollback.dump
docker compose exec -T db pg_restore -U erp_app -d heijin_erp \
  --no-owner --no-privileges --single-transaction /tmp/rollback.dump
docker exec "$CID" rm -f /tmp/rollback.dump

APP_VERSION=1.0.1 docker compose up -d          # ← 必须显式回退镜像
docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
```

**回滚后状态**：41 表（含遗留 `db_version`）/ `alembic_version=0003` / 业务数据全空 —— 即上线前原样；IMAGE 列回到 `1.0.1`。

> ⚠ 回滚**必须搭配旧镜像 `1.0.1`**，且 `APP_VERSION` 必须显式传。新镜像的活动链只有 `0001`，面对 `0003` 会报 `Can't locate revision`：后端镜像的启动命令自带 `alembic upgrade head`，容器会**直接起不来**（`restart: unless-stopped` 无限重启）。这是预期行为，不是新故障。不传 `APP_VERSION` 则退到 1.0.0，比 1.0.1 更旧。

> ⚠ 不要用 `restore_pg.sh` 做回滚或上线恢复：它走 `--clean`，**只删备份里包含的对象**，库里多出来的表（如 `db_version`）会残留（沙箱实测 41 表而非 40）。这是本流程坚持「先 DROP 再空库恢复」的原因。

---

## E. 已知遗留（不影响上线，登记备查）

| 项 | 影响 | 处理时机 |
|---|---|---|
| **`dev` 领先 `origin/main`（编写时 217 个提交），本次不经 main 上线** | 线上代码无对应 main 提交；CI 不会自动打 tag | 上线成功后手工 `git tag -a v1.0.2 <B0.3 指纹>` 并推送；随后单独治理 dev→main 合流 |
| **CI `deploy-production.yml` 与本执行单互斥** | 它 push main 即调 `deploy.sh`：`stamp_db_version.py` 自建 `db_version` 表（→41 表）、`seed_policy_definitions.py` 写规则定义，都会破坏本单验收基线 | 合流前先改造 CI（构建与部署分离，或从部署路径移除 stamp/seed），否则不要 push main |
| **`CUSTOMER.trade_role`（`order_form_fields.id=160`）待裁决** | 它是**档案级**客户角色，与已裁决的「客户角色按单判定、档案不设固定类型」冲突 | 若在本次上线前决定停用：需同步 `catalog_seed.py` blob + dev/test/release 三库 + **重导上线包**，则第 0 节包名/sha 与 A 段复检须一并更新 |
| **ECS `deploy/.env` 残留 `APP_VERSION=1.0.0`** | 任何不带参的 `docker compose up -d` 都会把线上打到 1.0.0 | B0.7 已改为 `1.0.2`；今后每次发版都要同步这一行 |
| `deploy/scripts/deploy.sh` 注释里引用文档名与版本号 | 违反 `docs/README.md` 维护规则（代码不得引用文档），文档升版即腐化 | 下次改该脚本时一并改为只写行为约束 |
| 119 单 `owner_id` 全为 1 → 归属人显示「系统管理员」 | 仅展示层 | 上线后按需改 id=2 |
| `19873133890` 的 `must_change_password=true`（生产原值） | 首次登录要求改口令 | 上线后自行决定 |
| 0 客户档案 | 客户维度报表为空 | 上线后正常建单逐步补录 |
| 分期 0 / 返点 0 | 业务事实上不存在，非漏导 | 无需处理 |
| ECS 的 PG `archive_mode=off` | 生产库无 PITR，只有每日 dump | 上线后尽快按本地已验证的物理基备 + WAL 归档方案补齐 |

---

## F. 时间线（参考）

**窗口前（可提前任意时间做，不影响线上）**

| 段 | 内容 | 预计 |
|---|---|---|
| B0.2 | 发版前回归 | 5–10 min |
| B0.3–B0.4 | 升版本 + 导出干净树 | 2 min |
| B0.5 | 交叉构建 amd64 两镜像 | **20–40 min**（首次无缓存） |
| B0.6–B0.7 | 传包 + load + 同步源码文件 | 5 min |
| B0.8 | 结构一致性验证 | 3 min |

**窗口内（停服区间）**

| 段 | 内容 | 预计 |
|---|---|---|
| B1–B2 | 传包 + 备份 | 3 min |
| B3–B5 | 停服 + 删库 + 恢复 | 5 min |
| B6 | 换镜像启动 | 2 min |
| C1–C5 | 验收含冒烟 | 10 min |
| — | 合计 | **约 20 min** |
