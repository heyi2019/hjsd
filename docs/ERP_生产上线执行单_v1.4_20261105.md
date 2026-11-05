# 宜游轩 ERP·生产升级执行单（1.0.3 → 1.0.4，原地增量）

**文件编号**：ERP-OPS-001　**版本**：v1.4
**运行域**：工作经营　**阅读对象**：上线执行人（现场逐条照做）
**编写日期**：2026-11-05　**编写人**：何一（AI 协助整理）
**适用范围**：生产 ECS 从 1.0.3 升到含三类售出表单拆分的首个版本

**版本记录**

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 ~ v1.3 | 11-03 ~ 11-05 | 1.0.2 → 1.0.3 的历次执行单；v1.3 已签收，保留在 `docs/ERP_生产上线执行单_v1.3_20261105.md`，**不改写、不删除** |
| **v1.4** | **2026-11-05** | **面向 1.0.4 的终态执行单**：本版零 DDL、必跑 B4、**CI 发布通道已修合规（去两处副作用 + 内置 B4 + 库状态自检）**、生产数据不落本机。v1.3 保留原位，是否移入 `docs/archive/` 待裁决 |

---

## 0. 本版结论（先读，别跳）

| 结论 | 判据 |
|---|---|
| **不需要任何 DDL** | 当前代码 ORM 共 **39 表**；相对 1.0.3 只下线了 `RebateSettlement` 模型，**没有新增表 / 列 / 索引**。v1.3 的「补一张表 + 一个索引」本版不适用 |
| 结构比对预期**恰好 4 条 `remove_*`** | `remove_index` × 3 + `remove_table` × 1，全部指向历史表 `rebate_settlements`。**该表在生产保留、不 drop**（历史数据留痕） |
| 比对脚本退出码 1 是**预期** | `schema_diff.py` / `compare_metadata` 是双向比对，`remove_*` 会让它返回 1；**不要当成失败，更不要据此删表** |
| **唯一必须执行的数据变更 = B4** | 三份售出表单作用域补齐，`order_form_fields` 从 **220 → 297**（+77），旧 `SALE` 13 行保留 |
| **发布通道 = `git push origin dev:refs/heads/test` 自动 CI/CD** | 见第 2 章：CI 已去除两个副作用、内置 B4 与库状态自检，本版按自动链路发布 |
| **`deploy.sh` 自检失败即中止发布** | 表数 / `db_version` 表 / `policy_definitions` / `option_sets` / 历史 `SALE` 行数 / alembic 戳升级前后必须逐项一致；字段总数只增不减，三作用域字段均非空 |
| **生产数据不落本机** | 本单**不导出、不回传、不在本机恢复**任何生产库。所有生产数字在 ECS 上现场只读采集（A0），升级后逐字比对（C 段） |

> 代码层取证（`dee62b1b` 1.0.3 → `3df621ff`，共 36 个提交）：`backend/app/domain/` 的结构性变化只有 `deposit_rebate.py` 删除 `RebateSettlement`、`trade.py` 移除导出、`enums.py` 增加 `ACCOUNT_DELETE` 枚举；`cashflow.py` 的 `allocation_amount` 只改注释与校验口径（允许负数），**无列变更**。

---

## 1. 常量（现场填写，勿凭记忆）

| 项 | 值 |
|---|---|
| SSH | `ssh heijin-prod`（root） |
| 部署目录 | `/opt/heijin/deploy`（compose 项目名 `deploy`，容器名 `deploy-*`） |
| 库 / 用户 | `heijin_erp` / `erp_app`（容器网络内 `db:5432`） |
| 目标镜像 tag | **1.0.4**（backend / frontend 同名） |
| 回滚镜像 tag | **1.0.3**（必须保留） |
| 代码指纹 | B0.1 提交后 `git rev-parse --short HEAD` 抄录 |
| 镜像包 / sha256 | B0.4 打包后抄录 |
| 升级前备份 | B1 产出后抄录（保留在 ECS `/opt/heijin/backups`） |
| **升级前生产基线** | **A0 现场抄录**：表数、单据数、余额、字段数、`alembic_version` |

