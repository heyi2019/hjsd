# 宜游轩 ERP·生产升级执行单（原地增量升级）

**文件编号**：ERP-OPS-001　**版本**：v1.3
**运行域**：工作经营　**阅读对象**：上线执行人（现场逐条照做）
**编写日期**：2026-11-05　**编写人**：何一（AI 协助整理，全部数字为生产实测）
**配套文档**：`docs/ERP_数据库架构检查与治理方案_V1.1_20261103.md`（结构治理与踩坑结论）

**版本记录**

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-11-03 | 覆盖式重建库的逐条命令、检查点、回滚 |
| v1.1 | 2026-11-03 | 补 B0「换代码」；B6 与 D 段显式传 `APP_VERSION` |
| v1.2 | 2026-11-04 | 上线包换成 `release_20261104_022127.dump`（220 字段）；C1 增加字段数验收 |
| **v1.3** | **2026-11-05** | **放弃覆盖式重建**：生产已有真实业务数据（120 单 / 91 库存 / 372 流水 / 202 事件），任何 `DROP DATABASE` 都是数据事故。改为**原地增量升级**——只补新增表 + 换镜像，业务数据零改动。首个按本单执行的是 1.0.2 → 1.0.3 |
| v1.3 补录 | 2026-11-05 06:35 | 追加 **B4「售出表单三作用域补齐」** 与 **C6 验收**：下一版（含 `SALEREC/SALETH/SALEDG` 拆分）升级时须实跑 `split_sale_form_scopes.py`。**1.0.3 不含该拆分，不执行 B4**；v1.3 原有的 1.0.3 步骤与全部验收数字一字未改 |

---

## 0. 本版为何改路线（先读，别跳）

v1.2 的前提是「生产库业务数据为空，用 Release 包整体覆盖」，那在 2026-11-02 成立（当时业务表全 0）。**2026-11-05 02:01 实测已不成立**：

| 项 | 2026-11-02 | 2026-11-05 02:01（本次升级前） |
|---|---|---|
| orders | 0 | **120** |
| stocks | 0 | **91** |
| cashflow | 0 | **372** |
| order_events | 0 | **202** |
| customers | 0 | 0 |

11-04 上线后已有人实际录入 1 笔订单（119→120）。此时若沿用「删库 → 恢复 Release 包」，**这笔真实订单会被 Release 包里的 119 单覆盖掉**，且不会有任何报错。

**新路线**：结构差异用 `schema_diff.py` 实测，只补真正缺的对象；业务数据一律不动。

### 0.1 1.0.2 → 1.0.3 的结构差异（实测，不是推断）

对生产快照跑 `schema_diff.py`（新代码 ORM vs 生产库），输出**恰好 2 条**：

```
- ('add_table', Table('user_wechat_bindings', ...))
- ('add_index', Index('ix_wechat_bindings_open_id', ...))
```

即：**只多一张表 + 一个索引，既有 40 张表零列变更**。补表后重跑，差异归零。

> 这一步是整套流程的唯一判据。若将来的版本出现 `add_column` / `alter_column`，则不能只建表——必须评估在线 DDL 的锁表时间与回填顺序，本单不覆盖那种情形。

---

## 1. 常量（照抄，不要凭记忆改）

| 项 | 值 |
|---|---|
| SSH | `ssh heijin-prod`（root） |
| 部署目录 | `/opt/heijin/deploy`（compose 项目名 `deploy`，容器名 `deploy-*`） |
| 库 / 用户 | `heijin_erp` / `erp_app`（容器网络内 `db:5432`） |
| 目标镜像 tag | `1.0.3`（backend / frontend 同名） |
| 回滚镜像 tag | `1.0.2`（**必须保留**，见 D 段） |
| 代码指纹 | `dee62b1b`（`chore(release): 1.0.3`） |
| 镜像包 | `heijin-images-1.0.3-amd64.tar.gz`（52 MB） |
| 镜像包 sha256 | `0553b57cc4e465c55a140d2eedf0f204118b76ea15acdf997323abfd2b5105fc` |
| 升级前备份（本地+ECS） | `pre_upgrade_103_20261105_020115.dump`（219,480 B）<br>sha256 `7eeb06a160671ca01b86de9743aa80e0b2175d98e251caf160538fa2714c5a6f` |
| 升级前备份（`backup_daily.sh` 产出） | `heijin_erp_pg_20261105_020349.dump`（219,480 B）<br>sha256 `d556342a01531f2dd83442317b4e63aec6b70b78c90e141a70dbb99eb295eb7b3` |
| 旧回滚包（空库时代） | `prod_final_20261102_234555.dump`（198,322 B，已在 ECS） |
| 期望终态 | **41 表** / `alembic_version=0001` / 120 单 / 91 库存 / 372 流水 / 202 事件 / 6 用户 / 220 字段 / 63 选项集 / `policy_definitions` 0 条 / 余额 `HJ_INVEST 57579.17`、`HJ_PROFIT 54253.06` |

