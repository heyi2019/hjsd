# 宜游轩 ERP｜数据库架构检查与治理方案

| 项 | 值 |
|---|---|
| 检查对象 | 宜游轩 ERP（内部代号「黑金时代」），仓库 `/Users/aries/黑金时代` |
| 检查日期 | 2026-11-02 |
| 检查性质 | **只读**。未执行任何 DROP / DELETE / TRUNCATE / 结构变更 / 生产连接 |
| 生产连接 | 未建立。本文对阿里云库的描述均来自部署文档与 compose 配置，标注为「待核实」 |
| 排除范围 | 同实例其他项目的库一律不纳入，仅确认边界存在，不评估、不改造、不触碰 |

---

## 一、现有数据库清单

### 1.1 本地 PostgreSQL 实例

本项目使用本机 Docker 容器 `container-db-1`（`postgres:16-alpine`，`127.0.0.1:5432`），超级用户 `erp_app`。本项目的库共三个：

| 数据库 | 大小 | 表数 | 版本戳 | 内容（实测行数） | 归属 | 判定 |
|---|---|---|---|---|---|---|
| `heijin_erp_dev` | 12 MB | 40 | `0001` | orders 119 / stocks 90 / customers 12 / cashflow 370 / audit_logs 499 / order_form_fields 259 / option_sets 63 / users 3 | 本项目 | **真实历史数据 + 开发调试混用** |
| `heijin_erp_test` | 18 MB | 40 | `0001` | 全表 0 行（pytest 上一次会话 TRUNCATE 后的状态） | 本项目 | 测试库，正常 |
| `heijin_erp_migration_test` | 11 MB | 40 | `0001` | 业务表全 0；`order_form_fields` 212 / `option_sets` 62（**压平前的旧种子**）；audit_logs 17 | 本项目 | **孤儿库：全仓无任何代码/脚本引用** |

> **范围声明**：同一实例上还有若干属于其他项目的库。它们**不在本次治理范围内**，本文既不做评估也不提改造建议，检查期间仅读取过一次表数量以确认边界。后续所有操作（含脚本、迁移、备份策略）只针对上表三个 `heijin_erp_*` 库。

### 1.2 生产（阿里云 ECS）

| 项 | 值 | 来源 |
|---|---|---|
| 编排 | `deploy/docker-compose.yml` 的 `db` 服务，`postgres:16-alpine` | compose 实读 |
| 库名 / 用户 | `heijin_erp` / `erp_app`（与本地**同名不同实例**） | `deploy/env/.env.production.example` |
| 连接串 | `postgresql+psycopg://erp_app:***@db:5432/heijin_erp`（容器网络内部 `db`） | 同上 |
| 端口暴露 | 不对公网开放（文档明示，DBeaver 走 SSH 隧道） | `README_阿里云部署.md` |
| **当前版本戳** | **`0064_expand_buy_rebate_scope`** | 文档 2026-10-31，**待核实** |
| 数据量 | **未知，待核实** | 未连接 |
| 归档 | 未开启（`archive_mode=off`）→ 无 PITR | 既有结论 |

### 1.3 E2E 数据库：**不存在**

- 本地 PG 里没有 e2e 库；
- SQLite 时代的 `heijin_erp_e2e.db` 已于 11-02 删除；
- E2E 体系于 2026-11-02 整体下线，`frontend-e2e` job 已从 CI 移除。

**遗留悬空**：`frontend/package.json` 的 `test:regression:fast` 仍在调用 `test:e2e:critical`，而该脚本已无定义；`playwright ^1.64.0` 依赖仍在。即「删了体系，没删入口」。

### 1.4 连接配置与传递链路

| 文件 | 是否入库 | 内容 | 风险 |
|---|---|---|---|
| `/Users/aries/黑金时代/.env` | 否 | `DATABASE_URL`→dev，`TEST_DATABASE_URL`→test，含明文口令与 JWT 密钥 | 正常（本地） |
| `.env.example` | 是 | 模板，占位值 | 正常 |
| `.env.postgres-test` | 否 | 遗留文件，`DATABASE_URL`→test | 易误用：以为它是"测试专用配置"就会把开发后端指到 test |
| `.env.bak-20261102-2115` | 否 | **事故现场**：`DATABASE_URL`→`heijin_erp_test`，**无** `TEST_DATABASE_URL` | 明文口令留存，应清理 |
| `deploy/env/.env.production.example` | 是 | 生产模板 | 正常 |
| `deploy/.env` | 否（在 ECS 上） | 生产实值 | 正常 |

配置解析链：`pydantic-settings` 读 `.env` → `settings.database_url` / `settings.test_database_url` → `alembic` 用 `settings.alembic_url`（= `database_url`）→ pytest 夹具用 `TEST_DATABASE_URL`（**刻意不回落** `DATABASE_URL`）。

---

## 二、各类测试真实使用的数据库

