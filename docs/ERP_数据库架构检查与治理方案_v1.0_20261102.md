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

> **2026-11-02 23:45 首次连线核实**（SSH 别名 `heijin-prod` → `8.155.132.208`，只读）。下表已全部替换为实测值，原「待核实」项均已证实，且**两处原判断被推翻**。

| 项 | 值 | 来源 |
|---|---|---|
| 编排 | `deploy/docker-compose.yml` 的 `db` 服务，`postgres:16-alpine` | 实读 |
| 运行容器 | `deploy-frontend-1` / `deploy-backend-1`(healthy) / `deploy-db-1`(healthy) | `docker ps` |
| 库名 / 用户 | **`heijin_erp`** / `erp_app`（实例内只有这 1 个业务库，另有 postgres/template0/1） | `psql -c "\l"` 实测 |
| 连接串 | `postgresql+psycopg://erp_app:***@db:5432/heijin_erp` | `deploy/.env` 实读 |
| 端口暴露 | 不对公网开放（DBeaver 走 SSH 隧道） | `README_阿里云部署.md` |
| **当前版本戳** | **`0003`** —— 原文档与 `README` 都写 `0064_expand_buy_rebate_scope`，**错** | `select version_num from alembic_version` |
| **表数** | **41** —— 比基线的 40 张多一张遗留表 `db_version`（4 行，最后一条 `alembic_revision=0003` / 2026-10-31 22:33） | `pg_stat_user_tables` |
| **业务数据** | **全空**：`orders` 0 / `stocks` 0 / `cashflow` 0 / `order_events` 0 / `customers` 0 / `installments` 0 / `rebate_records` 0 | 逐表 `n_live_tup` |
| **仅存数据** | `users` 2（`admin` / `19873133890`，均 ADMIN）、`audit_logs` 29、`document_sequences` 14、`policy_definitions` 6、`policy_versions` 4、`pools` 2、种子 `order_form_fields` 212 / `option_sets` 62 | 同上 |
| 归档 | 未开启（`archive_mode=off`）→ 无 PITR | 既有结论 |

**两处被推翻的原判断**

1. **「生产结构落后 10 个迁移、停在 0064」不成立**。实测是 `0003`，且 `db_version` 记录了 11-01 的三次 `0001` 与一次 `0003`——它是 11-01 重建后自己升上去的，与 0064 无关。结论不变（`0003` 同样不在只剩 `0001` 的活动链里，`alembic current` 仍会报 `Can't locate revision`），但**根因描述要改**：不是「历史遗留太久」，是「11-01 重建后又被增量迁移推到 0003，而增量迁移已被压掉」。
2. **「生产数据量未知」→ 实测为空库**。这直接降低了上线风险等级：覆盖式重建**无业务数据损失**，唯一需要保留的是 2 个登录账号与 29 条审计日志。

**用户账号不一致（✅ 已处理，方案 A，见 11.9）**

| 库 | 账号 | 状态 |
|---|---|---|
| 生产 `heijin_erp` | `admin`（系统管理员）、`19873133890`（何一） | 原始状态 |
| 上线包（替换前） | `三三`（ADMIN）、`xuanxuan`（VIEWER） | 已废弃 |
| 上线包（替换后） | `admin`（系统管理员）、`19873133890`（何一） | ✅ 与生产一致，含原口令哈希 |

上线包的 `users` 已按生产对齐，覆盖式重建后**账号与口令均不变**。待决残留：`19873133890` 的 `must_change_password = true`（生产原值，非本次引入），首次登录会被要求改口令。


### 1.3 E2E 数据库：**不存在**

- 本地 PG 里没有 e2e 库；
- SQLite 时代的 `heijin_erp_e2e.db` 已于 11-02 删除；
- E2E 体系于 2026-11-02 整体下线，`frontend-e2e` job 已从 CI 移除。

**遗留悬空（✅ 已修入口）**：`frontend/package.json` 的 `test:regression:fast` 原先调用已无定义的 `test:e2e:critical`，已于 11-02 24:00 改为 `npm run check && npm run test:fast`。`playwright ^1.64.0` **依赖仍在**——移除需同步重生成 `package-lock.json`，否则 `npm ci` 会因两侧不同步直接失败，故未动。

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

- **生产库实际停在 `0003`**（2026-11-02 23:45 连线实测，原写 `0064_expand_buy_rebate_scope` 有误，见 1.2 / 11.8）。旧链 `alembic/versions/` 有 75 个文件，但 `alembic.ini` 的 `version_locations` **只指 `squashed_versions`**，旧链与 `legacy_versions_pre_squash/` 的 25 个文件都不参与加载——所以 `0003` 与 `0064` 一样无法解析。
- 活动链 `alembic/squashed_versions/` 已压平为**单一 `0001`**。
- `deploy/scripts/deploy.sh` 第 127-128 行**已移除** `stamp_baseline` 兜底 → 部署会**硬停**，不会造成结构半残。

**已实测复现**（临时探针库，验完即删）：把 `alembic_version` 伪造成 `0064_expand_buy_rebate_scope` 后执行 `alembic upgrade head`（用 `0064` 作探针是为了取最坏情况；真实生产是 `0003`，报错文本仅版本号不同）：

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

### P1-1　`heijin_erp_migration_test` 孤儿库（✅ 已于 2026-11-03 00:08 删除）

40 张表、业务数据全空、种子停留在压平前的 212/62、全仓 grep 无任何引用。它曾经的唯一作用是**在误操作时被当成测试库**。

删除前完成三项确认：归档 `backups/archive_migration_test_20261102_235246.dump` sha256 校验通过 → 真实恢复到临时库（40 表 / `0001` / 零业务行）→ 库内五大业务表逐表计数为 0。随后 `DROP DATABASE … WITH (FORCE)`。