> **表数从 40 变 41 是本版的正常终态**（多的是 `user_wechat_bindings`）。v1.2 里「41 表 = 有人跑过 `deploy.sh`」的告警在 v1.3 失效——判据改为「41 表且其中含 `user_wechat_bindings`、不含 `db_version`」。

---

## A. 上线前（逐项打勾，缺一项不开窗口）

- [ ] **确认生产数据量已变化**：`orders` / `stocks` / `cashflow` 任一非 0 → 走本单；若确实全 0，可退回 v1.2 的覆盖重建（更快），但须重新核对 Release 包与 sha
- [ ] 用新代码跑 `schema_diff.py`，差异**仅**含新增表/索引；有列级变更则停手走变更评审
- [ ] 版本号已提交（`backend/app/version.py` 单文件），`git status --short` 无待提交改动混入
- [ ] amd64 双镜像已构建并 `docker load` 到 ECS，**旧镜像 `1.0.2` 仍在**
- [ ] 升级前备份双端留档、sha256 一致
- [ ] 窗口确定（**本版停机时间 = 容器重启，约 10–20 秒**，远短于 v1.2 的 20 分钟）
- [ ] **判定本次是否需执行 B4**：新镜像的 `backend/app/orders/form_scopes.py` 含 `SALEREC` / `SALETH` / `SALEDG` → 需要；只有旧 `SALE`（**1.0.3 即是**）→ 整步跳过 B4，C1 字段数期望仍为 220

---

## B0. 换代码（窗口前完成，不影响线上）

### B0.0 三条硬约束（违反任一条，验收必挂）

1. **不许 `DROP DATABASE` / `pg_restore` 覆盖**——生产已有真实数据，这是本版与 v1.2 最大的差别。
2. **不许走 `deploy.sh`**（含 CI 的 `deploy-production.yml`）：`stamp_db_version.py` 会自建 `db_version` 表（→ 42 表，破坏验收），`seed_policy_definitions.py` 会写入规则定义（破坏「`policy_definitions` 0 条」）。
3. **起容器必须显式传 `APP_VERSION=<新版本>`**：`docker-compose.yml` 是 `image: heijin-backend:${APP_VERSION:-latest}`，`.env` 里的值必须同步改，否则任何不带参的 `up -d` 都会把线上打到 `.env` 里那个旧版本。

### B0.1 升版本（唯一事实源，单文件提交）

```bash
cd /Users/aries/黑金时代
# 只改 __version__ 一行
git diff -- backend/app/version.py
git add backend/app/version.py
git commit -q -m 'chore(release): 1.0.3' -- backend/app/version.py
git rev-parse --short HEAD          # → dee62b1b，抄进第 1 节
git status --short                  # 只应剩并发会话的在改稿
```

> `-m` 必须写在 `--` **之前**，否则 git 把 `-m` 当成 pathspec 报 `did not match any file(s)`。

### B0.2 导出干净构建树

```bash
BUILD=/tmp/heijin-build-1.0.3
rm -rf "${BUILD}" && mkdir -p "${BUILD}"
cd /Users/aries/黑金时代 && git archive HEAD | tar -x -C "${BUILD}"
grep -n '__version__' "${BUILD}/backend/app/version.py"
test ! -e "${BUILD}/frontend/node_modules" && echo "clean: no node_modules"
```