| 测试类型 | 入口 | 实际连接 | 初始化 / 清理 | 隔离性 |
|---|---|---|---|---|
| 后端 pytest（全量 1519 例） | `backend/tests/v1/conftest.py` | `TEST_DATABASE_URL` → `heijin_erp_test` | session 起手 `create_all` + `TRUNCATE`；**每个用例后** `TRUNCATE ... RESTART IDENTITY CASCADE`；种子走 `seed_template` schema 纯 SQL 回放 | **硬校验**：必须 PostgreSQL、库名必须含 `test`，否则 `pytest.exit` 拒绝运行 |
| 迁移测试 | `tests/v1/test_migration.py` 的 `migration_env` | 自建临时库（sqlite 临时文件 / PG schema） | 用例结束销毁 | 独立 |
| 前端 vitest（758 例 / 4 project） | `frontend/` | **不连数据库**，全量 mock | — | 天然隔离 |
| E2E / Playwright | 已下线 | — | — | — |
| CI 后端覆盖率 | `.github/workflows/coverage-gate.yml` | GitHub Actions `services.postgres`（一次性容器） | 容器随 job 销毁 | 隔离 |
| Codex / 本地自动化执行 | 复用 pytest 入口 | 同 `TEST_DATABASE_URL` | 同上 | 同上 |

**结论**：除 CI 外，本地所有后端测试**已经统一使用 Test DB**，且有一道真实的硬闸门（库名含 `test`）。这套机制是 11-02 事故后补的，实测有效。

**但有一个盲区**：闸门只校验「库名含 test」，不校验「不能是 Release DB」。若将来新建 `heijin_erp_release`，名字不含 test 会被拦；但如果有人图省事命名成 `heijin_erp_release_test`，闸门会放行并把它 TRUNCATE 掉。

---

## 三、现有架构问题与严重程度

### P0-1　生产库版本戳断裂，下次部署必失败

- 生产库停在 `0064_expand_buy_rebate_scope`（旧链 `alembic/versions/` 有 75 个文件，但 `alembic.ini` 的 `version_locations` **只指 `squashed_versions`**，旧链与 `legacy_versions_pre_squash/` 的 25 个文件都不参与加载）。
- 活动链 `alembic/squashed_versions/` 已压平为**单一 `0001`**。
- `deploy/scripts/deploy.sh` 第 127-128 行**已移除** `stamp_baseline` 兜底 → 部署会**硬停**，不会造成结构半残。

**已实测复现**（临时探针库，验完即删）：把 `alembic_version` 伪造成 `0064_expand_buy_rebate_scope` 后执行 `alembic upgrade head`：

```
INFO  [alembic.runtime.migration] Will assume transactional DDL.
ERROR [alembic.util.messaging] Can't locate revision identified by '0064_expand_buy_rebate_scope'
FAILED: Can't locate revision identified by '0064_expand_buy_rebate_scope'
```

失败发生在**任何 DDL 执行之前**（且 `deploy.sh` 已在迁移前先跑 `backup_daily.sh`），所以回滚成本为零。

> **2026-11-02 23:34 更新：本 P0 已消解。** 用户裁决线上库整体删除、改由 `heijin_erp_release` 覆盖重建（第六节），该路径**不对旧库跑 `alembic upgrade`**，因此不会触发此错误。但「不要用 stamp 绕过」的警告仍然有效——谁绕过流程直接升级旧库，谁就踩这个坑。
>
> `deploy/scripts/deploy.sh` 已加**版本戳预检**（第 119 行）：`alembic current` 输出含 `Can't locate revision` 时打印重建指引并中止，把英文报错翻译成可操作步骤。

**⚠️ 不要用 `alembic stamp --purge 0001` 修生产库。** 同一探针实测：戳到 `0001` 后 `alembic upgrade head` 是 **no-op**——库里只剩 `alembic_version` 1 张表，其他 schema 一点没建。

压平后的 `0001` 语义是「按当前 ORM 全量建库」。对一个结构落后 10 个迁移的库执行 stamp，等于**把结构未完成的库伪装成已升级**，正是 `deploy.sh` 注释明令禁止的事。

`heijin_erp_dev` / `heijin_erp_test` 能安全 `stamp --purge 0001`，是因为它们的 schema 本来就逐步迁移到了最新态，只缺一个正确标签；生产库缺的是**结构本身**（0065→0074 的 `allow_split_cashflow_per_event`、`order_form_section_labels`、`drop_period_locks`、`add_independent_inventory_status`、`split_order_installment_status`、`rename_account_waiting_status`、`remove_dfq_order_type`、`remove_retired_product_checks`、`seed_business_overview_reminders` 等）。

**若仍要用这份数据**，唯一正确路径是：dump 生产数据 → 空库 `upgrade head` 建出全量正确结构 → 数据清洗后导入 → 校验。但本轮已裁决整体丢弃，改走第六节的覆盖式重建。

### P0-2　Dev 库里躺着真实历史业务数据

实测证据（不是推测）：