### P1-2　生产结构落后 10 个迁移，且这些迁移已不在活动链

生产 0064 之后，旧链还有 0065→0074 未执行，包含：`allow_split_cashflow_per_event`、`order_form_section_labels`、`drop_period_locks`、`add_independent_inventory_status`、`split_order_installment_status`、`rename_account_waiting_status`、`remove_dfq_order_type`、`remove_retired_product_checks`、`seed_business_overview_reminders`。

压平后这些文件仍在 `alembic/versions/`（存档，不加载），**无法用 `upgrade` 走过去**。首次上线只能「结构重建 + 数据迁移」，不能「原地升级」。

### P1-3　CI 里 `DATABASE_URL` == `TEST_DATABASE_URL`

`coverage-gate.yml` 两者都指向同一个 `heijin_erp_test`。在一次性容器里无实际风险，但它**示范了错误配置**——本地照抄一次就是 11-02 事故重演。

### P2-1　E2E 残留入口（入口已修，依赖待清）

`test:regression:fast` 曾指向不存在的 `test:e2e:critical`——**已修为** `npm run check && npm run test:fast`，脚本引用链闭合（CI 未调用该脚本，无外部影响）。`playwright` 依赖仍空转，移除须同步 `package-lock.json`（否则 `npm ci` 报不同步），留待与前端并行工作时一并处理。

### P2-2　历史数据质量

客户 `display_name` 实测存在 `111111`、`1112322`、`111` 这类占位值；导入源 `rawdata/原始数据/*.json` **没有订单编号字段**（只有金额/利润/人员/账户/日期），系统单号是导入时生成的。这类数据进生产前必须清洗和确认归属。

### P2-3　备份能力的缺口

已有（生产）：`backup_daily.sh` 三重校验（PGDMP 魔数 / `pg_restore --list` 可解析 / 归档内 TABLE 数 == 源库表数）、sha256 sidecar、保留 30 份、独立备份卷。

> **2026-11-02 23:47 实测修正**：上面这段「已有」原是按**仓库里的脚本**写的，而 ECS 上跑的是 SQLite 旧版——cron 每天备的是一份 851 KB 废弃 `heijin_erp_v1.db`，PG 库一个字节没备。已同步修复并实测通过（11.8 ②③）。**教训：能力清单必须以目标机器的实际文件为准，不能以仓库代码为准。**

缺口：**PG 未开 WAL 归档（无 PITR）**（`archive_mode=off` 已实测确认）；**本地 Dev 库没有任何自动备份**；恢复演练未定期化。

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

### 阶段 0　丢弃前必须做的两件事（安全底线）—— **已完成**，见 11.8

即使决定不要这份数据，也必须先留档：

1. ECS 上 `bash deploy/scripts/backup_daily.sh` → 生成 `heijin_erp_pg_<ts>.dump` + `.sha256`；
2. `bash deploy/scripts/pull_backup.sh --host <ECS>` 取回本地，存为 `backups/prod_final_<ts>.dump`。

**理由**：删库不可逆。这份 dump 是「上线前生产状态」的唯一证据；将来若发现某个客户/订单只存在于线上，还能捞回来。确认 `pg_restore -l` 能解析后再进入阶段 1。

> ⚠️ **这一步当天曾经是坏的**：ECS 上的 `backup_daily.sh` 是 SQLite 时代旧版，跑起来会「成功备份」一份 851 KB 的废弃 `heijin_erp_v1.db`，而真实 PG 库一个字节都没备。cron 每天 03:20 都在做这件事。11.8 记录了发现、修复与实测。

### 阶段 1　Release 库就绪（**已完成**）

| 项 | 状态 |
|---|---|
| `heijin_erp_release` 建库 | ✅ 由 dev 全量 dump 恢复（**不是** rawdata 导入——rawdata 少 49 单） |
| 结构 | ✅ 40 表，`alembic_version = 0001` |
| 数据 | ✅ 119 单 / 90 库存 / 370 流水 / 200 事件 |
| 客户 / 分期 / 返点 | 0 / 0 / 0（源数据本就没有，见 11.6） |
| 测试脏数据 | ✅ 已清（customers 12→0、counterparties 4→0、teams 2→0、测试用户已删） |