**检查点**：`__version__ = "1.0.3"` + `clean: no node_modules`。

> `backend/Dockerfile` 是 `COPY . .`、`frontend/Dockerfile` 是 `COPY frontend/ ./`，打的是**工作区**。直接用工作区构建会把并发会话的半成品打进生产镜像，故必须 `git archive`。

### B0.3 构建 amd64 双镜像

本机 Docker 是 **aarch64**（Apple Silicon），必须交叉构建；架构不对在 ECS 上表现为 `exec format error`，而 compose 只显示 `exit 1`。

```bash
cd /tmp/heijin-build-1.0.3
docker buildx build --platform linux/amd64 --load -t heijin-backend:1.0.3 -f backend/Dockerfile backend
docker buildx build --platform linux/amd64 --load -t heijin-frontend:1.0.3 -f frontend/Dockerfile .
docker image inspect heijin-backend:1.0.3  --format '{{.Architecture}} {{.Os}} {{.Size}}'
docker image inspect heijin-frontend:1.0.3 --format '{{.Architecture}} {{.Os}} {{.Size}}'
```

**检查点**：两行都以 **`amd64 linux`** 开头（1.0.3 实测 backend 53,386,062 B / frontend 5,083,502 B）。有层缓存时约 3–5 分钟。

> 前端构建上下文是**项目根**：`ui_guards.mjs` 要读 `backend/app/enums.py` 做前后端枚举对齐校验。

### B0.4 打包、传输、load

```bash
cd /tmp
docker save heijin-backend:1.0.3 heijin-frontend:1.0.3 | gzip > heijin-images-1.0.3-amd64.tar.gz
shasum -a256 heijin-images-1.0.3-amd64.tar.gz | tee heijin-images-1.0.3.sha256
scp heijin-images-1.0.3-amd64.tar.gz heijin-prod:/tmp/
ssh heijin-prod 'sha256sum /tmp/heijin-images-1.0.3-amd64.tar.gz'
ssh heijin-prod 'gunzip -c /tmp/heijin-images-1.0.3-amd64.tar.gz | docker load; docker images | grep heijin | sort'
```

**检查点**：两端 sha256 逐字一致；load 后 `1.0.0` / `1.0.1` / `1.0.2` / `1.0.3` 八个镜像齐全（缺旧的就是误用了 `docker system prune`，回滚底座已丢，停手）。

### B0.5 同步镜像外的四个文件

镜像只管代码，下列文件在镜像**外**、运行时生效：

| 文件 | 为什么必须同步 |
|---|---|
| `backend/app/version.py` | `deploy.sh` / `backup_daily.sh` 从它解析镜像版本 |
| `deploy/docker-compose.yml` | 镜像引用方式与 healthcheck |
| `frontend/nginx.conf` | **以只读方式覆盖镜像内 `/etc/nginx/conf.d/default.conf`**，不同步＝新镜像配旧站点配置 |
| `deploy/scripts/*` | `schema_diff.py` 等工具 |

```bash
cd /tmp/heijin-build-1.0.3
scp backend/app/version.py    heijin-prod:/opt/heijin/backend/app/version.py
scp deploy/docker-compose.yml heijin-prod:/opt/heijin/deploy/docker-compose.yml
scp frontend/nginx.conf       heijin-prod:/opt/heijin/frontend/nginx.conf
for f in deploy.sh backup_daily.sh restore_pg.sh pull_backup.sh \
         export_images.sh gen_selfsigned.sh harden_host.sh schema_diff.py; do
  scp "deploy/scripts/${f}" "heijin-prod:/opt/heijin/deploy/scripts/${f}"
done
```

> **不要 `scp -r deploy/scripts`**：会把只应存在于本机的 `pg_container.sh`、`backup_local.sh`、`pg_pitr_backup.sh`、`restore_drill.sh` 搬上去。`pg_container.sh` 在生产误跑会尝试起第二个 PG 容器。
>
> `frontend/security-headers.conf` 与 `nginx.global.conf` **不用同步**：它们被 `COPY` 进镜像且不被挂载覆盖。