```
orders.created_by = 'wps-import'（119 条全部）
orders.trade_date = 2026-07-14 ~ 2026-11-01
stocks = 90，customers = 12，cashflow = 370（occurred_on 2026-07-07 起），audit_logs = 499
```

也就是说：**`heijin_erp_dev` 是当前唯一承载真实历史数据的库**，而它同时是日常开发/调试/建单演练的库。11-02 已发生过一次真实数据被 TRUNCATE 清空（118 单），事后重新导入才有现在的 119 单。

风险不在「可能被清」，而在「**已经清过一次，且容灾全靠人为记得备份**」。

### P1-1　`heijin_erp_migration_test` 孤儿库

40 张表、业务数据全空、种子停留在压平前的 212/62、全仓 grep 无任何引用。它现在的唯一作用是**在误操作时被当成测试库**。

### P1-2　生产结构落后 10 个迁移，且这些迁移已不在活动链

生产 0064 之后，旧链还有 0065→0074 未执行，包含：`allow_split_cashflow_per_event`、`order_form_section_labels`、`drop_period_locks`、`add_independent_inventory_status`、`split_order_installment_status`、`rename_account_waiting_status`、`remove_dfq_order_type`、`remove_retired_product_checks`、`seed_business_overview_reminders`。

压平后这些文件仍在 `alembic/versions/`（存档，不加载），**无法用 `upgrade` 走过去**。首次上线只能「结构重建 + 数据迁移」，不能「原地升级」。

### P1-3　CI 里 `DATABASE_URL` == `TEST_DATABASE_URL`

`coverage-gate.yml` 两者都指向同一个 `heijin_erp_test`。在一次性容器里无实际风险，但它**示范了错误配置**——本地照抄一次就是 11-02 事故重演。

### P2-1　E2E 残留入口

`test:regression:fast` → `test:e2e:critical`（不存在）；`playwright` 依赖空转。会让新人以为 E2E 还在。

### P2-2　历史数据质量

客户 `display_name` 实测存在 `111111`、`1112322`、`111` 这类占位值；导入源 `rawdata/原始数据/*.json` **没有订单编号字段**（只有金额/利润/人员/账户/日期），系统单号是导入时生成的。这类数据进生产前必须清洗和确认归属。

### P2-3　备份能力的缺口

已有（生产）：`backup_daily.sh` 三重校验（PGDMP 魔数 / `pg_restore --list` 可解析 / 归档内 TABLE 数 == 源库表数）、sha256 sidecar、保留 30 份、独立备份卷。
缺口：**PG 未开 WAL 归档（无 PITR）**；**本地 Dev 库没有任何自动备份**；恢复演练未定期化。

### P2-4　工作区残留敏感配置

`.env.bak-20261102-2115`、`.env.postgres-test` 含明文口令，属本机未跟踪文件，但长期留着既有泄露面也有误用面。

---

## 四、保留 / 整合 / 取消建议

| 数据库 | 建议 | 理由 | 前置条件 |
|---|---|---|---|
| `heijin_erp_dev` | **保留**，但剥离真实数据 | 开发库应可随时清空重建 | 先把真实数据迁入 Release DB 并校验通过 |
| `heijin_erp_test` | **保留** | 已具备 TRUNCATE 闸门，是唯一被所有自动化测试统一使用的库 | — |
| **新建 `heijin_erp_release`** | **新建** | 承接 rawdata 历史数据，只读校验、不参与测试 | 明确目录与访问口令，加入测试闸门黑名单 |
| `heijin_erp_migration_test` | **备份后取消** | 零引用孤儿库，占位误导 | 用户确认 + `pg_dump` 留档 |
| E2E 独立库 | **不建** | E2E 体系已下线；若将来恢复，串行复用 test 库即可 | 恢复 E2E 时再评估 |

---

## 五、目标数据库架构图

```
                            GitHub Actions（每次 push）
                    ┌───────────────────────────────────────┐
                    │  services.postgres  (临时容器)         │
                    │  db: ci_erp_test                       │
                    │  job 结束即销毁，不依赖本地任何库      │
                    └───────────────┬───────────────────────┘
                                    │ coverage / lint / frontend gate
                                    ▼
  本机 Docker PG (container-db-1, 127.0.0.1:5432)
  ┌──────────────────────────────────────────────────────────────┐
  │  heijin_erp_dev     ── 开发调试、建单演练（可清空重建）      │
  │        ▲ 导入/演练                                           │
  │  heijin_erp_test    ── pytest / API / 表单 / (未来 E2E)      │
  │        ▲ 结构来源                                            │
  │  heijin_erp_release ── 历史真实数据归档，只读校验，不跑测试  │
  │        │ 首次上线单向迁移                                    │
  └──────────────────────────────┬───────────────────────────────┘
                                 │ pg_dump -Fc（离线、加密、双份）
                                 ▼
  阿里云 ECS (docker compose)
  ┌──────────────────────────────────────────────────────────────┐
  │  db: postgres:16-alpine  →  heijin_erp  (Prod)               │
  │  仅容器网络可达，不暴露公网；每日 pg_dump + 三重校验         │
  │  backend  ← DATABASE_URL=...@db:5432/heijin_erp              │
  └──────────────────────────────────────────────────────────────┘
```