### 阶段 2　生成上线包（**已完成**，实测记录见 11.7）

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
     -c "select p.code, sum(case when c.direction='IN' then c.amount else -c.amount end) as cash
         from pools p left join cashflow c
           on c.pool_id=p.id and c.status='APPROVED'
         group by p.code order by p.code"
   ```
   期望：`0001` / **119** / **90** / **370**；池余额 **HJ_PROFIT 54,253.06**、**HJ_INVEST 57,579.17**。

   > 余额口径 = 已审流水按 `direction` 带符号求和（`app/orders/pools.py::pool_balances` 的 `cash_balance`），
   > **不是** `sum(amount)`。后者忽略方向，HJ_INVEST 会算成 744,382.61（收入 400,980.89 + 支出 343,401.72），属错误值。
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
| 7 | `frontend/package.json` | ✅ 已删 `test:regression:fast` 里悬空的 `test:e2e:critical`（改为 `npm run test:fast`）；`playwright` 依赖**待清**（需同步 lockfile） | 清理 E2E 残留 |
| 8 | `.env.bak-20261102-2115` / `.env.postgres-test` | 删除或移入受控的凭据管理 | 消除明文口令与误用面 |
| 9 | `backend/alembic/squashed_versions/0001_*.py` | 无需改动；但 `docs/` 需补一条「既有库如何演进」的操作说明 | 压平后最大的认知缺口 |
| 10 | `deploy/scripts/backup_daily.sh` 的 cron | 本地 Dev 与 Release 库增加每日 dump（不同目录、不同保留策略） | 目前只有生产有自动备份 |

---

## 九、备份 / 恢复 / 防误删

### 已有能力（实测）

| 能力 | 位置 | 说明 |
|---|---|---|
| 生产每日备份 | `backup_daily.sh` | `pg_dump -Fc`；三重完整性闸门（PGDMP 魔数、TOC 可解析、归档表数==源库表数）；sha256 sidecar；保留 30 份（`ERP_BACKUP_KEEP`）；备份写独立卷 |
| 恢复 | `restore_pg.sh` | 强制 `--yes`；校验 sha256；`pg_restore --list` 预检；**恢复前自动再备份**；`--single-transaction` 失败整体回滚。⚠ **该脚本只在仓库里，ECS 上没有**（见下方缺口 1） |
| 取回 | `pull_backup.sh` | 异地留存 |
| 测试库闸门 | `conftest.py` | 必须 PG + 库名含 `test`，否则拒绝运行 |

### 缺口与建议

| 缺口 | 建议 |
|---|---|
| **1. `restore_pg.sh` 未部署到 ECS** → ✅ **已补齐（11-03 00:07）** | ECS `/opt/heijin/deploy/scripts/` 原只有 6 个（缺恢复脚本）。已 `scp` 补齐，`sha256` 双端一致 `c18cff9c…273bca`、`bash -n` 通过、`--help` 实跑正常，现为 7 个 |
| Dev 库无自动备份 | `cron` 每日 `pg_dump heijin_erp_dev`，保留 14 份，写独立目录 |
| Release 库无备份策略 | 导入完成后立即 dump，并在每次清洗/合并前后各留一份 |
| PG 未开 WAL 归档 | 开启 `archive_mode=on` + `archive_command` 到独立卷，获得 PITR；至少要在正式发布前完成 |
| 恢复演练未定期化 | 每季度一次「从 dump 恢复到临时库 + 行数校验」，产出记录 |
| 无库级操作闸门 | 见「防误删」 |

### `restore_pg.sh` 实测（2026-11-03 00:05，一次性沙箱，非项目库）

该脚本从未被执行过，而它正是出事时要用的那个。本轮搭了一个 `compose` 沙箱（`postgres:16-alpine` + 空库，用完 `down -v` 并删目录），用 `release_20261102_235658.dump` 逐项验证：

| 用例 | 期望 | 实测 |
|---|---|---|
| 缺 `--yes` | 拒绝 | ✗ `恢复会覆盖正式库现有全部数据，请显式加 --yes 确认` |
| 缺 `--backup` | 拒绝 | ✗ `必须指定 --backup <备份文件>` |
| 文件不存在 | 拒绝 | ✗ `备份文件不存在` |
| 篡改 1 字节（有 sidecar） | 校验和拦截 | ✗ 打印期望/实得两个 sha256 并拒收 |
| 非 dump 文件 | 归档解析拦截 | ✗ `备份归档无法被 pg_restore 解析` |
| db 容器未运行 | 拦截 | ✗ `db 容器未运行` |
| 正常恢复（库中已有数据） | 覆盖并回到备份状态 | ✓ `RESTORE_OK objects=430`；被改的 `orders#104.note` 复原、`order_events` 200、orders 119、users 2、`alembic_version=0001` |

**发现一：`--clean` 不清「备份里没有的对象」。** 恢复前手工建了 `zz_probe` 表，恢复后它**仍然存在**（表数 41 而非 40）。含义很实际——`--clean` 只 DROP 备份内包含的对象，所以「用 restore 把库恢复到出厂状态」是错觉。生产库多一张遗留 `db_version`，若走 `restore_pg.sh` 恢复，它一定残留，`alembic current` / 表数校验都会看着不对。**这也是上线路径坚持 `DROP DATABASE ... WITH (FORCE)` 再空库恢复、而不是就地 `--clean` 的原因。**

**发现二（提示语误导）**：脚本在「backend 未运行时」也会打印 `==> 停止 backend`，因为 echo 在判断之前无条件执行。不影响正确性，但排障时会让人以为动过 backend。

**结论**：脚本本身可用，五道闸门都真实生效（不是摆设）。缺口只剩「它还没上 ECS」这一条。

### 防误删（针对本次事故类型的专项措施）

1. **库级白名单**：所有涉及写操作的脚本入口先过 `scripts/db_guard.sh`，只允许操作 `heijin_erp_dev` / `heijin_erp_test` / `heijin_erp_release`，其他库名立即中止。这一条纯属自保，不涉及对其他项目做任何改造。
2. **禁用裸 `DROP`**：仓库内禁止出现 `dropdb` / `DROP DATABASE` / `down -v`（CI 加 grep 检查，与 `scan_pii.py` 同级）。
3. **测试闸门加强**：见改动 1、2。
4. **生产库写操作双人确认**：`restore_pg.sh` 已有 `--yes`，建议再加一步「输入库名以确认」，避免复制粘贴误执行。

---

## 十、按优先级排列的实施清单

### P0（上线前必须完成，缺一不可）

1. **核实生产库现状**：✅ 已完成（11.8）——生产为 `0003` / 41 表 / **业务数据全空**；`prod_final_20261102_234555.dump` 已双端留档并校验。上线账号对齐 ✅ 已完成（11.10，方案 A）。
2. **建 `heijin_erp_release`**：✅ 已完成（11.1 / 11.5）——由 dev dump 恢复，**不是** rawdata 导入。
3. **Dev 库剥离真实数据**：确认 Release 校验通过后，Dev 可重置为纯结构库（此步需你明确授权，本轮未做）。
4. **部署链路适配压平**：✅ 已完成（`591e7f4`）——`deploy.sh` 版本戳预检 + 测试库黑名单。
5. **首次上线演练**：✅ 已完成（11.7）——本地临时库全流程 9 步，仅「管理员登录建单」因无口令未覆盖。