### B0.6 改 `.env`

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && cp .env ".env.bak-$(date +%Y%m%d%H%M%S)" \
  && sed -i "s|^APP_VERSION=.*|APP_VERSION=1.0.3|" .env && grep "^APP_VERSION=" .env'
```

免密登录相关（首次引入时追加一次，之后保留）：

```bash
PHONE_CODE_LOGIN_ENABLED=false
SMS_PROVIDER=disabled
WECHAT_LOGIN_ENABLED=false
WECHAT_PROVIDER=disabled
WECHAT_BIND_VERIFY_MODE=sms
```

**检查点**：`grep -E "^(APP_VERSION|PHONE_CODE_|SMS_|WECHAT_)" .env` 六行齐全。

> **为什么生产把两条免密链路都设 false**：`SMS_PROVIDER=mock` 在 `APP_ENV=production` 下会被 `sms_code_deliverable` 判定为不可投递（代码里刻意不让 mock 在生产静默"发送"），入口不会点亮；微信没有开放平台 AppID 与已备案回调域名。留着 `true` 只会得到「入口能点、点了必然失败」。真实短信通道与 AppID 到位后，改这里即可启用，无需再动代码。

### B0.7 结构差异验证（决定「只补表」是否成立）

把生产库导出到本地 drill 库，用**新代码的 ORM** 比对：

```bash
# 生产导出
ssh heijin-prod 'cd /opt/heijin/deploy && CID=$(docker compose ps -q db) \
  && docker exec "$CID" pg_dump -U erp_app -d heijin_erp -Fc -f /tmp/pre.dump \
  && docker cp "$CID":/tmp/pre.dump /opt/heijin/backups/pre_upgrade_xxx.dump \
  && docker exec "$CID" rm -f /tmp/pre.dump'
scp heijin-prod:/opt/heijin/backups/pre_upgrade_xxx.dump backups/
shasum -a256 backups/pre_upgrade_xxx.dump
ssh heijin-prod 'sha256sum /opt/heijin/backups/pre_upgrade_xxx.dump'   # 必须一致

# 本地 drill
docker exec heijin-db-1 psql -U erp_app -d postgres \
  -c 'DROP DATABASE IF EXISTS heijin_erp_drill_103 WITH (FORCE)' -c 'CREATE DATABASE heijin_erp_drill_103'
docker cp backups/pre_upgrade_xxx.dump heijin-db-1:/tmp/p.dump
docker exec heijin-db-1 pg_restore -U erp_app -d heijin_erp_drill_103 \
  --no-owner --no-privileges --single-transaction /tmp/p.dump

cd /tmp/heijin-build-1.0.3
ERP_ENV_FILE=/Users/aries/黑金时代/backend/.env \
  /Users/aries/黑金时代/backend/.venv/bin/python3 deploy/scripts/schema_diff.py heijin_erp_drill_103
```

**检查点**：差异条目只有 `add_table` + `add_index`（1.0.3 实测 2 条）。出现列级变更 → 停，走变更评审。

**在 drill 库上先演练补表，再上生产**——这一步能提前暴露约束名/identity 写错：

```bash
docker cp patch_103.sql heijin-db-1:/tmp/patch_103.sql
docker exec heijin-db-1 psql -U erp_app -d heijin_erp_drill_103 -v ON_ERROR_STOP=1 -f /tmp/patch_103.sql
# 复查：差异必须归零
ERP_ENV_FILE=/Users/aries/黑金时代/backend/.env \
  /Users/aries/黑金时代/backend/.venv/bin/python3 deploy/scripts/schema_diff.py heijin_erp_drill_103
```

**检查点**：`差异 0 条`。然后清掉 drill 库与临时 dump。

---

## B. 上线窗口（停机约 10–20 秒）

### B1. 备份当前库（唯一退路）

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && bash scripts/backup_daily.sh'
```

**检查点**：末行以 `BACKUP_OK` 开头，且**没有** `备份表数不一致`。1.0.3 实测：`size=219480 objects=430`。

> `objects=` 是 TOC 总对象数（约 430 量级），**不是表数**；表数闸门在脚本内部动态比对，不通过会直接 `die`，不会产出 `BACKUP_OK`。

