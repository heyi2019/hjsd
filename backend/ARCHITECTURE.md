# 后端目录架构

参考 `business-line-erp/backend/app` 的领域分包，黑金 ERP 采用：

```
app/
├── core/             # 金额、数据库、异常、运行时
├── foundation/       # 池/业务类型/类别/活字段主数据
├── finance/          # 资金池、流水、划转、押金
├── orders/           # 订单、事件、编号
├── accounts/         # 账号库存和成本
├── installments/     # DFQ 合约与收款
├── rebates/          # 返点归集与结算
├── reporting/        # R1–R5 只读报表
├── quality/          # 异常工作台
├── migration/        # 历史迁移与审计
├── models_new/       # 当前 v2 模型，逐步按领域迁移
└── services_new/     # 当前 v2 服务，逐步拆入领域服务
```

迁移期禁止删除或直接改动 legacy `routers/`、`models.py`、`services.py`。新功能优先写入领域包；当一个领域已完成 API/测试迁移，再下线对应 legacy 路由。