> 本单不预填任何生产业务数字。v1.3 记录的 120 单 / 91 库存 / 372 流水是 1.0.3 时点值，仅作参考，**不是本版的验收基准**。

---

## 2. 发布通道（本版已修合规，唯一主路线）

`test` 分支**不是测试环境，是生产发布通道**。本版起 CI 链路已按执行单口径修好，正常发布走自动链路：

```
git push origin dev:refs/heads/test
  → lint-gate / frontend-gate / coverage-gate（3 gate 全绿）
  → auto-merge-test-to-main.yml（--no-ff 合入 main）
  → gh workflow run deploy-production.yml（GitHub runner 上交叉构建 amd64 双镜像）
  → 打包 scp 到 ECS → docker load → ERP_SKIP_BUILD=1 bash scripts/deploy.sh
  → health + 部署摘要 + 打 v1.0.4 tag
```

### 四处修复（缺一不可推）

| # | 修复 | 文件 | 解决的旧问题 |
|---|---|---|---|
| 1 | 移除 `stamp_db_version.py` 调用 | `deploy/scripts/deploy.sh` | `create_all` 自建 `db_version` 表，41 → 42 表 |
| 2 | 移除 `seed_policy_definitions.py --apply` 调用 | 同上 | 写入 6 类规则定义与默认版本，`policy_definitions` 0 → 非 0 |
| 3 | 新增 B4 与发布后不变量自检 | 同上 | CI 原本跳过 `split_sale_form_scopes.py`，三张售出表单回落默认值、丢失管理员配置 |
| 4 | 持久化 ECS `.env` 的 `APP_VERSION` | `.github/workflows/deploy-production.yml` | 旧 `.env` 仍写 1.0.3，之后单独 `docker compose up -d` 会静默回落旧镜像 |

> **自检硬断言**：`deploy.sh` 在备份后采集库状态基线，在 health 与 B4 之后复核——表数 / `db_version` 表 / `policy_definitions` / `option_sets` / 历史 `SALE` 行数 / alembic 戳必须逐项不变，字段总数只增不减，三作用域字段均非空；任一不符即 `exit 1`，CI 判红。

- [ ] 推送前确认这 4 条修复已随 `auto-merge` 进入 `main`（workflow checkout 的是 main 的 release commit）
- [ ] 推送用 `git push origin dev:refs/heads/test`，**不要**再手工跑 `deploy.sh` 或 B0.4 / B0.5 的传输命令
- [ ] 若 `main` / `test` 分支已被他人推进，先停手核对，不合并、不强推
- [ ] B0.2–B0.7 / B1–B4 的命令是**等价步骤与本机预检**，正常发布由 CI 执行，勿重复手工操作；B3.1 与 C 段仍为人工必做

---

## A. 上线前（逐项打勾，缺一项不开窗口）

### A0. 现场采集生产基线（只读，数据不出 ECS）

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose exec -T db psql -U erp_app -d heijin_erp \
  -tAc "select (select count(*) from information_schema.tables where table_schema=current_schema()), \
               (select count(*) from orders),(select count(*) from stocks), \
               (select count(*) from cashflow),(select count(*) from order_events), \
               (select count(*) from users),(select count(*) from order_form_fields), \
               (select count(*) from option_sets),(select count(*) from policy_definitions), \
               (select version_num from alembic_version)"'
```

把输出**逐字抄进第 1 节**。C1 与 C3 的验收基准就是这行，升级前后必须完全一致（字段数按 B4 例外）。

### A1. 打勾清单

- [ ] 生产业务数据非 0 → 走本单原地增量；**任何 `DROP DATABASE` / `pg_restore` 覆盖都禁止**
- [ ] 版本号已升到 1.0.4（三处一致 + `RELEASE.md` 的 `## V1.0.4` 章节），`git status --short` 无待提交改动混入
- [ ] **第 2 章四处 CI 修复已提交并随 `auto-merge` 进入 `main`**；`deploy.sh` 自检与 B4 已内置
- [ ] 代码层已确认零 DDL（第 0 章）；**B3.1 换镜像后的结构确认**须仅 4 条 `remove_*`，出现 `add_*` 或业务表 `remove_column` → 立即按 D 段回滚
- [ ] amd64 双镜像由 CI 在 runner 构建并传 ECS `docker load`，**旧镜像 1.0.3 仍在**
- [ ] 升级前备份由 `deploy.sh` 在 ECS 生成；上线后核对 `BACKUP_OK` 与 sha256
- [ ] `.env` 的 `APP_VERSION=1.0.4` 由 workflow 写回；上线后核对免密六行仍为关闭
- [ ] 窗口确定（停机 = 容器重启，约 10–20 秒）