### B2. 补新表（在线 DDL，幂等）

```bash
scp patch_103.sql heijin-prod:/opt/heijin/backups/patch_103.sql
ssh heijin-prod 'cd /opt/heijin/deploy && CID=$(docker compose ps -q db) \
  && docker cp /opt/heijin/backups/patch_103.sql "$CID":/tmp/patch_103.sql \
  && docker compose exec -T db psql -U erp_app -d heijin_erp -v ON_ERROR_STOP=1 -f /tmp/patch_103.sql \
  && docker exec "$CID" rm -f /tmp/patch_103.sql'
```

`patch_103.sql` 内容（与 `0001_baseline.py` 的 `user_wechat_bindings` 段逐字一致，含 `_postgresql_sql` 对 id 列的 identity 改写；`IF NOT EXISTS` 保证可重复执行）：

```sql
CREATE TABLE IF NOT EXISTS user_wechat_bindings (
	id INTEGER GENERATED BY DEFAULT AS IDENTITY NOT NULL,
	user_id INTEGER NOT NULL,
	provider VARCHAR(32) NOT NULL,
	open_id VARCHAR(128) NOT NULL,
	union_id VARCHAR(128),
	nickname VARCHAR(128),
	avatar_url TEXT,
	bound_phone VARCHAR(32),
	last_login_at TIMESTAMP,
	is_active BOOLEAN NOT NULL,
	created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	updated_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT pk_user_wechat_bindings PRIMARY KEY (id),
	CONSTRAINT ck_user_wechat_bindings_provider_valid CHECK (provider IN ('MOCK', 'OPEN_PLATFORM')),
	CONSTRAINT fk_user_wechat_bindings_user_id FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT uq_wechat_bindings_provider_openid UNIQUE (provider, open_id),
	CONSTRAINT uq_wechat_bindings_user_provider UNIQUE (user_id, provider)
);
CREATE INDEX IF NOT EXISTS ix_wechat_bindings_open_id ON user_wechat_bindings (open_id);
```

**检查点**：输出 `CREATE TABLE` / `CREATE INDEX`，随即：

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose exec -T db psql -U erp_app -d heijin_erp -tAc \
  "select (select count(*) from information_schema.tables where table_schema=\$\$public\$\$) tbls, \
          (select count(*) from orders) orders,(select count(*) from stocks) stocks, \
          (select count(*) from cashflow) cf,(select count(*) from users) users"'
```

应输出 `41|120|91|372|6`——**表数 +1，数据一条不变**。数据变了就是走错了路，立刻停。

### B3. 换镜像

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && APP_VERSION=1.0.3 docker compose up -d'
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose ps --format "table {{.Service}}\t{{.Image}}\t{{.Status}}"'
```

**检查点**：`backend` / `frontend` 的 IMAGE 均为 `…:1.0.3`，backend `healthy`；**`db` 仍是 `postgres:16-alpine` 且未被重建**（`Up N days` 不变）。

> 看到 IMAGE 是 `1.0.2` 或更旧，说明 `APP_VERSION` 没传到——重跑本步，不要去查库。

### B4. 补齐售出表单三作用域（**仅 1.0.4 及含表单拆分的版本**）

> **本步为 11-05 补录，1.0.3 不执行。** 判定：新镜像里 `backend/app/orders/form_scopes.py` 是否存在 `SALEREC` / `SALETH` / `SALEDG`。只有旧 `SALE` 就整步跳过，C1 的 `220` 字段期望也不要改。

**为什么必须跑**：回收 / 提号 / 代挂三张售出表单已从共用 `SALE` 拆成三个独立作用域。活基线 `0001` 在生产已 stamp，`create_all` + `seed_catalog` **不会重播种子**；换镜像后若不跑本步，三张表单会回落到硬编码默认值，管理员对旧 `SALE` 改过的标签、必填、启停、板块标题全部丢失。

**顺序硬约束**：必须 **B3 换完新镜像之后**再跑——脚本依赖新代码里的 `_CATALOG_BLOB`（三份差异化字段集），旧镜像里既没有该脚本也没有新种子；B1 备份已完成是前置条件。脚本随镜像落在 `/app/scripts/`，**无需额外 scp**。