数据流向三条，互不交叉：

1. **历史数据流（一次性）**：`rawdata/原始数据/*.json` → Release DB → 清洗校验 → Prod。
2. **开发流（持续）**：开发者 → Dev DB → 代码 → test 分支。
3. **验证流（持续）**：CI 临时库 / 本地 Test DB，**永不接触 Release 与 Prod**。

---

## 六、Release → Prod 首次上线迁移步骤

> **2026-11-02 23:34 用户裁决**：线上库（ECS 的 `heijin_erp`）**计划整体删除、不再使用**，首次上线直接从本地上线准备库 `heijin_erp_release` 推过去。因此**不做数据合并（原阶段 3B 取消）**，走覆盖式重建。
>
> 这条裁决同时消解了 P0-1：不对旧库跑 `alembic upgrade`，版本戳断裂自然消失。但「**不要用 stamp 绕过**」这条警告仍然有效——绕过本流程直接升级旧库，仍会踩同一个坑。

### 阶段 0　丢弃前必须做的两件事（安全底线）

即使决定不要这份数据，也必须先留档：

1. ECS 上 `bash deploy/scripts/backup_daily.sh` → 生成 `heijin_erp_pg_<ts>.dump` + `.sha256`；
2. `bash deploy/scripts/pull_backup.sh --host root@<ECS_IP>` 取回本地，存为 `backups/prod_final_<ts>.dump`。

**理由**：删库不可逆。这份 dump 是「上线前生产状态」的唯一证据；将来若发现某个客户/订单只存在于线上，还能捞回来。确认 `pg_restore -l` 能解析后再进入阶段 1。

### 阶段 1　Release 库就绪（**已完成**）

| 项 | 状态 |
|---|---|
| `heijin_erp_release` 建库 | ✅ 由 dev 全量 dump 恢复（**不是** rawdata 导入——rawdata 少 49 单） |
| 结构 | ✅ 40 表，`alembic_version = 0001` |
| 数据 | ✅ 119 单 / 90 库存 / 370 流水 / 200 事件 |
| 客户 / 分期 / 返点 | 0 / 0 / 0（源数据本就没有，见 11.6） |
| 测试脏数据 | ✅ 已清（customers 12→0、counterparties 4→0、teams 2→0、测试用户已删） |

### 阶段 2　生成上线包

```bash
docker exec container-db-1 pg_dump -U erp_app -d heijin_erp_release -Fc \
  > backups/release_$(date +%Y%m%d_%H%M%S).dump
shasum -a 256 backups/release_*.dump > backups/release_latest.sha256
# 自检：TOC 里应有 40 条 TABLE DATA
docker exec -i container-db-1 pg_restore -l < backups/release_*.dump | grep -c "TABLE DATA"
```

上线包自带 `alembic_version = 0001`，**目标库不需要再跑 `alembic upgrade`**。

### 阶段 3　覆盖式重建（唯一路径）

1. **再备份一次线上库**（阶段 0 的备份可能已隔数日）。
2. 传包：`scp backups/release_<ts>.dump root@<ECS_IP>:/opt/heijin/`。
3. 停应用，释放连接（DROP DATABASE 要求无活动连接）：
   ```bash
   cd /opt/heijin && docker compose stop backend
   ```
4. 删旧库、建空库：
   ```bash
   docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
     -c "DROP DATABASE IF EXISTS heijin_erp WITH (FORCE)" \
     -c "CREATE DATABASE heijin_erp OWNER $POSTGRES_USER"
   ```
   `WITH (FORCE)`（PG 13+）会踢掉残留连接，否则 DROP 挂在 `database is being accessed by other users`。
5. 全量恢复（dump 含结构 + 数据 + 种子，一次到位）：
   ```bash
   docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d heijin_erp \
     --no-owner --single-transaction < /opt/heijin/release_<ts>.dump
   ```
   **不要加 `--clean`**：目标是刚建的空库，没有对象可清理；加了会因 DROP 不存在的表而报错。
6. 校验（全部通过才继续）：
   ```bash
   docker compose exec -T db psql -U "$POSTGRES_USER" -d heijin_erp \
     -c "select version_num from alembic_version" \
     -c "select count(*) from orders" \
     -c "select count(*) from stocks" \
     -c "select count(*) from cashflow" \
     -c "select code, name from pools"
   ```
   期望：`0001` / **119** / **90** / **370**；池余额 **HJ_PROFIT 54,253.06**、HJ_INVEST 744,382.61。
7. 起服务并验健康：
   ```bash
   docker compose up -d
   docker compose exec -T backend curl -fsS localhost:8000/api/v1/health
   ```
