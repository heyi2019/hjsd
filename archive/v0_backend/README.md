# archive/v0_backend —— v1 之前的实现（已下线）

## 这是什么

黑金时代 ERP 在 2026-10-04 之前的那套后端实现，**已全部停止挂载**。当时这些内容均为
git 未跟踪文件，为保留 P2 历史迁移的可追溯依据，采用**整体归档**而非删除。

| 归档内容 | 说明 |
|---|---|
| `app/main_legacy.py` | 旧 FastAPI 入口（原 `backend/app/main.py`），挂载 7 个旧路由 |
| `app/db.py` / `db_v2.py` | 旧引擎：指向 `data/heijin.db`、`data/heijin_v2.db` |
| `app/models.py` / `schemas.py` / `services.py` | 旧 5 表模型与业务逻辑（利润荷包、续保口径等） |
| `app/routers/` | 旧 7 个路由：accounts / orders / cashflow / reports / installments / leads / linkage |
| `app/models_new/` `app/services_new/` | 早期「M0 新模型」尝试：10 张表，无 API 路由 |
| `scripts/migrate_v2.py` | v0 → v2 的迁移脚本（依赖上面全部模块） |
| `tests/` | 旧 43 条测试 + 旧 conftest（随代码一起冻结） |

## 使用边界（重要）

- **不得作为任何业务规则的推断依据**。v1 的唯一业务依据是 `docs/ERP_*.md` 九份文档。
- **不得重新挂到 `app.main`**。入口已切换为 `app.api_v1:create_app`。
- 仅在 **M4 阶段 P2 历史数据迁移**时，作为字段/口径对照参考。
- 归档代码不再参与 `pytest` 收集，`import` 路径已失效，如需运行请临时复原。

## 如需临时复原

在仓库根执行（还原为当时的工作区状态，`app/main.py` 需另行取舍）：

```bash
cd /Users/aries/黑金时代
cp -R archive/v0_backend/app/* backend/app/     # 会覆盖同名文件，谨慎
cp -R archive/v0_backend/tests/* backend/tests/
cp archive/v0_backend/scripts/migrate_v2.py backend/scripts/
```

## 冻结信息

- 冻结时间：2026-10-04
- 冻结时状态：旧测试 43 条全绿
- 迁移后 `backend` 仅保留 v1 代码与 `tests/v1`