---

## B0. 换代码（窗口前完成，不影响线上）

> **B0.1 已落地（`69dc502f`）；B0.2–B0.7 正常发布全部由 CI 自动执行。** 以下命令是等价步骤、本机预检与手工兜底，**不要重复手工操作**。CI 在 GitHub runner 上用 `actions/checkout` 的干净树交叉构建（`deploy-production.yml`），无需本机 `git archive` / `buildx` / `scp`，也避开了本机 Docker Hub 拉 `node:22-alpine` 超时的问题。

### B0.1 升版本（**三处同步 + 发布章节，不要只改一行**）

`scripts/ops/bump_version.sh --check` 与 `RELEASE.md` 的
`test_release_notes_has_section_for_current_version` 是硬门禁：三处版本
（`backend/app/version.py` / `frontend/package.json` / 根 `package-lock.json`）必须一致，
且必须有 `## V1.0.4` 章节含「发布时间」「本次内容」。只改 `version.py` 一行会让 `ci` 直接红。

```bash
cd /Users/aries/黑金时代
scripts/ops/bump_version.sh --check              # 改前：三处 1.0.3
scripts/ops/bump_version.sh 1.0.4
scripts/ops/bump_version.sh --check              # 改后：三处 1.0.4
scripts/ops/changelog.sh --from v1.0.3            # 看草稿即可，**不要 --write**：草稿按提交列表生成，含已下线的 H5 条目与「待填」基线
# 按终态口径人工写 RELEASE.md 的 ## V1.0.4 章节（必须含「发布时间」「本次内容」）
git add -- backend/app/version.py frontend/package.json package-lock.json RELEASE.md
git diff --cached --name-only                     # 只应有这 4 个文件
git commit -m 'chore(release): 1.0.4'
backend/.venv/bin/python -m pytest -q tests/backend/unit/system/test_settings.py
git rev-parse --short HEAD     # 抄进第 1 节
git status --short
```

> 用 `git add` 锁索引后 `git commit` **不带 pathspec**；`git commit -- <pathspec>` 提交的是工作区而非暂存区。

### B0.2 导出干净构建树

```bash
BUILD=/tmp/heijin-build-1.0.4
rm -rf "${BUILD}" && mkdir -p "${BUILD}"
cd /Users/aries/黑金时代 && git archive HEAD | tar -x -C "${BUILD}"
grep -n '__version__' "${BUILD}/backend/app/version.py"
test ! -e "${BUILD}/frontend/node_modules" && echo "clean: no node_modules"
```

**检查点**：`__version__ = "1.0.4"` + `clean: no node_modules`。
Dockerfile 是 `COPY . .`，直接用工作区会把并发会话的半成品打进生产镜像，必须用 `git archive`。

### B0.3 构建 amd64 双镜像

本机是 aarch64，必须交叉构建；架构不对在 ECS 上表现为 `exec format error`。

```bash
cd /tmp/heijin-build-1.0.4
docker buildx build --platform linux/amd64 --load -t heijin-backend:1.0.4 -f backend/Dockerfile backend
docker buildx build --platform linux/amd64 --load -t heijin-frontend:1.0.4 -f frontend/Dockerfile .
docker image inspect heijin-backend:1.0.4  --format '{{.Architecture}} {{.Os}} {{.Size}}'
docker image inspect heijin-frontend:1.0.4 --format '{{.Architecture}} {{.Os}} {{.Size}}'
```

**检查点**：两行都以 `amd64 linux` 开头。前端构建上下文是**项目根**（`ui_guards.mjs` 要读 `backend/app/enums.py`）。

### B0.4 打包、单向传输、load