```bash
# 1) 确认脚本在新镜像内、且容器内 DATABASE_URL 已注入（grep -c 只输出计数，不回显连接串）
ssh heijin-prod 'cd /opt/heijin/deploy \
  && docker compose exec -T backend ls /app/scripts/split_sale_form_scopes.py \
  && docker compose exec -T backend env | grep -c "^DATABASE_URL="'

# 2) 执行补齐（幂等，可重跑）
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose exec -T backend python3 scripts/split_sale_form_scopes.py'
```

**检查点**：第 1 步输出脚本路径 `/app/scripts/split_sale_form_scopes.py` 与 `1`（`ls` 失败即脚本不在镜像内）；第 2 步打印 `复制字段行 N，板块标题行 M` 与三作用域现状——`SALEREC fields=28`、`SALETH fields=28`、`SALEDG fields=21`。**二次执行复制行数必为 0，且四 scope 行数与总字段数与首次完全一致**（首次复制行数也可能是 0：历史 `SALE` 全是默认值时由新种子直接播种）。三份的 `section_labels` 应等于历史 `SALE` 板块标题行数；若生产从未配过板块标题则三份均为 0，前端用硬编码默认标题，属正常。第 1 步失败说明换的不是含拆分的镜像，停手查 B3，不要手工补配置。

> **两处口径提醒**：① 执行过 B4 后，C1 的字段数不再是 220——三份新作用域共 **+77 行**（28+28+21），旧 `SALE` 13 行保留，升级前 220 → 终态 **297**；选项集 63、`policy_definitions` 0 不变，**字段数增加是预期而非数据异常**。② 脚本按新种子的字段键白名单复制，历史 `SALE` 上**管理员自建的自定义字段不会被带到三份**，需升级后在设置页按三个作用域分别重建（内置字段的标签 / 必填 / 启停改动会继承）。

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose exec -T db psql -U erp_app -d heijin_erp -c "
select order_type_code, count(*) as fields from order_form_fields
where order_type_code in (\$\$SALE\$\$,\$\$SALEREC\$\$,\$\$SALETH\$\$,\$\$SALEDG\$\$)
group by 1 order by 1;"'
```

**期望**：`SALE | 13`（历史行保留）、`SALEREC | 28`、`SALETH | 28`、`SALEDG | 21`。

> **回滚是安全的**：脚本**只插入缺失行，不更新、不删除**，旧 `SALE` 行原样保留。若按 D 段回滚到不含拆分的旧镜像，旧代码只认 `SALE`，三份新行对它不可见，售出表单行为与升级前一致，**无需清理数据**。
>
> 脚本对历史行做了两件事：① 只有「管理员改过」的 `SALE` 字段才复制，未改过的交给新种子按差异化默认值播种——否则代挂的「利润」会被旧默认值「售出金额」盖回；② 按各作用域字段键白名单复制，**代挂不会重新出现分期 / 分笔字段**。

---

## C. 验收

### C1. 库层

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose exec -T db psql -U erp_app -d heijin_erp \
  -c "select version_num from alembic_version" \
  -c "select (select count(*) from information_schema.tables where table_schema=\$\$public\$\$) tbls,(select count(*) from orders) orders,(select count(*) from stocks) stocks,(select count(*) from cashflow) cf,(select count(*) from order_events) ev,(select count(*) from users) users" \
  -c "select (select count(*) from order_form_fields) fields,(select count(*) from option_sets) optionsets,(select count(*) from policy_definitions) policies"'
```

**期望**：`0001` / **41 · 120 · 91 · 372 · 202 · 6** / **220 · 63 · 0**

> 41 表**必须**含 `user_wechat_bindings`、**不得**含 `db_version`；后者出现说明有人跑了 `deploy.sh`。

### C2. 主键体检（本版新增项）

```bash
ssh heijin-prod 'docker exec deploy-db-1 psql -U erp_app -d heijin_erp -c "
select c.relname as 无主键表 from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname=\$\$public\$\$ and c.relkind=\$\$r\$\$
  and not exists (select 1 from pg_constraint k where k.conrelid=c.oid and k.contype=\$\$p\$\$)
order by 1;"'
```