### P1（上线前建议完成）

6. ✅ 测试闸门加 `release/prod` 黑名单 + `TEST != DATABASE` 校验（`591e7f4`）。
7. ✅ **已复评：无需拆分**。`coverage-gate.yml` 的 postgres 是 GitHub Actions **一次性 service container**，库名 `heijin_erp_test`，job 结束即销毁，两个变量同值不会伤到任何真实数据；`conftest` 的「TEST ≠ DATABASE」校验在 `CI` 环境下按设计跳过。属命名冗余，不是风险。
8. 删除或归档 `heijin_erp_migration_test`（✅ **已完成 11-03 00:08**：归档 `archive_migration_test_20261102_235246.dump` 经真实恢复验证后 `DROP ... WITH (FORCE)`）。
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

余额（`cash_balance` 口径）：**HJ_PROFIT 54,253.06**（与 11-02 重建基线完全一致）、**HJ_INVEST 57,579.17**。

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
| `users` | 3 | **2** | 删 `user_test_20261101`；当时保留 `三三`(ADMIN) 与 `xuanxuan`(VIEWER)，**11.9 已整体替换为生产的 `admin` / `19873133890`** |

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

### 11.7 阶段 2 上线包与首次上线演练（2026-11-02 23:45）

**① 上线包已生成**

| 项 | 结果 |
|---|---|
| 文件 | 初版 `backups/release_20261102_234054.dump`（219,263 B）→ 账号对齐版 `release_20261102_235658.dump` → **现行 `backups/release_20261103_002342.dump`（219,284 B，CANCEL 标签改「取消」后重出，见 11.12）** |
| 校验 | `backups/release_latest.sha256` → 现行 `a0e322fa…66fad4`（历史：初版 `f4af4f80…83fc683`、账号对齐版 `b62f1a9b…818e6e`） |
| TOC 自检 | `pg_restore -l` 解出 **40 条 TABLE DATA**（= 40 表），TOC 共 445 条 |

**② 覆盖式重建演练（P0-5）——全流程通过**

在本地建临时库 `heijin_erp_drill`，逐条复刻第六节阶段 3 的动作，全绿后已删除该库：

| 步 | 动作 | 结果 |
|---|---|---|
| 1 | `CREATE DATABASE heijin_erp_drill` | ✅ |
| 2 | `pg_restore --no-owner --single-transaction` | ✅ 退出码 0，单事务，无 `--clean` |
| 3 | 表数 / 版本戳 | **40 表** / `0001` |
| 4 | 业务行数 | orders **119** / stocks **90** / cashflow **370** / order_events **200** / customers **0** |
| 5 | 种子 | `order_form_fields` **259** / `option_sets` **63** |
| 6 | 池余额（服务层 `pool_balances` 实算） | HJ_PROFIT **54,253.06**（收入 54,253.06 / 支出 0）；HJ_INVEST **57,579.17**（收入 287,510.47 / 支出 343,401.72）；押金 0 |
| 7 | `alembic current` | `0001 (head)`，**无 `Can't locate revision`** → `deploy.sh` 版本戳预检不会误拦 |
| 8 | `alembic upgrade head` | 零 DDL 输出，版本仍 `0001`，119 单未动 → **no-op 确认** |
| 9 | 后端启动 + `GET /api/v1/health` | `{"status":"ok","database_status":"ok"}`，`database` 指向演练库 |

**③ 演练暴露并已修正的一处文档错误**

原文档两处（阶段 3 校验期望、11.1 余额）写 `HJ_INVEST 744,382.61`，**是错的**。该值 = `cashflow` 全部金额绝对值之和（收入 400,980.89 + 支出 343,401.72），忽略了 `direction` 方向。

真实口径（`app/orders/pools.py::pool_balances` → `cash_balance = sum(IN) - sum(OUT)`，仅 `APPROVED`）为 **57,579.17**，dev 与 release 两库实测一致。已同步修正两处，并在阶段 3 第 6 步补上了可执行的余额校验 SQL（原步骤只查 `code, name`，根本没算余额）。

**④ 演练未覆盖的唯一一步**

阶段 3 第 8 步「管理员登录 → 建一笔回收单 → 作废」需要真实管理员口令，本机无凭据，未执行。这一步必须在上线日现场做，且**不要因为演练全绿就跳过**——健康检查只证明进程起来了，不证明写路径可用。

> **当日已补齐**：用临时库 + `create_admin.py` 造出的演练管理员把这一步跑通了（登录 / 建单 201 / 读取 / 作废 / 池余额接口复核），连同第 9 步的 `stamp_db_version` 与 `seed_policy_definitions` 一并验证，见 11.9。

### 11.8 生产首次连线：阶段 0 完成 + 三处脚本落后（2026-11-02 23:47）

**① 阶段 0 留档已完成**

| 项 | 结果 |
|---|---|
| ECS 侧 | `/opt/heijin/backups/prod_final_20261102_234555.dump`（198,322 B）+ `.sha256` |
| sha256 | `6652d607268a1ffce02c079fd2509f92d5f5fe77570d55051d97d998d9c4fe14` |
| 本地 | `backups/prod_final_20261102_234555.dump` + `.sha256`，**校验一致** |
| 可解析性 | 本地 `pg_restore -l` = **41 条 TABLE DATA**（= 生产 41 表） |

**② 发现：ECS 上三个部署脚本全部停留在 SQLite 时代**