8. 冒烟：管理员登录 → 建一笔回收单 → 库存可见 → 作废。
9. 跑完剩余部署步骤（`stamp_db_version.py`、`seed_policy_definitions.py --apply` 均幂等）：
   ```bash
   bash deploy/scripts/deploy.sh
   ```

> `deploy.sh` 第 119 行新增的「版本戳预检」在此时会通过（`0001` 在活动链内），不会误拦。

### 阶段 3B　数据合并 —— **已取消**

线上库整体丢弃，不存在「生产已有真实数据需合并」的场景。若将来推翻此裁决，原思路（dump 取回 → 临时库比对 → 人工逐项裁决 → 脚本合并）仍可复用，但不属本轮范围。

### 阶段 4　失败恢复

- 阶段 3 第 5 步失败：库为空或半残，**直接重跑第 4-5 步**（删库重建），无需回滚。
- 要退回旧数据：`bash deploy/scripts/restore_pg.sh --backup backups/prod_final_<ts>.dump --yes`（脚本会先备份当前库，`--single-transaction` 保护）。
- 应用侧回滚：`rollback.yml` 指定旧镜像 tag。

---

## 七、后续 Dev → Test → CI → main → Prod 发布与迁移机制

现有流水线已经成型，**只需补数据库环节**：

```
本地开发 (Dev DB)
   │ git push origin dev
   ▼
test 分支
   │ 触发 lint-gate / frontend-gate / coverage-gate（CI 临时库）
   ▼
auto-merge-test-to-main（3 gate 全绿才 --no-ff 合并）
   ▼
main 分支 → deploy-production.yml（SSH 到 ECS）
   │  ① 备份 backup_daily.sh
   │  ② alembic upgrade head   ← 压平后需加版本戳预检
   │  ③ seed_policy_definitions --apply
   │  ④ compose up -d + 健康检查
   ▼
Prod
```

**结构变更流程（压平后的新常态）**：

1. 改 SQLAlchemy 模型（`app/domain/**`）。
2. 本地 `heijin_erp_dev` 无需迁移脚本——但**必须显式执行一次结构同步**，供既有库跟上：
   - 方案 A（推荐）：`scripts/repair_baseline_schema.py` 这类比对/补齐脚本，或
   - 方案 B：手工 `ALTER` 并记录在 `docs/`，因为不再有迁移文件承载。
   > 这是压平的**代价**：新库开箱即对，既有库的演进要靠「结构比对 + 修复脚本」。若团队更依赖可审计的迁移历史，应重新评估压平决策。
3. 内置字段/选项集变更 → 改 `app/foundation/catalog_seed.py` 的内嵌 blob（当前 259 / 63），**不加迁移**。
4. `heijin_erp_test` 需手动跟到最新结构（`create_all` 不会 ALTER 既有表）——**这是目前最容易漏的一步**。
5. 上线时生产库同样需要一次结构比对，而不是 `upgrade`。

---

## 八、具体需要修改的配置文件 / 测试脚本 / CI / 迁移工具

| # | 文件 | 改动 | 目的 |
|---|---|---|---|
| 1 | `backend/tests/v1/conftest.py` | 闸门增加**黑名单**：URL 命中 `release` / `prod` / `production` 直接 `pytest.exit` | 堵住「命名成 xxx_release_test 就放行」的漏洞 |
| 2 | `backend/tests/v1/conftest.py` | 增加校验 `TEST_DATABASE_URL != DATABASE_URL` | 防止 CI 那种同库配置被复制到本地 |
| 3 | `.github/workflows/coverage-gate.yml` | `DATABASE_URL` 与 `TEST_DATABASE_URL` 分指两个库（或用 schema 隔离） | 消除错误示范 |
| 4 | `deploy/scripts/deploy.sh` | 在 `alembic upgrade head` 前加**版本戳预检**：若 `alembic_version` 不在活动链，输出明确指引并中止 | 压平后生产库必踩，给出可读错误而非 alembic 原始异常 |
| 5 | `deploy/scripts/preflight_db.sh`（新增） | 只读预检：库名、版本戳、表数、关键表行数、是否空库 | 部署前打印现状；**路径已固定为覆盖式重建**，不再分支判断 |
| 6 | `.env.example` | 补 `RELEASE_DATABASE_URL` 说明段（仅文档用途，不参与运行时） | 让三个库的角色在模板里可见 |
| 7 | `frontend/package.json` | 删 `test:regression:fast` 里悬空的 `test:e2e:critical`；移除 `playwright` 依赖 | 清理 E2E 残留 |
| 8 | `.env.bak-20261102-2115` / `.env.postgres-test` | 删除或移入受控的凭据管理 | 消除明文口令与误用面 |
| 9 | `backend/alembic/squashed_versions/0001_*.py` | 无需改动；但 `docs/` 需补一条「既有库如何演进」的操作说明 | 压平后最大的认知缺口 |
| 10 | `deploy/scripts/backup_daily.sh` 的 cron | 本地 Dev 与 Release 库增加每日 dump（不同目录、不同保留策略） | 目前只有生产有自动备份 |