**期望**：仅 `alembic_version` 一张（Alembic 自管版本表，单行单列，官方建法即无主键）。
**业务表主键缺失数必须为 0**。1.0.3 实测：40 张 → 39 有主键、1 是 `alembic_version`；`revoked_tokens` 用 `PRIMARY KEY (jti)` 业务主键（无 `id` 列，属设计如此）。

### C3. 余额

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose exec -T db psql -U erp_app -d heijin_erp -c "
select p.code, sum(case when c.direction=\$\$IN\$\$ then c.amount else -c.amount end) balance
from pools p left join cashflow c on c.pool_id=p.id and c.status=\$\$APPROVED\$\$
group by p.code order by p.code"'
```

**期望**：`HJ_INVEST 57579.17`、`HJ_PROFIT 54253.06`（与升级前**逐字一致**）。

> 不要用 `sum(amount)`——那是收支绝对值相加，是错的。

### C4. 版本与登录方式

```bash
ssh heijin-prod 'curl -s http://127.0.0.1/api/v1/health; echo; curl -s http://127.0.0.1/api/v1/auth/login-methods'
```

**期望**：

```json
{"status":"ok","database_status":"ok","app_env":"production","app_version":"1.0.3", ...}
{"password":{"enabled":true},
 "phone_code":{"enabled":false,"dev_code_visible":false},
 "wechat":{"enabled":false,"configured":false,"provider":"disabled","reason":"微信登录未启用"}}
```

> `app_version` 不是 1.0.3 说明 B3 没带 `APP_VERSION`；`phone_code.enabled=true` 说明 `.env` 没同步（生产无短信通道，开着的入口点了必然失败）。
>
> `dev_code_visible` 必须为 `false`——它只在非生产环境回显验证码。

### C5. 业务冒烟（必做）

1. 浏览器登录（账号密码）→ 能进主界面，无「注册」入口；
2. 进「设置 → 人员与权限 → 用户」→ 列表有**手机号**列，编辑弹窗能填手机号；
3. 进建单页 → 自定义字段与板块标题正常渲染（**OPERATOR 账号尤其要验**：这版修了该角色读表单配置 403 的缺陷，修前它静默降级成空配置）；
4. 打开资金页 → 两池余额与 C3 一致；
5. 建一笔订单再冲销取消 → 库存与余额回到原值。

> 第 3 步的重点是「非管理员账号」。v1.2 及更早版本中 `/order-form-fields`、`/section-labels`、`/scopes` 三个 GET 要求 `field-definition.manage`（仅 ADMIN），其他角色拿到 403 后前端 `catch` 里**静默降级为空配置**——界面上只有一行报错，管理员配的字段与标题对他们是彻底失效的。

### C6. 三份售出表单配置（**仅执行过 B4 时验**）

1. 「设置 → 表单字段」作用域下拉出现 **回收售出 / 提号售出 / 代挂售出** 三项，归「库存中心」分组；
2. 三份字段数为 **28 / 28 / 21**；代挂 `amount` 标签是 **「利润」**、买家昵称是 **「委托方昵称」**，且**不含分期与分笔字段**；
3. 改「回收售出」任一字段标签或停用某字段 → 只有回收售出表单变化，提号 / 代挂不受影响；
4. 库存中心分别打开三种货源的售出弹窗 → 字段与板块标题按各自配置渲染，无「回落到默认值」现象。

> 第 2 / 4 步看到默认标签或三份一模一样，说明 **B4 漏跑**：回到 B4 补跑后重验，**不要去前端改配置**。

---

## D. 回滚（约 1 分钟）

本版回滚**不需要动业务数据**——新表是空表，删掉零损失。

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && APP_VERSION=1.0.2 docker compose up -d'
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose ps --format "table {{.Service}}\t{{.Image}}\t{{.Status}}"'
```

**检查点**：IMAGE 回到 `1.0.2`、backend `healthy`。

确认业务数据未受影响：

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose exec -T db psql -U erp_app -d heijin_erp -tAc \
  "select (select count(*) from orders)||\$\$/\$\$||(select count(*) from stocks)||\$\$/\$\$||(select count(*) from cashflow)"'