| 脚本 | 本地（PG 版） | ECS（旧版） | 后果 |
|---|---|---|---|
| `backup_daily.sh` | 111 行，`pg_dump -Fc` + PGDMP 魔数/TOC 表数闸门 | **49 行**，`test -f /app/data/heijin_erp_v1.db` + `backup_db.py` | **cron 每日 03:20 备的是废弃 SQLite（851 KB），真实 PG 库零备份** |
| `deploy.sh` | 207 行，含版本戳预检 | 181 行，**无预检** | 上线时遇到 `0003` 直接硬停，且没有可读指引 |
| `pull_backup.sh` | 141 行，`--remote-dir /opt/heijin/backups` + ssh+tar | 166 行，`--volume deploy_erp_db` + `integrity_check`（SQLite 概念） | 异地留存拉的是 docker 卷里的旧 SQLite，不是 PG dump |

**实测证据**：同步前在 ECS 上直接跑旧版 `backup_daily.sh`，输出
`BACKUP_OK path=/app/data/backups/heijin_erp_v1_20261102_234541.db size=851968` —— 备份了一份 SQLite 文件并返回 0，cron 日志上完全看不出异常。这是「有备份但备错对象」，比没有备份更危险。

**③ 修复与实测**

1. ECS 原脚本先留档：`/opt/heijin/deploy/scripts/.bak-20261102/`（3 个文件，保留原 mtime）；
2. `scp` 同步仓库三件 → `bash -n` 语法检查通过；
3. 重跑 `backup_daily.sh`：`BACKUP_OK path=../backups/heijin_erp_pg_20261102_234642.dump size=198322 objects=440`，TOC 闸门通过（41 = 41）；
4. 本机跑 `pull_backup.sh --host heijin-prod`：拉取 6 份、SHA256 全通过、魔数 0 异常、`keep=3` 滚动生效；
5. cron 条目 `20 3 * * * .../backup_daily.sh` 无需改动，指向同一路径，次日 03:20 起自动产出 PG dump。

**④ 上线后用什么账号登录（→ 已按 A 执行，见 11.10）**

覆盖式重建会把生产 2 个账号（`admin`、`19873133890`）替换成上线包的 `三三`、`xuanxuan`，口令哈希一并替换。

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（✅ 已采用）** | 上线包内先把 `users` 对齐生产：从生产 dump 取 `admin` + `19873133890` 两行（含 `password_hash`）写入 release | 账号口令完全不变；需改 release 库一次（幂等、可重做） |
| B | 保留 `三三`/`xuanxuan`，上线后重新建号 | 上线当天必须知道 dev 口令，或走重置流程；易卡住 |
| C | 恢复后立刻用 SQL 把生产两行插回去 | 等效 A，但把风险推到上线窗口现场 |

**执行细节补充**：release 与生产两库 `users` 均为 **2 行、id 恰好都是 1/2、18 列顺序完全一致**，所以实际做法是**原地 UPDATE 而非删行重插**——`users` 被 6 处外键引用（`orders.owner_id` 等），删行会触发 RESTRICT。见 11.10。

**⑤ 陷阱：别用生产旧镜像去验「版本戳断裂」**

上线前在 ECS 上跑 `docker compose run --rm backend alembic current`，输出是干净的 `0003`、无任何报错——**这不代表预检会失效，而是验错了对象**。

| 位置 | 镜像 / 代码 | `squashed_versions/` | `alembic current` 结果 |
|---|---|---|---|
| ECS 现行 | `heijin-backend:1.0.1`（旧 commit 构建） | `0001` / `0002` / `0003` | `0003`，**不报错** |
| 仓库当前 | 压平后代码 | 仅 `0001` | `Can't locate revision identified by '0003'`，退出码仍为 **0** |

即：`0003` 是旧链里的合法版本，旧镜像当然认得。上线时 `deploy.sh` 用的是**新构建镜像**，在它眼里 `0003` 就是未知版本，预检照常触发。本地探针库（伪造 `alembic_version='0003'`）用当前代码实跑，复现的就是新镜像行为。

**校验方法**：验版本戳必须在**将要上线的那份代码**里跑；在旧镜像里跑只会得到「一切正常」的假象。

### 11.9 阶段 3 第 8–9 步补齐演练（2026-11-02 23:52，全部在本地临时库）

11.7 里未覆盖的「登录 → 建单 → 作废」与「部署脚本后半段」，本轮用临时库 `heijin_erp_drill2` 补齐（用完已 DROP）。

**① 部署脚本后半段（`deploy.sh` 在 `alembic upgrade head` 之后的三步）**

| 步骤 | 结果 |
|---|---|
| `stamp_db_version.py`（`APP_VERSION=1.0.1`） | ✅ `db_version` 表在 release 包里**不存在**，脚本靠 `create_all(checkfirst=True)` 自动建表并写入 1 行（`0001` / 1.0.1） |
| `seed_policy_definitions.py --apply` | ✅ 定义仍 6 条、版本仍 4 条（幂等）；日志措辞「将创建/已创建」有歧义，但计数无变化 |
| `create_admin.py`（`ADMIN_PASSWORD=…`） | ✅ 建出 `admin`（ADMIN） |

**② 冒烟：登录 → 建单 → 读取 → 作废**

| 动作 | 结果 |
|---|---|
| `POST /auth/login`（admin） | ✅ 200，取到 token |
| `POST /orders`（HS，`game_account=SMOKE_DRILL_20261102`） | ✅ **201**，单号 `HS0056`，`account_id=169`，`owner_id=4` |
| `GET /orders`、`GET /stocks` | ✅ 200，读到 119 单存量数据 |
| `GET /pools/1/balance`、`/pools/2/balance` | ✅ `57579.17` / `54253.06`——**与 11.7 修正后的余额口径完全一致**，等于接口层复核了那次纠错 |
| `POST /orders/227/cancel` | ✅ 200，订单转 `CANCELLED` |

**③ 关键结论：上线不会登不进去（影响 11.8 ④ 的方案选择）**