---

## 九、备份 / 恢复 / 防误删

### 已有能力（实测）

| 能力 | 位置 | 说明 |
|---|---|---|
| 生产每日备份 | `backup_daily.sh` | `pg_dump -Fc`；三重完整性闸门（PGDMP 魔数、TOC 可解析、归档表数==源库表数）；sha256 sidecar；保留 30 份（`ERP_BACKUP_KEEP`）；备份写独立卷 |
| 恢复 | `restore_pg.sh` | 强制 `--yes`；校验 sha256；`pg_restore --list` 预检；**恢复前自动再备份**；`--single-transaction` 失败整体回滚 |
| 取回 | `pull_backup.sh` | 异地留存 |
| 测试库闸门 | `conftest.py` | 必须 PG + 库名含 `test`，否则拒绝运行 |

### 缺口与建议

| 缺口 | 建议 |
|---|---|
| Dev 库无自动备份 | `cron` 每日 `pg_dump heijin_erp_dev`，保留 14 份，写独立目录 |
| Release 库无备份策略 | 导入完成后立即 dump，并在每次清洗/合并前后各留一份 |
| PG 未开 WAL 归档 | 开启 `archive_mode=on` + `archive_command` 到独立卷，获得 PITR；至少要在正式发布前完成 |
| 恢复演练未定期化 | 每季度一次「从 dump 恢复到临时库 + 行数校验」，产出记录 |
| 无库级操作闸门 | 见「防误删」 |

### 防误删（针对本次事故类型的专项措施）

1. **库级白名单**：所有涉及写操作的脚本入口先过 `scripts/db_guard.sh`，只允许操作 `heijin_erp_dev` / `heijin_erp_test` / `heijin_erp_release`，其他库名立即中止。这一条纯属自保，不涉及对其他项目做任何改造。
2. **禁用裸 `DROP`**：仓库内禁止出现 `dropdb` / `DROP DATABASE` / `down -v`（CI 加 grep 检查，与 `scan_pii.py` 同级）。
3. **测试闸门加强**：见改动 1、2。
4. **生产库写操作双人确认**：`restore_pg.sh` 已有 `--yes`，建议再加一步「输入库名以确认」，避免复制粘贴误执行。

---

## 十、按优先级排列的实施清单

### P0（上线前必须完成，缺一不可）

1. **核实生产库现状**：版本戳、是否已有数据、立即备份取回。
2. **建 `heijin_erp_release`**：`upgrade head` → 导入 rawdata → 对账 → dump 留档。
3. **Dev 库剥离真实数据**：确认 Release 校验通过后，Dev 可重置为纯结构库（此步需你明确授权，本轮未做）。
4. **部署链路适配压平**：`deploy.sh` 增加版本戳预检 + `stamp --purge 0001` 指引。
5. **首次上线演练**：在本地用 Release dump 恢复到临时库，完整走一遍 3A 流程。

### P1（上线前建议完成）

6. 测试闸门加 `release/prod` 黑名单 + `TEST != DATABASE` 校验。
7. CI 的 `DATABASE_URL` / `TEST_DATABASE_URL` 拆分。
8. 删除或归档 `heijin_erp_migration_test`（先 dump 留档）。
9. 开启 PG WAL 归档（PITR）。

### P2（上线后 30 天内）

10. 清理 E2E 残留（`package.json` 悬空脚本 + playwright 依赖）。
11. 本地 Dev / Release 每日备份 cron。
12. 恢复演练季度化并留记录。
13. 历史数据清洗（客户名占位值、无单号历史单的 `link_status` 标注）。
14. 清理 `.env.bak-*`、`.env.postgres-test` 等含明文口令的遗留文件。

### P3（中期架构）

15. 重新评估「压平为单一 0001」是否入口化：若后续既有库演进频繁，需要一套「结构比对 + 修复脚本」的标准流程（当前靠 `repair_baseline_schema.py` 与手工 ALTER，没有审计链）。

---

## 十一、阶段 0 执行结果（2026-11-02 23:15）

### 11.1 已完成

| 步骤 | 结果 |
|---|---|
| dev 全量 dump | `backups/heijin_erp_dev_20261102_231449.dump`（214 KB，`pg_dump -Fc`）+ `.sha256`；`pg_restore -l` 解出 **40 条 TABLE DATA**，与源库 40 表一致 |
| 新建 `heijin_erp_release` | `pg_restore --no-owner --exit-on-error` 恢复，退出码 0 |
| 逐表比对 | 表数 40=40、版本 `0001`= `0001`、**全表行数 0 差异** |

关键行数：`orders` 119 / `stocks` 90 / `cashflow` 370 / `order_events` 200 / `audit_logs` 499 / `customers` 12 / `order_form_fields` 259 / `option_sets` 63 / `users` 3。

