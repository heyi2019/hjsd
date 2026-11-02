# 宜游轩 ERP·生产上线执行单（覆盖式重建）

**文件编号**：ERP-OPS-001　**版本**：v1.0　**编写日期**：2026-11-03
**适用前提**：生产库 `heijin_erp` 业务数据为空（2026-11-02 实测：orders/stocks/cashflow 全 0），决定用 Release 包**整体覆盖**，不做数据合并、不跑 `alembic upgrade`。
**配套文档**：`docs/ERP_数据库架构检查与治理方案_v1.0_20261102.md`（背景、取证与推演过程）

---

## 0. 常量（照抄，不要凭记忆改）

| 项 | 值 |
|---|---|
| SSH | `ssh heijin-prod`（root） |
| 部署目录 | `/opt/heijin/deploy` |
| 库 / 用户 | `heijin_erp` / `erp_app`（容器网络内 `db:5432`） |
| 上线包 | `release_20261102_235658.dump`（219,284 B） |
| 上线包 sha256 | `b62f1a9b1f30bebd277b6776abb4c15c7d6d67389d819136dfd484bccd818e6e` |
| 回滚包 | `prod_final_20261102_234555.dump`（198,322 B，**已在 ECS `/opt/heijin/backups/`**） |
| 期望终态 | 40 表 / `alembic_version=0001` / 119 单 / 90 库存 / 370 流水 / 200 事件 / 2 用户 |

> 上线包内自带 `alembic_version=0001`，**恢复后不要跑 `alembic upgrade head`**——那是 no-op，跑了会让人误以为做过迁移。

---

## A. 上线前（本地已完成，逐项打勾即可）

- [x] Release 库内容校验：40 表、119/90/370/200、0 客户、0 分期、0 返点
- [x] 账号对齐生产：`admin`(id1) / `19873133890`(id2)，含原口令哈希
- [x] 上线包生成 + sha256 + TOC 40 条 TABLE DATA
- [x] 空库恢复演练 9 项全绿（含登录、建单、作废、余额、健康检查）
- [x] 回滚包双端留档（ECS + 本地 sha256 一致）
- [x] ECS 备份/取回脚本已同步为 PG 版，cron `20 3 * * *` 生效
- [x] `restore_pg.sh` 已补齐到 ECS（11-03 00:07，sha256 双端一致 `c18cff9c…`、`bash -n` 通过）
- [ ] 上线窗口确定（选低峰，全程预计 15–25 分钟，含验收）

---

## B. 上线窗口（按顺序执行，每步看检查点）

### B1. 传包并校验

```bash
# 本地
scp backups/release_20261102_235658.dump heijin-prod:/opt/heijin/backups/
```

```bash
# ECS
cd /opt/heijin/backups
sha256sum release_20261102_235658.dump
```

**检查点**：输出必须等于 `b62f1a9b…818e6e`。不等就停下重传，别往下走。

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
docker cp /opt/heijin/backups/release_20261102_235658.dump "$CID":/tmp/release.dump
docker compose exec -T db pg_restore -U erp_app -d heijin_erp \
  --no-owner --no-privileges --single-transaction /tmp/release.dump
echo "restore_exit=$?"
docker exec "$CID" rm -f /tmp/release.dump
```

**为什么先 `docker cp`**：`pg_restore` 读自定义格式需要可寻址文件，从 stdin/管道读会报 `could not seek in file`。

**检查点**：`restore_exit=0`。非 0 时 `--single-transaction` 已整体回滚，库是空的（不是半套），可直接重跑本步。

### B6. 启动后端

```bash
cd /opt/heijin/deploy && docker compose up -d backend
docker compose ps                          # backend 应 healthy
```

> 这一步**不要**走 `deploy.sh`：它内含 `alembic upgrade head` 与 `create_admin`，前者对 `0001` 库是 no-op、后者会用 `ADMIN_PASSWORD` 覆盖 `admin` 口令。要跑也行，但要知道自己在改什么。

---

## C. 验收（全部通过才算上线完成）

### C1. 库层

```bash
cd /opt/heijin/deploy
docker compose exec -T db psql -U erp_app -d heijin_erp \
  -c "select version_num from alembic_version" \
  -c "select count(*) tables from information_schema.tables where table_schema='public'" \
  -c "select (select count(*) from orders) orders,(select count(*) from stocks) stocks,(select count(*) from cashflow) cf,(select count(*) from order_events) ev,(select count(*) from users) users"
```

**期望**：`0001` / **40** / **119 · 90 · 370 · 200 · 2**

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
2. 建一笔 HS 回收单 → 库存列表能看到该账号；
3. 作废该单 → 订单转 `CANCELLED`；
4. 打开资金页 → 两池余额与 C2 一致。

> 健康检查只证明进程起来了，**不证明写路径可用**。这四步覆盖「登录 → 写订单 → 生成库存 → 作废」整条链路。

### C5. 前端可达

`https://<域名>` 打开无 502/白屏；`/api/v1/health` 返回 `database_status: ok`。

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
docker compose up -d backend
```

**回滚后状态**：41 表（含遗留 `db_version`）/ `alembic_version=0003` / 业务数据全空 —— 即上线前原样。

> ⚠ 回滚后**必须搭配旧镜像**（`heijin-backend:1.0.1`）。新镜像的活动链只有 `0001`，面对 `0003` 会报 `Can't locate revision`，`deploy.sh` 的预检会硬停——这是预期行为，不是新故障。

> ⚠ 不要用 `restore_pg.sh` 做回滚或上线恢复：它走 `--clean`，**只删备份里包含的对象**，库里多出来的表（如 `db_version`）会残留（沙箱实测 41 表而非 40）。这是本流程坚持「先 DROP 再空库恢复」的原因。

---

## E. 已知遗留（不影响上线，登记备查）

| 项 | 影响 | 处理时机 |
|---|---|---|
| 119 单 `owner_id` 全为 1 → 归属人显示「系统管理员」 | 仅展示层 | 上线后按需改 id=2 |
| `19873133890` 的 `must_change_password=true`（生产原值） | 首次登录要求改口令 | 上线后自行决定 |
| 0 客户档案 | 客户维度报表为空 | 上线后正常建单逐步补录 |
| 分期 0 / 返点 0 | 业务事实上不存在，非漏导 | 无需处理 |
| `heijin_erp_migration_test` 孤儿库 | 已于 11-03 删除（归档可恢复） | 无需处理 |
| PG 未开 WAL 归档 | 无 PITR，只有每日 dump | 上线后尽快补 |

---

## F. 时间线（参考）

| 段 | 内容 | 预计 |
|---|---|---|
| B1–B2 | 传包 + 备份 | 3 min |
| B3–B5 | 停服 + 删库 + 恢复 | 5 min |
| B6 | 启动 | 1 min |
| C1–C5 | 验收含冒烟 | 10 min |
| — | 合计 | **约 20 min** |