`create_admin.py` 的语义是**建或改**：找不到 `admin` 就建，找到就重置口令并置 ADMIN。所以只要部署时 `export ADMIN_PASSWORD='强口令'`，无论上线包里的账号是什么，都一定有一个可用的 `admin` 登录。**「覆盖后原账号登不进」不是硬阻塞，最多是「登进去的人不是原来那个人」。**

重估三个方案：

| 方案 | 真实后果 |
|---|---|
| **A** | 保住生产的 `19873133890`（何一）账号且口令不变；`admin`（id=1）口令会被 `ADMIN_PASSWORD` 覆盖成新值；119 单归属人显示名变成「系统管理员」 |
| **B** | 何一账号丢失，变成 `三三`/`xuanxuan` + 新建的 `admin`；历史数据不受影响（`created_by` 全是 `wps-import`） |
| **C** | 等价 A，但拖到上线窗口现场做 |

**④ 一处待业务确认的观察（非本次范围，不改）**

冒烟单作废后：订单 `status=CANCELLED`，但它生成的库存行仍是 `status=WAITING` / `inventory_status=IN_STOCK`（`KU_00091`）。即「撤掉一笔回收单，那个账号还留在在库列表里」。可能是有意（账号实物仍在手上，作废只表示单据无效），也可能是漏改。**需业务口径确认，本轮不动代码。**

**⑤ P1-8 孤儿库留档**

`heijin_erp_migration_test` 已 dump：`backups/archive_migration_test_20261102_235246.dump`（192,321 B，40 表），sha256 `5929303019…35e071`。库内**无任何业务数据**（orders/stocks/cashflow 全 0），只有种子 + `audit_logs` 17 + `document_sequences` 14。留档完成后可随时删除，等你点头。

### 11.10 作废回收单后库存未退：根因已定位，待口径裁决

11.9 ④ 的观察查到了确切位置，**不是数据问题，是代码分支覆盖不全**。

**现象**：HS 回收单无登记事件时作废 → 订单 `CANCELLED`，库存行仍 `status=WAITING` / `inventory_status=IN_STOCK`，且**仍出现在库存列表里、仍可售**。

**根因**（`app/orders/cancellation_model.py::cancel_order`）：

| 分支 | 代码行为 |
|---|---|
| DG 且 `form_extra.platform_unlist_scope == "SYSTEM"` | 账号 `WAITING → VOID`（第 176-184 行）——**唯一会动库存的分支** |
| 其余（HS / TH 无事件作废） | 只改 `order.status`，账号状态一字未动 |

库存列表的可见性来自 `app/stocks/_common.py:13`：`INVENTORY_STATUSES = (IN_STOCK,)`，`_inventory_rows()` 只按 `inventory_status` 过滤，**不看来源订单是否已作废**。所以那张单作废了，账号照样在「在库」里，`status=WAITING` 即待售。

**为什么不能直接改**：这属于业务口径，不是缺陷判定的技术问题——

- 若口径是「作废 = 这笔买卖没发生」→ 账号应随单退出库存（`VOID` 或 `OUT_OF_STOCK`），现在等于**留下一个可以误卖的账号**；
- 若口径是「作废 = 单据无效、账号实物仍在手上」→ 现在是对的，但需要使用者知道要手动「下架」（`FormScope("INVOID", "下架")`）才干净。

**测试覆盖**：`tests/v1/test_orders_contract.py` 有 `test_order_cancel_requires_no_posted_events`（只断言订单状态）与 DG 下架用例（断言账号退出库存），**HS/TH 无事件作废后库存如何，没有任何断言**——所以现状既不是「被测试锁定」，也不是「被测试证伪」，属于未定义地带。

**要么改代码、要么写进业务说明，二选一。** 我倾向先确认口径再动，因为一旦改，历史那部分也要考虑是否要补数据。

**已裁决并落地（2026-11-03 00:40，方案 A）**：判定依据不必在业务口径里二选一，**它本来就是「有无已登记资金事件」**——`cancel_order` 开头的 `is_posted` 查询就是分流点，有事件则拦下要求先冲销。而账号状态只由事件驱动（ACC-01-03/04），因此「无已登记事件」等价于**本单从未改变过账号状态**，只需处理账号的归属：

- **引用已有库存账号**的单（账号被多单共用）→ 保持原状；
- **内联建库**产生的账号（只被本单引用）→ 置 `VOID` 退出库存。否则它既留在库存列表里可被误卖，又会被前端建单判重当成「未售出库存账号」挡住同一账号重新建单（`CreateBusinessModal.tsx:143` 只排除 `VOID`）——形成「既卖不掉、也建不了单」的死锁；
- **代挂（DG）**维持原口径不变：仅 `platform_unlist_scope=SYSTEM` 终止账号，平台下架不动。

无需改第二个字段：`Account.status` 的 set 监听器会把 `inventory_status` 同步为 `OUT_OF_STOCK`，而库存列表只按 `IN_STOCK` 过滤。存量无损已实测：dev 库 **0 张 `CANCELLED` 单**、90 个带账号订单 **0 个账号被多单共用**。回归锁死见 `tests/v1/test_cancel_inventory_release.py`（5 条：内联建库取消退库存、取消后同账号可重新建单、引用型保持原状、有流水仍拦下、DG 平台下架不动）。

---

### 11.10 上线包账号对齐生产（方案 A 已执行，2026-11-02 23:56，全本地）

**目标**：覆盖式重建后，生产原账号 `admin` / `19873133890`（何一）能照旧登录，口令不变。

**取数**：生产 dump 已在本机（`prod_final_20261102_234555.dump`），**无需再连生产**。恢复进一次性临时库 `berp_prod_stage` 读出两行，用完即 `DROP`。

**两库结构比对（决定实现方式）**

