# 黑金时代工作室 · 简易 ERP 数据字典

> 版本：v1.0 ｜ 关联：PRD / 架构设计 ｜ 作用：固化真实数据取值 + 建表规格 + 迁移清洗规则
> 数据来源：金山文档《黑金时代工作室》5 张表（截至 2026-10-03 实时读取）

---

## 1. 枚举字典（从真实数据提炼，编码前必须固化）

### 1.1 订单类型 order.type
| 取值 | 含义 | 本金处理 | 利润处理 | 来源示例 |
|------|------|----------|----------|----------|
| 回收 | 收号后卖出回款 | 回本金荷包 | 回利润荷包 | 回收本金3769+利润947 |
| 代挂 | 帮客户挂售，收服务费 | 无本金(0) | 全部利润 | 代挂收入13888→利润429 |
| 氪金联盟提号 | 渠道提号业务 | 本金进出对冲 | 提号费=利润 | 提号5659本金+702利润 |
| 代分期 | 首付+分期合约 | 首付回本金 | 分期利息=利润 | 首付278+本金748 |
| 转续保 | 盼之/螃蟹/千寻续保返点 | 无本金(0) | 全部利润 | 盼之首保6%返点87.11 |
| 返点 | 各类渠道返点 | 无本金(0) | 全部利润 | 螃蟹收号5%返点 |

### 1.2 渠道 channel
`盼之` / `螃蟹` / `千寻` / `同行` / `氪金联盟`
> 来源：第三张表"已推广渠道"列 + 第二张表备注。新增渠道需管理员维护。

### 1.3 账号状态 account.status
`在库` / `已售` / `分期中` / `已退`
> 来源：第三张表"售卖情况"(是/否) 归一化。分期中=已建 installment 且未完成。

### 1.4 人员 member（回收员/售卖员）
`小周` / `小轩` / `三三` / `何一` / `凯文` / `蒋丞选手` / `何邑` / `企业用户_1210076649`
> 来源：第二张表 recycler/seller 列。建议建 members 表，role=回收员/售卖员/委托人。

### 1.5 现金流类别 cashflow.category
`投资款` / `房租日用` / `办公用品` / `运营` / `员工薪资` / `其他`
> 来源：第一张表"类别"列（已含员工薪资，8 月新增）。运营消耗=房租日用+办公+薪资。

### 1.6 收支方向 cashflow.direction
`收入` / `支出`

### 1.7 回款账户 order.wallet
`本金荷包` / `利润荷包`
> 来源：第二张表"回款账户"列。本金进本金荷包，利润进利润荷包，严格隔离。

### 1.8 需求任务类型 lead.task_type
`代蹲` / `定找` / `代出`
> 来源：第五张表"任务类型"列。

### 1.9 分期状态 installment.status
`进行中` / `断分期` / `已完成`
> 来源：第四张表"分期情况"列（已完成/断分期归一）。

---

## 2. 核心字段规格（建表依据）

### 2.1 accounts（账号库存）
| 字段 | 类型 | 约束 | 来源表字段 |
|------|------|------|-----------|
| id | int | PK | — |
| recycle_date | date | not null | 日期 |
| principal | decimal(10,2) | ≥0 | 回收金额 |
| sale_price | decimal(10,2) | ≥0 | 售卖金额 |
| account_info | text | | 账号信息 |
| account_pwd | varchar(64) | | 账号密码 |
| bind_phone | varchar(20) | | 绑定手机号 |
| channel | enum | FK→渠道枚举 | 已推广渠道 |
| status | enum | 默认在库 | 售卖情况归一 |
| recycler | varchar(32) | | 回收人员 |
| has_second | bool | | 是否有二次 |
| wallet_verified | enum | 已注销/未注销 | 钱包实名情况 |
| camp_id | varchar(32) | | 营地 |
| remark | text | | 备注 |

### 2.2 orders（订单）
| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | int | PK | |
| date | date | not null | |
| type | enum | 见1.1 | |
| principal | decimal(10,2) | ≥0 | 本金，纯利润单=0 |
| profit | decimal(10,2) | ≥0 | 利润 |
| total | decimal(10,2) | =principal+profit(校验) | 交易金额 |
| recycler | varchar(32) | | |
| seller | varchar(32) | | |
| account_id | int | FK→accounts | 收/卖/代挂/分期必填 |
| wallet | enum | 见1.7 | 本金荷包/利润荷包 |
| channel | enum | | |
| query_no | varchar(64) | | 查询数据编号 |
| remark | text | | |

### 2.3 cashflow（现金流）
| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | int | PK | |
| date | date | not null | |
| category | enum | 见1.5 | |
| direction | enum | 见1.6 | |
| amount | decimal(10,2) | >0 | 绝对值 |
| order_id | int | FK→orders nullable | 关联订单时填 |
| remark | text | | |

### 2.4 installments（分期）P1
| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | int | PK | |
| account_id | int | FK→accounts | |
| principal | decimal(10,2) | | 总本金 |
| down_payment | decimal(10,2) | | 首付 |
| periods | int | | 期数 |
| per_period | decimal(10,2) | | 每期补款 |
| interest | decimal(10,2) | | 分期利息(=利润) |
| paid | decimal(10,2) | 默认0 | 已补款 |
| status | enum | 见1.9 | |
| buyer_contact | varchar(64) | | 买家联系 |
| next_pay_date | date | | 下次补款日 |

### 2.5 leads（需求池）P1
| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | int | PK | |
| demand | text | | 需求描述 |
| task_type | enum | 见1.8 | |
| client | varchar(32) | | 委托人 |
| budget | decimal(10,2) | | 预算 |
| status | enum | 寻找中/已完成 | |

---

## 3. 迁移清洗规则（金山文档 5 表 → SQLite）

### 3.1 表映射
| 金山文档表 | 目标 | 清洗要点 |
|------------|------|----------|
| 个人记账明细 | cashflow + orders(账号回收类) | 类别=账号回收的行拆为 orders；其余入 cashflow |
| 回款明细(本金/利润) | orders | 直接映射 principal/profit/wallet |
| 账号库存台账 | accounts | 售卖情况(是/否)→status；渠道归一 |
| 分期合约 | installments | 本金/首付/期数/已补款直迁 |
| 需求池 | leads | 任务类型/委托人直迁 |

### 3.2 脏数据处理
- **删除测试行**：明细="工作测试"/"工作测试136"等 ¥0/测试记录（已发现 7/24 工作测试136、7/24 工作测试0）。
- **本金/利润拆分**：回款明细表已含本金、利润列，直接取；流水账里"账号回收本金/回收本金/提号本金"=本金，"回收利润/返点"=利润。
- **金额校验**：order.total 必须等于 principal+profit，迁移时重算并标记异常行。
- **日期归一**：统一 YYYY-MM-DD；"月份/年份"列由 date 推导，不单独存。
- **人员归一**：`企业用户_1210076649`、`蒋丞选手`、`何邑` 保留原文（不做映射，避免误并）。

### 3.3 荷包初始化
迁移后由 orders 聚合得出本金荷包、利润荷包余额，与现金流末位结余(约 ¥43,582)交叉校验，差异记入迁移报告。
