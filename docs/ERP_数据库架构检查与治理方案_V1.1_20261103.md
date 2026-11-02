# 宜游轩 ERP｜数据库架构检查与治理方案

| 项 | 值 |
|---|---|
| 文件编号 | `ERP_数据库架构检查与治理方案_V1.1_20261103` |
| 运行域 | 工程 / 数据库与上线 |
| 阅读对象 | 开发、运维、上线执行人 |
| 编写日期 | 2026-11-03 |
| 编写人 | 何一 |
| 数据来源 | 全部为 2026-11-03 01:45 实测值，非推演 |

## 版本记录

| 版本 | 日期 | 变更 |
|---|---|---|
| V1.0 | 2026-11-02 | 初次取证：三库盘点、压平后的迁移链风险、备份缺口、上线路径裁决 |
| **V1.1** | **2026-11-03** | **终态重写。**已闭环 15 项（含 dev 剥离、恢复演练季度化），删除全部过程叙事与分轮演练记录（保留在 `archive/` 与 `ERP_业务裁决台账`）；库清单由「3 库含孤儿库」改为现存三库；新增多环境并行调试与 6 账号现状；未闭环收敛为 4 项 |

---

## 一、现状

### 1.1 本地三库（`container-db-1`，`postgres:16-alpine`，`127.0.0.1:5432`，用户 `erp_app`）

| 库 | 大小 | 表 | 版本 | 业务数据 | 用户 | 审计 | 定位 |
|---|---:|---:|---|---|---:|---:|---|
| `heijin_erp_dev` | 11 MB | 40 | `0001` | **全 0**（2026-11-03 02:15 已剥离真实数据；保留 259 字段 / 63 选项集 / 13 编号序列） | 3 | 0 | **开发库**：沙盒，可随意造数与删库；真实数据只在 release 与备份里 |
| `heijin_erp_test` | 11 MB | 40 | `0001` | 全 0（含配置表） | 0 | 0 | **测试库**：pytest 专用，每用例 `TRUNCATE`；体积为系统目录碎片，非数据（见结论 12） |
| `heijin_erp_release` | 12 MB | 40 | `0001` | 119 / 90 / 370 / 200，客户 0、合作方 0 | **6** | 503 | **上线母本**：与上线包字节级一致，只读 |

三库公共基线：`order_form_fields` 259 / `option_sets` 63。
资金账户 2 个（已审流水带符号求和）：`HJ_INVEST`（投资款荷包）**57,579.17**（259 笔）、`HJ_PROFIT`（利润荷包）**54,253.06**（109 笔）。

> 同实例另有 4 个**他项目**库（`business_line_erp` 841 MB、`berp_trash_20260926_probe` 650 MB、`berp_oct06_probe` 331 MB、`berp_restored_candidate` 75 MB，合计约 1.9 GB）。**不在治理范围**，不评估、不改造、不触碰。

### 1.2 生产（阿里云 ECS，SSH 别名 `heijin-prod`）

| 项 | 值 |
|---|---|
| 容器 | `deploy-db-1`(healthy) / `deploy-backend-1`(healthy) / `deploy-frontend-1` |
| 库 / 用户 | `heijin_erp` / `erp_app`；端口不对公网开放 |
| 版本戳 | **`0003`**（不在只剩 `0001` 的活动链里） |
| 表数 | **41**（多一张遗留 `db_version`） |
| 业务数据 | **全空**：orders / stocks / cashflow / order_events / customers / installments / rebate 全 0 |
| 仅存 | `users` 2（`admin`、`19873133890` 何一，均 ADMIN）、`audit_logs` 29、种子 212 / 62 |
| 归档 | `archive_mode=off` → 无 PITR |

**它是「旧结构 + 空数据」的空壳。**上线时整库删除、由上线包覆盖重建，无业务数据损失。

### 1.3 上线包

| 项 | 值 |
|---|---|
| 文件 | `backups/release_20261103_011557.dump`（219,946 B） |
| sha256 | `fc8b89fd…564fc7`（sidecar：`release_latest.sha256`） |
| TOC | 430 条，其中 `TABLE DATA` 40 条 |
| 内容 | 40 表 / `0001` / 119·90·370·200 / 6 用户 / 0 客户 / 259 字段 / 63 选项集 |

### 1.4 账号与权限

