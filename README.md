# 黑金时代 ERP

仓库一级结构参考 `business-line-erp`：

| 目录 | 职责 |
|---|---|
| backend | FastAPI、领域服务、模型、测试 |
| frontend | React、AppShell、领域页面与复制的设计系统 |
| database | 数据库迁移版本 |
| scripts | 导入、开发、运维脚本 |
| docs | 架构、治理、产品文档 |
| data / rawdata | 本地运行数据与只读原始输入（不得提交敏感数据） |
| runtime / logs / outputs | 运行态、日志、生成物（默认不提交） |
| deploy / monitor / security | 部署、健康检查与安全配置 |
| tests | 跨层测试与 fixture |
| archive / business_output | 历史归档与业务输出 |

业务需求与设计文档位于 `docs/`。旧代码迁移时保留 `backend/app/models_new` 与 `services_new`，新功能按领域包进入 `core/foundation/finance/orders/...`。