```bash
cd /tmp
docker save heijin-backend:1.0.4 heijin-frontend:1.0.4 | gzip > heijin-images-1.0.4-amd64.tar.gz
shasum -a256 heijin-images-1.0.4-amd64.tar.gz | tee heijin-images-1.0.4.sha256
scp heijin-images-1.0.4-amd64.tar.gz heijin-prod:/tmp/
ssh heijin-prod 'sha256sum /tmp/heijin-images-1.0.4-amd64.tar.gz'
ssh heijin-prod 'gunzip -c /tmp/heijin-images-1.0.4-amd64.tar.gz | docker load; docker images | grep heijin | sort'
```

**检查点**：两端 sha256 逐字一致；load 后 1.0.0 ~ 1.0.4 镜像齐全（缺 1.0.3 就是回滚底座已丢，停手）。

### B0.5 同步镜像外的四个文件

| 文件 | 原因 |
|---|---|
| `backend/app/version.py` | `deploy.sh` / `backup_daily.sh` 从它解析版本 |
| `deploy/docker-compose.yml` | 镜像引用与 healthcheck |
| `frontend/nginx.conf` | 只读覆盖镜像内站点配置，不同步＝新镜像配旧站点 |
| `deploy/scripts/*` | `schema_diff.py` 等工具 |

```bash
cd /tmp/heijin-build-1.0.4
scp backend/app/version.py    heijin-prod:/opt/heijin/backend/app/version.py
scp deploy/docker-compose.yml heijin-prod:/opt/heijin/deploy/docker-compose.yml
scp frontend/nginx.conf       heijin-prod:/opt/heijin/frontend/nginx.conf
for f in deploy.sh backup_daily.sh restore_pg.sh pull_backup.sh \
         export_images.sh gen_selfsigned.sh harden_host.sh schema_diff.py; do
  scp "deploy/scripts/${f}" "heijin-prod:/opt/heijin/deploy/scripts/${f}"
done
```

> 不要 `scp -r deploy/scripts`：会把只应在本地的 `pg_container.sh` 等搬上生产。

### B0.6 改 `.env`

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && cp .env ".env.bak-$(date +%Y%m%d%H%M%S)" \
  && sed -i "s|^APP_VERSION=.*|APP_VERSION=1.0.4|" .env \
  && grep -E "^(APP_VERSION|PHONE_CODE_|SMS_|WECHAT_)" .env'
```

免密六行保持关闭：`PHONE_CODE_LOGIN_ENABLED=false`、`SMS_PROVIDER=disabled`、`WECHAT_LOGIN_ENABLED=false`、`WECHAT_PROVIDER=disabled`、`WECHAT_BIND_VERIFY_MODE=sms`。生产无短信通道与微信 AppID，开着只会得到「入口能点、点了必然失败」。

### B0.7 离线确认构建树（不连任何库）

```bash
cd /tmp/heijin-build-1.0.4/backend
ERP_ENV_FILE=/Users/aries/黑金时代/backend/.env \
  /Users/aries/黑金时代/backend/.venv/bin/python3 -c "
import app.main
from app.core.database import Base
print('ORM tables', len(Base.metadata.tables))
print('rebate_settlements in ORM:', 'rebate_settlements' in Base.metadata.tables)
"
```

**检查点**：`ORM tables 39`、`rebate_settlements in ORM: False`。这一步只数元数据，**不连生产库、不落任何生产数据**。

> 真正的结构比对放在 **B3.1**：只有换镜像后，backend 容器里才是新代码；在 B0 阶段对旧容器跑比对得到的是 1.0.3 的 ORM，结果无意义。

---

## B. 上线窗口（CI 自动执行，停机约 10–20 秒）

> **B1–B4 由 ECS 上的 `deploy.sh` 自动完成**：预迁移检查 → 备份 → 迁移（0001 no-op）→ 启动 → health → B4 补齐 → 发布后不变量自检。任一自检失败即非零退出、CI 判红。**B3.1 与 C 段仍由人工在部署完成后执行**；下列命令供复核与兜底。

### B1. 备份（唯一退路，留在 ECS）

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && bash scripts/backup_daily.sh'
```