| id | 账号 | 姓名 | 角色 | 数据范围 | 资金账户 | 强制改密 |
|---:|---|---|---|---|---|---|
| 1 | `admin` | 系统管理员 | ADMIN | ALL | `[]` | 否 |
| 2 | `19873133890` | 何一 | ADMIN | ALL | `[1,2]` | 是（生产原值） |
| 4 | `sansan` | 三三 | ADMIN | ALL | `[1,2]` | 是 |
| 5 | `xiaoxuan` | 小轩 | OPERATOR | ALL | `[1,2]` | 是 |
| 6 | `jixiang` | 吉祥 | OPERATOR | ALL | `[1,2]` | 是 |
| 7 | `kaiwen` | 凯文 | OPERATOR | ALL | `[1,2]` | 是 |

前两名的口令哈希自生产原样搬入；后四名初始口令 `Heijin@2026`（首次登录强制修改）。
**权限点不在数据库里**：`backend/app/core/security.py` 的 `ROLE_PERMISSIONS` 定义 25 个权限点 × 5 角色（ADMIN 25 / OPERATOR 12 / FINANCE 10 / AUDITOR 8 / VIEWER 2），改角色能力必须改代码并发布；库里只能改 `role` / `owner_scope` / `pool_ids` / `team_ids`。

### 1.5 配置与库切换链路

```
前端端口 → vite proxy(/api/v1) → 后端端口 → ERP_ENV_FILE → DATABASE_URL → 库
```

| 环境 | 前端 | 后端 | 环境文件 | 库 |
|---|---:|---:|---|---|
| 开发 | 5188 | 8123 | 根 `.env` | `heijin_erp_dev` |
| 母本只读 | 5190 | 8124 | `.env.release` | `heijin_erp_release` |

- 库在**后端进程启动时**由 `DATABASE_URL` 固定，`get_engine()` 是进程级单例，全仓除测试外**零调用** `reset_engine()`——运行中不会自切库。
- 多环境并行靠 `ERP_ENV_FILE`（`settings.py:31`），各进程各读各的，无需改根 `.env`。
- 前端只认端口，不认库；`VITE_API_BASE=/api/v1` 走同源代理。
- `.env` 变体已被 `.gitignore` 的 `.env.*` + `!.env.example` 覆盖（此前 `.env.release` 会被静默跟踪）。

---

## 二、已闭环（15 项）

| # | 事项 | 结论 |
|---:|---|---|
| 1 | 生产库现状核实 | `0003` / 41 表 / **业务数据全空**；`prod_final_20261102_234555.dump` 双端留档 |
| 2 | 上线包账号对齐生产 | 已换为生产原账号 + 原口令哈希，覆盖重建后账号口令不变 |
| 3 | 建立 `heijin_erp_release` | 由 dev 全量 dump 恢复（**不是** rawdata 导入——rawdata 少 49 单），40 表 / `0001` / 119·90·370·200 |
| 4 | release 测试脏数据清零 | customers 12→0、counterparties 4→0、teams 2→0、测试用户已删 |
| 5 | 孤儿库 `heijin_erp_migration_test` | 归档 dump 经**真实恢复验证**后 `DROP … WITH (FORCE)`，实例内已无此库 |
| 6 | 压平后部署链路适配 | `deploy.sh` 加版本戳预检：`alembic current` 含 `Can't locate revision` 即打印重建指引并中止 |
| 7 | 测试库闸门三重 | ①只认 `TEST_DATABASE_URL`（**不回落** `DATABASE_URL`）②库名必含 `test` ③黑名单 `release/prod/production/live/rehearsal` + 禁止与 `DATABASE_URL` 同库 |
| 8 | `restore_pg.sh` 部署到 ECS | 原 ECS 只有 6 个脚本、缺恢复脚本；已 `scp` 补齐，双端 sha256 一致，现 7 个 |
| 9 | 本地 dev/release 每日备份 | `backup_local.sh`（表数闸门 + sha256 sidecar + 保留 14 份）+ **cron 04:10 已装**，`env -i` 空环境实测通过 |
| 10 | 最终上线包复检 | 用交付物本身恢复临时库：`011557` / 40 表 / `0001` / 119·90·370·200 / **6 用户** / 余额 57,579.17 与 54,253.06 / 全库「作废」零残留 |
| 11 | 取消交易术语统一 | `ORDER_EVENT_TYPE.CANCEL` = **取消**；财务侧动作叫**冲销**（`reversal_of_id`），两者不混用 |
| 12 | 库存编号返回 `null` | `inventory()` 漏传 `stock_no` → 列表「库存编号」列、移动端标题、CSV 导出、订单详情全部取空；已修 + 测试锁断言 |
| 13 | 多环境并行调试 | 5188/8123/dev 与 5190/8124/release 并行，双端 `/health` 各自回报库名 |
| 14 | **Dev 剥离真实数据** | 02:15 执行：清 27 张业务表（119 单 / 90 库存 / 370 流水 / 200 事件 / 12 客户 / 4 合作方 / 499 审计全归 0），**保留 13 张配置与账号表且行数逐项不变**（259/63/21/6/3/3/2/0/0/3/2 + `0001` + 13 编号序列）。剥离前备份 `dev_before_strip_20261103_015634.dump` |
| 15 | **恢复演练季度化** | `deploy/scripts/restore_drill.sh`：默认演练 `release_latest.sha256` 指向的包，恢复临时库 → 6 项不变量断言（40 表 / `0001` / 2 个账户 / 13 序列 / 无「作废」/ CANCEL=取消）+ 可选精确期望值，验完 `DROP … WITH (FORCE)`。首跑 `011557` 全绿（119·90·370·200·6 用户）。**cron `0 5 1 1,4,7,10 *` 已装**，`env -i` 空环境通过；两条反例实测会真失败（期望不符 exit 1 / 包缺失 exit 2） |