余额：**HJ_PROFIT 54,253.06**（与 11-02 重建基线完全一致）、HJ_INVEST 744,382.61。

### 11.2 结论一：Release 现在是 Dev 的克隆，且带着测试脏数据

| 表 | 总数 | 测试数据 | 证据 |
|---|---|---|---|
| `customers` | 12 | **12（全部）** | 全部命中 `outputs/wps_import/customers_from_wps.py::TEST_CUSTOMERS`；**被订单引用 0 次** |
| `counterparties` | 4 | 4 | `测试供货方01` / `测试合作方-全页面-20261101` / `合作方格式测试-20261101` / `10000` |
| `teams` | 2 | 2 | `TEAM_TEST_20261101`、`前端测试团队-20261101` |
| `users` | 3 | 1 | `user_test_20261101`（前端测试用户，VIEWER） |

**订单与库存本身干净**：119 单的 `note` 全是「WPS导入 …」，无一条命中测试关键字；`stocks` 90 条同样 0 命中。

### 11.3 结论二：三类实体在 Dev 里本来就是空的

```
order_customer_roles 0   customer_leads 0   installments 0
rebate_records 0         quality_issues 0   import_batches 0 / import_rows 0
```

含义有两层：

1. **119 单没有任何客户归属**（不是「客户是测试数据」，是「客户关系根本没建」）；
2. rawdata 里的 4 条分期、19 笔返点**从未导入**，v1 里也没有对应记录。

### 11.4 结论三：历史数据的权威源不是 `rawdata/原始数据/`

- `rawdata` 5 份表合计 89 行（回收 30 / 提号 15 / 代挂 24 + 蹭点 1 / 返点 19），映射后最多 **70 单**；
- Dev 是 **119 单**，且 11-01 22:22 的快照只有 103 单 → 说明 Dev 是持续重建累积的结果。

真正的权威源是 **`outputs/wps_import/`**：`parse_wps.py → wps_orders.json → import_wps.py / import_wps_cashflow.py / import_inventory_only.py / import_unpaid_inventory.py`，验收基线是 `导入对账报告_20261101.md` 与 `逐笔核对报告_20261101.md`。

**所以「从 rawdata 重建 Release」这条路方向是错的**——会少 49 单。

### 11.5 裁决后执行结果（23:25）

**① 清测试主数据 —— 已完成**

| 表 | 前 | 后 | 说明 |
|---|---|---|---|
| `customers` | 12 | **0** | 全部命中 `TEST_CUSTOMERS` 名单，引用 0 |
| `counterparties` | 4 | **0** | 全部测试 |
| `teams` | 2 | **0** | 全部测试 |
| `users` | 3 | **2** | 删 `user_test_20261101`；保留 `三三`(ADMIN) 与 `xuanxuan`(VIEWER) |

订单 / 库存 / 流水 / 事件零影响（119 / 90 / 370 / 200 不变），`orders.owner_id` 无空值，涉及的外键表（deposits、order_counterparty_roles、customer_leads、order_customer_roles、notifications）全为 0 行。

**故意保留的 2 处**（名字像测试、实际不是脏数据）：

- `cashflow#639` ¥136.00 / 2026-07-24 / `note='工作测试'` / **APPROVED** —— 已审核的真实支出，删了会改余额；
- `game_type_options#3` `'测试游戏-20261101'` —— 下拉选项，0 张库存引用，保留无害。

**② 补客户归属 —— 做不了，源数据里没有客户字段**

| 源 | 行数 | 字段 |
|---|---|---|
| `outputs/wps_import/wps_orders.json` | 141 | date / amount / principal / profit / order_type_raw / recover_by / sell_by / accounts / note / month_raw —— **无买家** |
| `rawdata/原始数据/sheet9_orders.json` | 89 | 交易金额 / 利润 / 售卖员 / 回收员 / 回款账户 / 日期 / 月份 / 本金 / 订单类型 —— **无买家** |

唯一带人名的字段只在分期表：「联系人」（4 条全是「蒋丞选手」）与「买家联系方式」。**要补客户，必须另提供含「买家/客户」列的原始表。**

**③ 分期 4 条 / 返点 19 笔 —— 也做不了，缺挂接键**

- **分期**：源号款 670 / 910 / 1573 / 1588 与库内 119 单**零匹配**（07-19 前后只有 362 / 1400 / 2800 三单）。说明这 4 笔分期售出对应的订单**从未进系统**。`installments.order_id` NOT NULL，强行补 = 编造 4 单、破坏 119 单基线。
- **返点**：`rebate_records` 必填 `source_order_id` + `rebate_type` + `rate` + `base_amount`；源里只有「螃蟹430收号返点」这类自由文本，**没有对应订单号、没有渠道字段、没有费率**。19 笔利润合计 **1,264.98**，`cashflow` 里 0 条带「返点」字样 —— 是否已随利润入账，需业务确认。

