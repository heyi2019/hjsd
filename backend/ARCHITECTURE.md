# 后端目录架构

黑金 ERP 当前采用按业务领域拆分的后端结构：

```
app/
├── core/             # 配置、数据库、金额、安全、审计等基础设施
├── domain/           # 当前 ORM 模型与领域对象
├── foundation/       # 基础主数据与业务类型
├── finance/          # 资金池、流水、押金
├── orders/           # 订单、事件、编号
├── accounts/         # 账号库存和成本
├── installments/     # 分期合约与收款
├── imports/          # 导入、映射、对账与审计
├── quality/          # 数据质量扫描与异常检查
├── reporting/        # 只读报表
├── auth/             # 登录、令牌与用户认证
├── parties/          # 客户、合作方等主体
├── policy/            # 规则版本与策略
└── audit/             # 审计查询接口
```

每个业务领域通常由 `router.py`、`service.py`、`schemas.py` 和测试组成；写路径统一经过 Service 事务和审计记录。

返点记录、返点结算属于资金域，由 `finance` 统一维护，不再保留独立运行域；导入与对账属于 `imports`，数据质量检查属于 `quality`。