---

## 三、未闭环（4 项）

| # | 事项 | 现状 | 裁决点 |
|---:|---|---|---|
| 1 | **上线窗口未定** | 执行单 A 节 10 项已全勾，仅剩此项 | **唯一阻塞上线的事项** |
| 2 | WAL 归档 / PITR | `wal_level=replica` 已够，差 `archive_mode=on`（实测仍 `off`） | A 暂缓 / B 归档进同一卷 / **C 加宿主机挂载（推荐）**。`archive_mode` 是 postmaster 级，改需重启共享容器 |
| 3 | `playwright ^1.64.0` 依赖 | 入口脚本已修，依赖仍空转 | 移除须同步重生成 `package-lock.json`，否则 `npm ci` 直接失败 |
| 4 | `.env.bak-20261102-2115` / `.env.postgres-test` | 含明文口令，本机未跟踪（已被 `.gitignore` 拦住） | 删除或移入凭据管理 |

**角色配置的空白（不影响上线，影响分工）**：FINANCE / AUDITOR / VIEWER 三个角色**无人**。因此押金、划转、财务侧回款目前**只有 ADMIN 可做**，全部压在管理员身上。要么把一名 OPERATOR 转 FINANCE，要么接受集中。

**经营规则为空**：`policy_definitions` / `policy_versions` 在 release 与 dev 均 0 条。上线后版本化规则（费率、分成比例）是空白状态，需在业务侧逐条建立。

---

## 四、目标架构

```
GitHub Actions（每次 push）
  services.postgres 临时容器（heijin_erp_test，job 结束即销毁）
        │ coverage / lint / frontend gate
        ▼
本机 Docker PG（container-db-1）
  heijin_erp_dev     开发调试、建单演练（可清空重建）
  heijin_erp_test    pytest（TRUNCATE 闸门 + 黑名单）
  heijin_erp_release 上线母本，只读；每日备份
        │ pg_dump -Fc（表数闸门 + sha256 + 保留 14 份）
        ▼
阿里云 ECS（docker compose）
  heijin_erp（Prod）仅容器网络可达；每日 03:20 备份 + 三重校验
```

三条数据流互不交叉：**历史数据流**（rawdata → Release → Prod，一次性）、**开发流**（Dev 持续）、**验证流**（Test / CI，永不接触 Release 与 Prod）。

---

## 五、上线路径：覆盖式重建

> 已裁决：线上库整体删除，从上线包重建。**不对旧库跑 `alembic upgrade`**，这同时消解了 `0003` 版本戳断裂问题。