```

**期望**：`120/91/372`（与升级前一致）。

表结构回退（可选，旧代码不认识这张表，留着也无害）：

```bash
ssh heijin-prod 'docker exec deploy-db-1 psql -U erp_app -d heijin_erp \
  -c "DROP TABLE IF EXISTS user_wechat_bindings"'
```

> **⚠ 不要用 `restore_pg.sh` 做回滚**：它走 `--clean`，只删备份里包含的对象，库里多出来的表会残留。
>
> **⚠ 只有「结构已损坏」才需要 v1.2 的整库恢复**，且必须用升级前备份 `pre_upgrade_103_*.dump`（含 120 单），**不是** `prod_final_20261102_234555.dump`（那是 11-02 的空库，会丢全部真实数据）。

---

## E. 已知遗留

| 项 | 影响 | 处理时机 |
|---|---|---|
| **生产无短信通道** | 手机号验证码登录不可用；`.env` 已显式关闭，登录页不点亮该入口 | 接入真实短信供应商后实现 `app/auth/sms.py` 对应分支，改 `SMS_PROVIDER` + `PHONE_CODE_LOGIN_ENABLED=true` |
| **无微信开放平台 AppID / 已备案回调域名** | 微信扫码登录不可用（`reason: 微信登录未启用`） | 域名与 AppID 到位后配 `WECHAT_APP_ID` / `_SECRET` / `_REDIRECT_URI`，改 `WECHAT_LOGIN_ENABLED=true`。回调域名**必须备案，不接受 IP** |
| **生产 6 个账号 `phone` 全为空** | 即便将来开启免密链路，也会一律拒绝「该手机号未开通登录」 | 管理员在「设置 → 用户」逐个填（这版已补该字段） |
| **`must_change_password=true` 的账号走免密登录会死锁** | 改密页要求填「当前密码」，而免密登录的人从未输入过密码；且 `UserUpdate` 不接该字段，只有「知道原密码」一条清除路径 | 待裁决：改为「免密登录的会话允许只设新密码」。当前绕过方式＝先用账号密码登录改密 |
| `CUSTOMER.trade_role`（`order_form_fields.id=160`）待裁决 | 档案级客户角色与「角色按单判定」冲突 | 若停用需同步 `catalog_seed.py` blob + 三库 + 重导上线包 |
| `deploy/scripts/deploy.sh` 引用文档版本号 | 违反「代码不得引用文档」 | 下次改该脚本时一并清理 |
| 120 单 `owner_id` 多为 1 | 归属人显示「系统管理员」 | 仅展示层，按需调整 |
| **三份售出表单拆分尚未上线（生产仍 1.0.3）** | 生产 `order_form_fields` 只有旧 `SALE` 13 行；含拆分的新版本上线时若漏跑 B4，三张售出表单回落默认值并丢失管理员既有配置 | **1.0.4 发版时执行 B4 + C6**；1.0.3 本次不执行 |
| ECS PG `archive_mode=off` | 无 PITR，只有每日 dump | 尽快补物理基备 + WAL 归档 |

---

## F. 时间线（1.0.3 实测）

| 段 | 内容 | 实测 |
|---|---|---|
| B0.1–B0.2 | 升版本 + 导出干净树 | 1 min |
| B0.3 | 交叉构建 amd64 双镜像（有层缓存） | **3 min** |
| B0.4–B0.5 | 打包传输 + load + 同步四文件 | 2 min |
| B0.6 | 改 `.env` | 1 min |
| B0.7 | 结构差异验证 + drill 演练补表 | 6 min |
| B1 | 备份 | 30 s |
| B2 | **补表（在线）** | **2 s** |
| B3 | 换镜像重启 | **20 s** |
| B4（1.0.4 起） | 补齐售出表单三作用域 | < 5 s（幂等脚本，1.0.3 跳过） |
| C1–C4 | 库层 + 主键 + 余额 + 版本验收 | 2 min |
| C5 | 业务冒烟 | 5 min |

> 与 v1.2 的 20 分钟停机相比，本版**停机仅 20 秒**：没有删库，没有整库恢复。
