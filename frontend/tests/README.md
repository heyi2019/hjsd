# frontend/tests —— 与组件解耦的纯逻辑测试

**准入标准**

只有「被测模块不渲染 DOM」的测试才放这里，典型是 `src/shared/lib/`（金额格式化、
列表列解析）、`src/shared/api/`（请求构造与错误映射）、`src/stocks/*-logic` 这类纯函数。
判断依据是**被测模块的 import**，不是测试文件名后缀：

| 测试 | 被测模块 | 准入 | 原因 |
|---|---|---|---|
| `shared/lib/money.test.ts` | `money.ts`（零 import） | ✅ | 纯函数 |
| `stocks/inventory-logic.test.ts` | `inventory-logic.ts` | ✅ | 纯函数 |
| `stocks/findCancelable.test.ts` | `InventoryPanel`（React 组件） | ❌ | 拉进组件树 |
| `stocks/InventoryPanel/helpers.test.ts` | `helpers.tsx`（含 JSX） | ❌ | 同上 |
| `field-definitions/formScopes.test.ts` | `formScopes.ts`（import React hooks） | ❌ | 非组件但依赖 React 运行时 |

组件测试**不迁**，留在 `src/` 旁——"改组件时顺手看到测试"这个便利是它们的价值来源。

**为什么在 `frontend/tests/` 而不是仓库根 `tests/frontend/`（实测结论，别再试）**

仓库根没有 `node_modules`，vitest 的 root 又是 `frontend/`，包外测试会连着踩两个坑：

1. `Cannot find module '/@fs/.../tests/frontend/x.test.ts'` —— Vite 的 fs 白名单默认只含
   workspace root，越界文件被拦。加 `server.fs.allow` 可以放过。
2. 放过后立刻换一种失败：`Failed to resolve import "axios"` —— **bare 依赖按 importer
   所在目录向上找 `node_modules`**，从仓库根往上找不到 `frontend/node_modules`。
   `@/` 别名能解决相对路径，但解决不了裸包解析。

所以 2026-11-04 的落点是包内 `frontend/tests/`：路径键仍是 `frontend/…` 前缀，
`test_catalog.frontend_func_for()` 的路径片段规则、`record_frontend_results.py` 的
`frontend/…::标题` 键全部零改动。曾短暂搬到仓库根，先撞坑 1、再撞坑 2，已回退。

**搬迁前置条件（一次做全，不许半途）**

1. `vite.config.ts`、`vitest.config.ts`、`tsconfig.json` 三处同时加 `@ → src` 别名 ✅
2. `vi.mock` 相对路径守卫（`src/test/mock-specifier.test.ts`）已把扫描面扩到本目录 ✅
3. 四处路径同步：`scripts/test-layers.mjs` 的 glob、`vitest.config.ts` 的
   include/exclude、`scripts/test-full-sharded.mjs` 的收集根、`tsconfig.json` 的 include ✅
4. 搬完跑 `npm run test:fast` + `tsc`，再跑 `gen_test_case_library.py` 确认用例编号零漂移 ✅

**当前状态**

已迁入 **15 个文件 / 105 条用例**：

```text
app/businessReminderConfig.test.ts        policy/policyConfigSchema.test.ts
shared/api/{catalog,catalog.orders,client,client.cache}.test.ts
shared/lib/{format,listColumns,money,retiredProducts}.test.ts
stocks/{StocksApiRoutes,consignment-logic,inventory-export,inventory-logic,sale-plan}.test.ts
```

`src/` 内还剩 8 个 `.test.ts`：`test/`（fixtures、mock-specifier 两个测试基建自测）、
`vite.config.test.ts`，以及上表判为不准入的 5 个。