1. **再备份一次线上库**（阶段 0 的备份可能已隔数日）：`bash deploy/scripts/backup_daily.sh` → `pull_backup.sh` 取回。
2. 传包：`scp backups/release_20261103_011557.dump root@<ECS_IP>:/opt/heijin/`。
3. 停应用释放连接：`cd /opt/heijin && docker compose stop backend`。
4. 删旧库、建空库：
   ```bash
   docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
     -c "DROP DATABASE IF EXISTS heijin_erp WITH (FORCE)" \
     -c "CREATE DATABASE heijin_erp OWNER $POSTGRES_USER"
   ```
5. 恢复：
   ```bash
   docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d heijin_erp \
     --no-owner --single-transaction < /opt/heijin/release_20261103_011557.dump
   ```
   **不要加 `--clean`**：目标是空库，`--clean` 会因 DROP 不存在的对象而报错。
6. 校验（全部通过才继续）：
   ```bash
   docker compose exec -T db psql -U "$POSTGRES_USER" -d heijin_erp \
     -c "select version_num from alembic_version" \
     -c "select count(*) from orders" -c "select count(*) from stocks" \
     -c "select count(*) from cashflow" -c "select count(*) from users" \
     -c "select p.code, sum(case when c.direction='IN' then c.amount else -c.amount end) as cash
         from pools p left join cashflow c on c.pool_id=p.id and c.status='APPROVED'
         group by p.code order by p.code"
   ```
   期望：`0001` / **119** / **90** / **370** / **6**；`HJ_INVEST` **57,579.17**、`HJ_PROFIT` **54,253.06**。
7. `docker compose up -d` + `curl -fsS localhost:8000/api/v1/health`。
8. 冒烟：管理员登录 → 建一笔回收单 → 库存可见 → 取消（走事件冲销，见结论 9）。
9. 剩余部署步骤：`bash deploy/scripts/deploy.sh`（版本戳预检此时会通过）。

**失败恢复**：第 5 步失败 → 库为空或半残，直接重跑第 4-5 步；要退回旧数据 → `restore_pg.sh --backup backups/prod_final_20261102_234555.dump --yes`；应用侧 → `rollback.yml` 指定旧镜像 tag。

---

## 六、备份与恢复

| 能力 | 位置 | 要点 |
|---|---|---|
| 生产每日备份 | `backup_daily.sh`（ECS，cron 03:20） | `pg_dump -Fc`；三重闸门（PGDMP 魔数 / `pg_restore --list` 可解析 / 归档表数==源库表数）；sha256 sidecar；保留 30 份 |
| 本地每日备份 | `backup_local.sh`（cron 04:10） | 一次备 dev + release；表数闸门；保留 14 份 → `backups/local/` |
| 恢复 | `restore_pg.sh`（仓库 + ECS 双端） | 强制 `--yes`；校验 sha256；恢复前自动再备份；`--single-transaction` 失败整体回滚 |
| 取回 | `pull_backup.sh` | 异地留存 |
| 测试闸门 | `conftest.py` | 见二-7 |

**WAL / PITR**：当前只有每日 dump，最坏丢 24h。三个方案见三-3，未裁决前不要改 `postgresql.conf`（`archive_mode` 是 postmaster 级，改完必须重启 `container-db-1`，会中断同实例他项目三个库的连接）。

---

## 七、必须记住的结论（踩过的坑）