| 项 | 结果 |
|---|---|
| 行数 | 均 **2** 行 |
| id | 均 **1 / 2**，一一对应 |
| 列 | 均 **18 列，列名与顺序完全一致** |
| 哈希 | 均 `pbkdf2_sha256$240000$`，salt 22 字符、hash 43 字符 |
| 引用外键 | `orders.owner_id` / `customers.owner_id` / `customer_leads.owner_id` / `notifications.recipient_user_id` / `order_profit_allocations.user_id` / `users.handover_user_id` 共 6 处 |

因为是 2↔2、id 对齐，**采用原地 `UPDATE` 而非删行重插**——`users` 被 6 处外键引用，`DELETE` 会撞 RESTRICT。列类型注意：`pool_ids` / `team_ids` 是 **json**，参数需 `::json` 转型（首次执行即报 `DatatypeMismatch`）。

**结果**

| id | username | display_name | role | must_change_password |
|---|---|---|---|---|
| 1 | `admin` | 系统管理员 | ADMIN | f |
| 2 | `19873133890` | 何一 | ADMIN | **t** |

- 何一 `pool_ids = [1,2]`（两池权限随行迁移，未丢）；
- 五处外键**悬空 0 行**（`orders.owner_id` 119 条全部仍指向有效的 id=1）；
- 哈希可被后端校验器解析：`verify_password('错误口令', hash)` 对两账号均返回 `False` 而非抛异常；
- 回滚快照：`backups/release_users_rollback_20261102.json`（替换前的两行，含 dev 哈希；`backups/` 已在 `.gitignore`）。

**新上线包**：`backups/release_20261102_235658.dump`（219,284 B，40 TABLE DATA），sha256 `b62f1a9b…818e6e`，指向记录在 `release_latest.sha256`（旧包 `release_20261102_234054.dump` 保留不删）。**11-03 00:23 又重出一次（CANCEL 标签改「取消」），现行以 `release_20261103_002342.dump` 为准，见 11.12。**

**重跑演练（临时库 `heijin_erp_drill3`，用完即 DROP）**

| 校验 | 结果 |
|---|---|
| `pg_restore --no-owner --single-transaction` | 退出码 0 |
| 表 / 版本戳 | 40 / `0001` |
| 行数 | 119 单 / 90 库存 / 370 流水 / 200 事件 / **2 用户** |
| `alembic current` | `0001 (head)`，无 `Can't locate revision` |
| 错误口令登录（两账号） | **401** `AUTH_REQUIRED`，非 500 → 哈希路径可用 |
| `ADMIN_PASSWORD=… create_admin.py` | 「管理员账号已就绪：admin」→ 登录 200 |
| 鉴权读取 | `/orders` 200、`/pools/1/balance` 200（`287510.47` / `343401.72`）、`/users` 200 |

**副作用与残留**

1. 119 单的 `owner_id` 仍 = 1，现在指向「系统管理员」——归属人显示名会从「李三」变「系统管理员」。语义修正（改成 id=2 何一）属动业务数据，**未做**。
2. `19873133890` 的 `must_change_password = true` 是**生产原值**，不是本次引入：上线后首次登录会被要求改口令。若要免除，改的是生产语义而非上线包，**未动**。
3. `create_admin.py` 是「建或改」，部署时 `export ADMIN_PASSWORD` 会**覆盖 admin(id=1) 的口令**——这是刻意保留的兜底，不影响何一账号。

---

### 11.11 孤儿库归档「可恢复」验证（2026-11-02 24:00）

11.9 只验证了 `archive_migration_test_20261102_235246.dump` **可被 `pg_restore -l` 解析**，那不等于可恢复。本轮补做真实恢复：

| 步骤 | 结果 |
|---|---|
| `shasum -a 256 -c *.sha256` | OK |
| 恢复到临时库 `heijin_erp_archcheck` | 退出码 0，`--single-transaction` |
| 表 / 版本戳 | **40** / `0001` |
| 业务行数 | orders 0 / stocks 0 / cashflow 0 / **users 0** |

结论：`heijin_erp_migration_test` 的归档是**可用的退路**，删除该库不会造成不可恢复的损失（且该库本身零业务数据）。临时库用完即 `DROP`。

---

### 11.12 取消口径统一：「动作=取消，财务账=冲销」（2026-11-03 00:20）

**用户裁决**：「系统里面有作废的说法都要去掉，只留取消」→「订单取消 / 取消交易 / 取消事件都统一为取消」→ 就 CANCEL 事件两处异名，裁定「动作上取消，财务帐上冲销」。

**落地边界（关键）**

| 层 | 用词 | 范围 |
|---|---|---|
| 业务动作 | **取消** | 订单取消、事件类型 `CANCEL`、策略草稿取消、账号终态 `VOID`、返点取消、三个表单作用域名 |
| 财务账务 | **冲销**（保留不动） | 资金流水冲销、核算属性 `REVERSAL`、业务事实冲销、返点冲销、`reversal_of_id` |

**四处改动**

1. `frontend/src/shared/lib/format.ts`：`EVENT_TYPE_LABEL.CANCEL` 由「冲销」改为「取消」，与 `EXECUTION_ACTION_LABEL.CANCEL`（本就用「取消」）一致。该映射此前**只定义未被引用**，页面实际走的是 `executionActionLabel`，所以用户看到的一直是「取消」——两处不同名属死映射残留。
2. 库内 `option_sets.ORDER_EVENT_TYPE` 的 `CANCEL` 标签：`heijin_erp_dev` 与 `heijin_erp_release` 双库 `UPDATE`（业务字典页与事件类型下拉读的是这里）。逐项比对确认只改这一项，其余 6 个选项逐字未动。
3. `backend/app/foundation/catalog_seed.py` 种子 blob 重导，否则新建库会把「冲销」复活。
4. 顺带修掉一处漏网硬编码：`OrderDetailExecutionSection.tsx` 审计动作列写死 `ORDER_CANCEL → "取消订单"`，改为「取消」（`labels.ts` 的 `AUDIT_ACTION_LABEL` 上轮已改，这处没走映射）。