**检查点**：末行以 `BACKUP_OK` 开头，无「备份表数不一致」。记录 dump 文件名与 sha256 到 ECR/本地工单均可，**但不要把它恢复成本机库**。

### B2. 本版无 DDL —— 跳过

v1.3 的 `patch_103.sql`（补 `user_wechat_bindings`）在 1.0.3 已执行完毕，**本步不执行任何建表 / 加列 / 加索引**。直接进 B3，结构确认在 B3.1 完成后再做判断。

> 特别注意：**不要 drop `rebate_settlements`**。它是 11-05 模型层下线后按裁决保留的历史表，删除会破坏历史留痕，`import_wps.reset_business_data` 也已按 `to_regclass` 条件清理做了兼容。

### B3. 换镜像

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && APP_VERSION=1.0.4 docker compose up -d'
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose ps --format "table {{.Service}}\t{{.Image}}\t{{.Status}}"'
```

**检查点**：backend / frontend 的 IMAGE 均为 `…:1.0.4`，backend `healthy`；`db` 仍是 `postgres:16-alpine` 且未被重建。看到 1.0.3 或更旧就是 `APP_VERSION` 没传到，重跑本步。

### B3.1 换镜像后结构确认（**人工必做，CI 不含此步**；只读，数据不出 ECS）

此时容器里已是 1.0.4 新代码，用它的 ORM 对**当前生产连接**直接跑元数据比对：

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose exec -T backend python3 -c "
import app.main
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from app.core.database import get_engine, Base
e = get_engine()
with e.connect() as c:
    diffs = compare_metadata(MigrationContext.configure(c), Base.metadata)
print(\"ORM tables\", len(Base.metadata.tables), \"diff\", len(diffs))
for d in diffs:
    print(\" \", d[0] if isinstance(d, tuple) else d)
e.dispose()
"'
```

**检查点**：`ORM tables 39`、`diff 4`，且 4 条全部是 `remove_index` / `remove_table` 指向 `rebate_settlements`。

- 出现任何 `add_table` / `add_column` / `add_index` → **立即按 D 段回滚**，走变更评审补 DDL 方案
- 出现业务表的 `remove_column` → 回滚，可能是代码与库版本错配
- `diff 0` 也属异常：说明生产没有那张历史表，先查清表去哪了再继续
- 该命令**只读**，不建表、不改表、不写行；语法已在本地 dev 库自检通过

> 不在本机建 drill 库、不 `pg_dump` 回传生产快照。若确实需要更细的列级报告，在 **ECS 本机**建临时库演练，数据仍不出 ECS。

### B4. 补齐售出表单三作用域（**本版必跑，已内置进 `deploy.sh`**）

**为什么**：回收 / 提号 / 代挂三张售出表单已从共用 `SALE` 拆成 `SALEREC` / `SALETH` / `SALEDG`。活基线 `0001` 在生产已 stamp，`create_all` + `seed_catalog` 不会重播种子；漏跑会让三张表单回落硬编码默认值，管理员对旧 `SALE` 改过的标签、必填、启停、板块标题全部丢失。

**顺序硬约束**：必须在 B3 换完新镜像之后（脚本依赖新代码里的 `_CATALOG_BLOB`）、B1 备份完成之后。脚本随镜像落在 `/app/scripts/`，无需额外 scp。`deploy.sh` 在 health 通过后执行，并先判断脚本是否存在（旧镜像回滚时跳过，不阻断回滚）。

**CI 日志判据**：`==> 补齐售出表单三作用域` 段须打印 `复制字段行 N，板块标题行 M`，随后自检输出 `✓ 售出三作用域：SALEREC=28 SALETH=28 SALEDG=21`。缺这段日志或自检判红 → 停手按 D 段处置。

以下命令供人工复核与幂等验证（**正常发布无需手工执行**）：

```bash
ssh heijin-prod 'cd /opt/heijin/deploy \
  && docker compose exec -T backend ls /app/scripts/split_sale_form_scopes.py \
  && docker compose exec -T backend env | grep -c "^DATABASE_URL="'
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose exec -T backend python3 scripts/split_sale_form_scopes.py'
```