1. **结构落后的库绝不能 `stamp`。** `0001` 的语义是「按当前 ORM 全量建库」，对结构未完成的库 stamp 等于伪装成已升级，之后 `upgrade head` 是 **no-op**。`stamp` 只适用「结构已最新、仅标签错」。
2. **验版本戳必须用「将上线的那份代码」。** 生产现行镜像 `heijin-backend:1.0.1` 的 `squashed_versions/` 仍含 0002/0003，在其中跑 `alembic current` 会输出干净的 `0003`，看着一切正常；以仓库当前代码（只剩 0001）跑才报 `Can't locate revision`。
3. **`--clean` 不清「备份里没有的对象」。** 实测：恢复前手工建的表在 `--clean` 恢复后仍然存在（41 表而非 40）。所以「用 restore 恢复到出厂状态」是错觉——这正是上线坚持 `DROP DATABASE … WITH (FORCE)` + 空库恢复的原因。
4. **余额 = 已审流水按 `direction` 带符号求和**，不是 `sum(amount)`。后者忽略方向，`HJ_INVEST` 会算成 744,382.61。
5. **`alembic` 与运行时共用 `DATABASE_URL`**（`alembic_url` 直接返回 `database_url`）。`alembic upgrade` 打的就是 dev 库，没有任何隔离。
6. **改 `.env` 必须重启后端。** `uvicorn --reload` 只监听 `backend/app/`，而 `.env` 在仓库根目录——改了不重启，一点都不会变。
7. **能力清单以目标机器实际文件为准。** ECS 上的 `deploy/scripts/` 曾整体停留在 SQLite 时代，`backup_daily.sh` 每天「成功备份」一份 851 KB 的废弃 `.db` 并返回 `BACKUP_OK`，真实 PG 零备份。
8. **cron 默认 `PATH` 只有 `/usr/bin:/bin`**，而本机 docker 在 `/opt/homebrew/bin`。脚本内自设 `PATH` + `command -v docker` 前置检查；验证用 `env -i HOME=$HOME /bin/bash <脚本>` 模拟空环境，不用等第二天。
9. **取消失败 ≠ 退库存。** 判定依据是「有无已登记资金事件」：HS 建单必带 `initial_buy`，故 `POST /orders/{id}/cancel` 必 422；正确路径是 `POST /orders/{id}/events` + `event_type=CANCEL` + `offset_event_id` + `pool_id`。对业务流水直接 `POST /cashflows/{id}/reverse` 会被拒。
10. **库名闸门挡不住同库错配。** 闸门只校验「库名含 test」，`heijin_erp_release_test` 这类命名必须靠黑名单拦——已加。
11. **shell 里 `${VAR}` 紧跟中文标点一律写花括号**，否则全角括号被并进变量名（`FILE: unbound variable`）。
12. **test 库会因反复建删表而持续膨胀，`VACUUM FULL` 只能暂时收缩。** `conftest` 每个 session 都 `create_all`（40 表）+ 建 `seed_template` schema 再 `create_all`（又 40 表）+ teardown `DROP SCHEMA … CASCADE`，系统目录只增不减：实测一次 9 用例的 session 让 `pg_class` 从 344 kB 涨到 840 kB、库从 9.5 MB 涨到 11 MB。19 MB → `VACUUM FULL` → 9.5 MB，但跑完一轮测试又回到 11 MB。**根因不是 `seed_template` 副本**（它每个 session 结束都 DROP 掉，平时不存在），是 `pg_class`/`pg_attribute` 的文件碎片。想真正归零只能 `DROP DATABASE` 重建（让 OID 归位），收益随规模递减，暂不处理。
13. **`document_sequences` 不是业务表，清空它等于让建单/发库存号/建合作方全部瘫痪。** `allocate_number()` 在序列行不存在时直接抛 `Validation`「编号序列 X 尚未初始化，请先执行基础种子」（`core/numbering.py:62`），而自动补建行的 `ensure_sequence()` 只在**基础种子**里被调用，运行时路径不会补。剥离 dev 时按「业务表」把它一并 `TRUNCATE` 是错的——正确做法是**保留 13 行、只把 `current_value` 归零**（本次保留原值，避免将来回导 rawdata 撞号）。识别方法：一张表里既有 `prefix`/`padding`（配置）又有 `current_value`（计数器），就是混合型，不能当纯业务表清。
14. **`TRUNCATE` 的级联方向会从子表向父表蔓延，可能连带清掉配置表。** `TRUNCATE orders CASCADE` 会顺着引用关系把 `order_form_fields`(259) 这类被业务表引用的配置一并清空，建单页当场报废。安全做法：**显式列出全部待清表、单事务、不加 `CASCADE`**，并事先用 `pg_constraint` 查询确认「保留表没有任何一个引用待清表」（本次仅 3 条 FK，全部指向保留表内部）。清完必须**逐项比对各配置表行数**，不相等立即从备份恢复。

---

## 附：操作边界

- 本文所有写操作**仅限** `heijin_erp_dev` / `heijin_erp_test` / `heijin_erp_release` 三个库；同实例他项目的库一律不触碰。
- 生产库结构的任何变更，唯一路径是第五节覆盖式重建；**禁止 `alembic stamp` 绕过**。
- `heijin_erp_release` 是母本：**登录不写库，但任何写操作都会让它偏离上线包**。要看数据可以，要演练建单请回 dev。