**当前 Release 真实状态**：119 单 / 90 库存 / 370 流水 / 200 事件 / **0 客户 / 0 分期 / 0 返点**。干净，但残缺。

### 11.6 三项裁决结果（23:30 用户确认）

**① 客户归属：角色按单判定，客户档案不设固定类型**

用户口径原话：「客户每一次成单是不一样的，这一次是买家，下一次可能是卖家；合作方不分。」

这条与系统现有设计**完全吻合**，无需改结构：

| 机制 | 落点 | 现状 |
|---|---|---|
| 客户角色 | `order_customer_roles.role` + 选项集 `ORDER_CUSTOMER_ROLE` | 卖方 / 买方 / 寄售方 / 分期客户，**逐单独立** |
| 各业务允许的角色 | `app/orders/_shared.py::_CUSTOMER_ROLES_BY_ORDER_TYPE` | HS = SELLER / BUYER / INSTALLMENT_CUSTOMER；TH = BUYER；DG = CONSIGNOR |
| 合作方不参与 | `_COUNTERPARTY_ROLES_BY_ORDER_TYPE` | HS = ∅；TH = PEER；DG = PLATFORM —— **合作方不写入客户角色** |
| 前端可见 | 客户详情 →「关联订单」表 | **已有「角色」列**，逐单显示「买方 / 卖方 / 寄售方」 |
| 建单时角色来源 | `CreateBusinessModal.tsx:247` | HS 固定 SELLER、DG 固定 CONSIGNOR、TH 取表单值或默认 BUYER |

所以同一个人第一次回收（HS）记 SELLER、第二次提号（TH）记 BUYER、第三次代挂（DG）记 CONSIGNOR，**三单三个角色并存，互不覆盖**。这正是「每一次成单不一样」。

**遗留冲突（待裁决）**：客户档案表单上还有一个自定义字段 `CUSTOMER.trade_role`「交易角色」（`order_form_fields.id=160`，`is_custom=True`，`is_active=True`，选项 买家 / 卖家 / 货源 / 中介）。它把角色固定在了**档案级**，与新口径矛盾——当档案写「买家」而某一单角色是「卖方」时，没有明确以谁为准。

- 影响面：客户档案新建 / 编辑表单一个下拉；
- 数据风险：**零**（`heijin_erp_release` 现有 0 个客户；停用不删 `form_extra` 旧值）；
- 若要彻底消除，需同时改 `app/foundation/catalog_seed.py` 内嵌 blob，否则每次新建库都会复活该字段。

**建议停用，等你点头。**

**② 分期：系统里本来就没有这个数据** —— 用户「不是不导，是这个数据没有」。

`installments` 为 0 **不是「裁决不导入」，而是业务事实上不存在**：WPS 表里那 4 行（源号款 670 / 910 / 1573 / 1588）在系统内找不到任何对应订单，说明它们从未作为分期业务发生（或早已并入其他单结清）。既然没有这笔业务，就不存在「导不导」的选择；将来真有分期，按新单正常录入即可。

**③ 返点：同样没有这个数据** —— 同上。

`rebate_records` 为 0 同理：那 19 行只是 WPS 表里的备注性记录（合计 1,264.98），不构成系统中的返点台账事实，也没有可挂接的 `source_order_id`/渠道/费率。**不是决定不导，是本来就不存在需要导入的返点记录。**

**因此 Release 的最终形态（已定稿）**

| 维度 | 数量 | 状态 |
|---|---|---|
| 订单 | 119 | ✅ 可用 |
| 库存 | 90 | ✅ 可用 |
| 资金流水 | 370 | ✅ 可用 |
| 订单事件 | 200 | ✅ 可用 |
| 客户 | 0 | ⚠️ 空，且**补不了**（源无买家列） |
| 分期 | 0 | ➖ 本就没有这笔业务 |
| 返点 | 0 | ➖ 本就没有返点台账 |

**上线后客户维度报表为空的唯一解法**：从上线第一天起在系统内正常建单录入客户——`CreateBusinessModal` 会在有 `customer_id` 时自动写 `customer_roles`，不需要额外开发。历史 119 单将永久无客户归属。

---

## 附：操作边界声明

**检查阶段（第一~十节）**：只对本项目三个库执行 `SELECT`（`pg_database`、`information_schema`、`count(*)`）；未连阿里云生产库；未执行 DDL/DML；未改任何 `.env`。

**阶段 0 执行（第十一节，经用户两次确认后）**：

- `heijin_erp_dev` **只读**，仅 `pg_dump` 取全量备份（`backups/heijin_erp_dev_20261102_231449.dump`）；
- 新建 `heijin_erp_release` 并恢复该备份；
- 仅在 `heijin_erp_release` 内删除测试主数据（customers 12 / counterparties 4 / teams 2 / user_test_20261101）；
- `heijin_erp_test`、`heijin_erp_migration_test` 未触碰；
- 生产库至今**零连接**。