**检查点**：第 1 步输出脚本路径与 `1`；第 2 步打印 `复制字段行 N，板块标题行 M` 与三作用域现状 `SALEREC fields=28`、`SALETH fields=28`、`SALEDG fields=21`。**二次执行复制行数必为 0**，四 scope 行数与总字段数与首次完全一致。

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose exec -T db psql -U erp_app -d heijin_erp -c "
select order_type_code, count(*) as fields from order_form_fields
where order_type_code in (\$\$SALE\$\$,\$\$SALEREC\$\$,\$\$SALETH\$\$,\$\$SALEDG\$\$)
group by 1 order by 1;"'
```

**期望**：`SALE 13`（历史行保留）、`SALEREC 28`、`SALETH 28`、`SALEDG 21`；总字段数 A0 值 **+77**。

> 脚本只插入缺失行、不更新不删除，旧 `SALE` 原样保留，回滚安全。历史 `SALE` 上**管理员自建的自定义字段不会带到三份**，需升级后在设置页按三个作用域重建；内置字段的标签 / 必填 / 启停改动会继承。三份按界面差异化，代挂 `amount` 标签是「利润」、无分期与分笔字段。

---

## C. 验收

### C0. CI 部署日志（先看这个）

在 GitHub Actions 的 `deploy-production` run 里核对：

1. `Build production images` → 双镜像构建成功、`APP_VERSION=1.0.4`；
2. `Deploy and verify production` → `grep '^APP_VERSION=' .env` 输出 `APP_VERSION=1.0.4`；
3. `deploy.sh` 日志含 `==> 跳过历史版本戳与规则预置`、`==> 采集发布前库状态基线`、`==> 补齐售出表单三作用域`、`==> 发布后不变量校验`，且自检项全部 `✓`、**无 `✗`**；
4. 部署摘要出现 `Health check: passed` / `DB invariants: verified` / `Sale form scopes: backfilled`；
5. `Tag release` 成功打出 `v1.0.4`。

任一不符先停手，不要进 C1。

### C1. 库层（与 A0 逐字比对）

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose exec -T db psql -U erp_app -d heijin_erp \
  -tAc "select (select count(*) from information_schema.tables where table_schema=current_schema()), \
               (select count(*) from orders),(select count(*) from stocks), \
               (select count(*) from cashflow),(select count(*) from order_events), \
               (select count(*) from users),(select count(*) from order_form_fields), \
               (select count(*) from option_sets),(select count(*) from policy_definitions), \
               (select version_num from alembic_version)"'
```

**期望**：除字段数 `+77` 外，其余与 A0 **完全一致**；`alembic_version=0001`；选项集、`policy_definitions` 不变。表数必须**仍含** `rebate_settlements`、**不含** `db_version`（后者出现说明发布通道被改回旧行为）。

### C2. 主键体检

```bash
ssh heijin-prod 'docker exec deploy-db-1 psql -U erp_app -d heijin_erp -c "
select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname=current_schema() and c.relkind=\$\$r\$\$
  and not exists (select 1 from pg_constraint k where k.conrelid=c.oid and k.contype=\$\$p\$\$)
order by 1;"'
```

**期望**：仅 `alembic_version`；业务表主键缺失数 **0**。

### C3. 余额（与 A0 一致）

```bash
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose exec -T db psql -U erp_app -d heijin_erp -c "
select p.code, sum(case when c.direction=\$\$IN\$\$ then c.amount else -c.amount end) balance
from pools p left join cashflow c on c.pool_id=p.id and c.status=\$\$APPROVED\$\$
group by p.code order by p.code"'
```

不要用 `sum(amount)`——那是收支绝对值相加，是错的。

### C4. 版本与登录方式

```bash
ssh heijin-prod 'curl -s http://127.0.0.1/api/v1/health; echo; curl -s http://127.0.0.1/api/v1/auth/login-methods'
```

**期望**：`app_version = "1.0.4"`、`app_env = "production"`、`phone_code.enabled=false`、`wechat.enabled=false`、`dev_code_visible=false`。

### C5. 业务冒烟

