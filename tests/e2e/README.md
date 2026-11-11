# e2e —— 真实浏览器规格

**职责边界**

只验证**跨层集成后才暴露的用户可见承诺**：弹窗是否真的关掉、深链是否落到正确页面、
写操作后界面是否真的变化。凡是 jsdom 能测的（纯逻辑、单组件渲染），不在这里重复。

理由是成本：E2E 需要真实 Chromium + 真实后端 + 独立库，单条耗时是组件测试的两个数量级。
**所以这一层只该覆盖高频 × 高损失 × 跨层三者兼具的路径**，不追求条数。

**为什么必须有这一层（2026-11-04 实证）**

组件测试里 `onClose` 是 `vi.fn()` 间谍，父组件不会真的把 `open` 置 false；jsdom + motion-stub
下 antd Modal 关闭后 DOM 也不移除。于是"点了关闭按钮"在单测里全绿，真实浏览器里弹窗关不掉。
凡是"点了之后界面是否真的消失/退回"的断言，只能放这里，且要断言**界面结果**而非"回调被调用"。

**环境**

独立库 `heijin_erp_e2e`，**常驻复用、每轮不清数据**：`e2e_db.py` 默认 keep 分支只补缺失表
+ 幂等播种，夹具按 `(business_mode, inventory_type)` 补足 `IN_STOCK` 账号，用例消耗后下一轮
自动补齐。CI 的 postgres service 是全新空库，同样由 keep 分支的 `create_all` 完成初始化；
绝不触碰 `heijin_erp_dev` / `heijin_erp_test` / ECS 生产库 `heijin_erp`。

**当前状态**

15 个 spec / 62 条用例已全部迁入本目录（2026-11-04），按区域分目录：

```text
tests/e2e/
├── system/    7 spec  外壳契约、导航可达、降级不白屏、弹窗几何、视觉回归、认证、角色切换
├── business/  1 spec  建单弹窗「放弃未保存」确认
├── finance/   1 spec  划转派生流水、对账核销
├── cross/     6 spec  五类业务写入、资金写路径、售出闭环、返点嵌套弹窗、CRUD、真实接口渲染
└── support/   api-stub.ts（8 个 spec 共用的导航桩）
```

`playwright.config.ts` 的 `testDir` 已指向 `../tests/e2e`。

**迁移陷阱（无变通余地）**

`visual.spec.ts-snapshots/` 必须与 spec 同目录整目录搬迁。快照按 spec 路径定位，
spec 一动而快照留在原地，`visual.spec.ts` 全部失败。本轮的快照已随
`visual.spec.ts` 一起落在 `tests/e2e/system/`。

**每条 spec 应对上一条承诺**

现有 15 个 spec 覆盖了 42 个注册功能中的 5 个。新增 spec 时在文件头声明承诺 ID，
并在 `docs/testing/承诺清单.csv` 里更新对应条目的 E2E 证据。