**blob 重导的坑（下次别再踩）**：原 blob 的序列化参数是 `ensure_ascii=False` + `separators=(",", ":")`（中文直出、紧凑）。若用 `json.dumps` 默认参数重导，压缩后文本从 16,900 涨到 18,275 字符——内容相同但体积膨胀 8%。重导前先验证「原 raw 能否被候选参数逐字节复现」，复现成功再改。

**上线包随之重出**：`backups/release_20261103_002342.dump`（219,284 B，40 TABLE DATA，sha256 `a0e322fa…66fad4`）。`release_latest.sha256` 与《ERP_生产上线执行单_v1.0》的常量已同步；旧两版保留不删。

**未改（有意）**：`OrdersLedgerPanel` 台账卡片「已取消订单」（名词短语，指状态而非动作）；`deploy/` 与本文档本篇的取证过程记录保留原话，不改写当时的操作与现象留痕；`archive/` 属历史归档（README 明示不得作为开发依据），原样封存。

**现行规范已同步（2026-11-03 00:30）**：`ERP_PRD_v1.3_当前实现版`（0 处）、`ERP_接口错误码与状态机_v2.0`（0 处）、`ERP_PRD_F01_功能规格说明书`、`ERP_数据库建设实施方案_v1.1`、`前端测试用例库`、`前端建单与页面交互测试报告`、`ERP_生产上线执行单` 中的**业务动作用法**已全部改为「取消」。现行规范文档中仍保留「作废」的仅 4 处，全部是普通语义词、与业务动作无关：`README.md:3`「archive 存放已作废文件」、`README.md:34`「62 处 DFQ 已作废」、`ERP_页面原型与交互说明_v1.1.md:3`「相关交互已随该功能下线作废」、`ERP_PRD_F01_功能规格说明书.md:12`「DFQ 相关条目全部作废」（均指**条款/功能失效**，非单据动作）。`ERP_生产上线执行单` 保留的 1 处在已完成的演练记录里（「冒烟 9 项含登录、建单、作废、余额」），属过程留痕不改写。

---

## 附：操作边界声明

**检查阶段（第一~十节）**：只对本项目三个库执行 `SELECT`（`pg_database`、`information_schema`、`count(*)`）；未连阿里云生产库；未执行 DDL/DML；未改任何 `.env`。

**阶段 0 执行（第十一节，经用户两次确认后）**：

- `heijin_erp_dev` **只读**，仅 `pg_dump` 取全量备份（`backups/heijin_erp_dev_20261102_231449.dump`）；
- 新建 `heijin_erp_release` 并恢复该备份；
- 仅在 `heijin_erp_release` 内删除测试主数据（customers 12 / counterparties 4 / teams 2 / user_test_20261101）；
- `heijin_erp_test`、`heijin_erp_migration_test` 未触碰。

**生产连线（2026-11-02 23:45–23:50，经 SSH 别名 `heijin-prod`）**：第一~十节写作时的「生产库零连接」在此时被打破，动作全部为**只读 + 备份 + 脚本同步**：

- 只读：`docker ps`、`psql` 的 `\l` / `information_schema` / `pg_stat_user_tables` / `users` / `db_version` / `pools` 查询、`alembic current`；
- 备份：`pg_dump -Fc` 写出 `/opt/heijin/backups/prod_final_20261102_234555.dump`，并 `scp` 取回本地；
- 写入：`cp` 三份旧脚本到 `.bak-20261102/` 后 `scp` 覆盖为仓库版本（11.8 ③），并重跑 `backup_daily.sh` 生成一份新 dump 验证；
- **未做**：任何 DDL、任何业务表 DML、任何 DROP、未停任何容器、未动 `deploy/.env`。

**阶段 2 / 演练执行（11.7）**：从 `heijin_erp_release` **只读** `pg_dump` 生成上线包；演练用临时库 `heijin_erp_drill`（非本项目四库之一，用完即 `DROP ... WITH (FORCE)`），演练期间后端在 `127.0.0.1:8199` 临时起停，未触碰 8123 开发服务；`heijin_erp_dev` / `test` / `release` / `migration_test` **零写入**（11.7、11.9 两轮）。

**账号对齐（11.10，唯一一次对 `heijin_erp_release` 的写入）**：`UPDATE users` 两行（id=1/2）为生产 dump 中的同名同 id 行，18 列全量覆盖；替换前两行已留档 `backups/release_users_rollback_20261102.json`，可原地回写。取数用的临时库 `berp_prod_stage`、演练库 `heijin_erp_drill3` 均用完即 `DROP`。**生产库自「不想碰」宣告后未再连接**。

**后续两次经用户明确许可的动作（2026-11-03 00:07–00:08）**

- **写生产（仅新增一个文件）**：`scp deploy/scripts/restore_pg.sh` → `/opt/heijin/deploy/scripts/`，`chmod +x`；`sha256` 双端一致、`bash -n` 通过、`--help` 实跑正常。**未改任何已有文件、未启动/停止任何容器、未执行任何 DDL/DML**。
- **删本地库**：`DROP DATABASE heijin_erp_migration_test WITH (FORCE)`。删除前完成三项确认——归档 sha256 校验通过、归档**真实恢复**验证（40 表 / `0001` / 零业务行）、库内 orders/stocks/cashflow/customers/users 全为 0。
- **未动**：`heijin_erp_dev` / `test` / `release` 三库，以及 3 个他项目 `berp_*` 探针库。