1. 账号密码登录 → 主界面正常，无「注册」入口；
2. 设置 → 用户 → 手机号列可编辑；
3. 建单页自定义字段与板块标题正常渲染（**OPERATOR 账号尤其要验**）；
4. 资金页两池余额与 C3 一致；
5. 建一笔订单再冲销取消 → 库存与余额回到原值；
6. 账号台账删除一个测试账号 → 必填原因、订单与流水保留、审计可见。

### C6. 三份售出表单配置

1. 「设置 → 表单字段」作用域下拉出现**回收售出 / 提号售出 / 代挂售出**三项，归「库存中心」分组；
2. 三份字段数 **28 / 28 / 21**；代挂 `amount` 标签「利润」、买家昵称「委托方昵称」，**不含分期与分笔字段**；
3. 改「回收售出」任一字段标签或停用 → 只有回收售出变化，提号 / 代挂不受影响；
4. 三种货源的售出弹窗按各自配置渲染，无「回落默认值」。

> 第 2 / 4 步看到默认标签或三份一模一样，说明 **B4 漏跑**（正常情况下 `deploy.sh` 自检会先判红，不会走到这里）：按 B4 的复核命令补跑后重验，**不要去前端改配置**。

---

## D. 回滚（约 1 分钟）

本版**无需动任何业务数据**：没有 DDL，B4 只插入新行，对旧镜像不可见。

```bash
ssh heijin-prod 'cd /opt/heijin/deploy \
  && sed -i "s|^APP_VERSION=.*|APP_VERSION=1.0.3|" .env \
  && docker compose up -d'
ssh heijin-prod 'cd /opt/heijin/deploy && docker compose ps --format "table {{.Service}}\t{{.Image}}\t{{.Status}}"'
```

> **必须先写回 `.env`**：CI 已把 `APP_VERSION` 持久化为 1.0.4，只给单条命令加 `APP_VERSION=1.0.3` 前缀只在该进程内生效，之后任何 `docker compose up -d` 都会把容器拉回 1.0.4。

**检查点**：IMAGE 回到 `1.0.3`、backend `healthy`；重跑 C1 确认单据数与余额和 A0 一致（字段数会保留 297，旧代码只认 `SALE`，三份新行对它不可见，**无需清理**）。

> **不要用 `restore_pg.sh` 做回滚**（`--clean` 只删备份里包含的对象）。只有结构损坏才需要整库恢复，且必须用 B1 的升级前备份。
>
> 回滚后若再升级到 1.0.4，B4 幂等可重跑，复制行数应为 0。

---

## E. 已知遗留

| 项 | 处理时机 |
|---|---|
| 生产无短信通道 / 无微信开放平台 AppID | 接入真实通道后改 `.env` 六行，无需改代码 |
| `must_change_password=true` 账号走免密登录会死锁 | **1.0.3 不含首次设密死锁修复**；真要开放免密链路前必须先发含该修复的版本 |
| 生产账号 `phone` 多为空 | 开放免密前由管理员在「设置 → 用户」补齐 |
| `rebate_settlements` 历史表保留 | 按 11-05 裁决，不 drop、不再加增量迁移 |
| `test` 分支的 CI 自动部署链路 | 本版已修合规并作为唯一主路线；`auto-merge-test-to-main.yml` 未改动，**误触仍等同生产上线** |
| ECS PG `archive_mode=off` | 无 PITR，尽快补物理基备 + WAL 归档 |

---

## F. 时间线（预估，实测后回填）

| 段 | 内容 | 预估 |
|---|---|---|
| 发布前 | 升版本 + 四处 CI 修复 + push dev | 已完成（`69dc502f` 及后续提交） |
| CI gate | 3 gate 全绿 → `auto-merge` 合入 main | 3–8 min |
| CI 构建 | runner 交叉构建 amd64 双镜像 + 打包 scp + `docker load` | 4–6 min |
| B1–B4 | ECS `deploy.sh`：备份 → 迁移 → 换镜像 → health → B4 → 不变量自检 | **停机约 20 s** |
| B2 | 无 DDL（跳过） | 0 |
| B3.1 | 换镜像后只读结构确认（人工必做） | < 5 s |
| C0–C6 | CI 日志核对 + 验收与冒烟 | 7 min |

> 停机仅容器重启约 20 秒；没有删库、没有整库恢复、没有生产数据离机。
