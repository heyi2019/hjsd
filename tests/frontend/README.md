# tests/frontend —— 前端测试（vitest）

更新：2026-11-04。本目录是前端测试的**唯一根**，`frontend/src/**` 下已无任何测试文件。

```text
tests/frontend/
├── unit/<区域>/      不挂载 React：纯函数、请求构造、静态守卫     24 文件
└── module/<区域>/    挂载组件的渲染与交互（jsdom + antd）        70 文件（含 16 个 .deep）
```

区域名 = 一级导航名：`system` / `workbench` / `business` / `customer` / `finance` /
`operations` / `settings` / `shared`。

## 1. `unit` 与 `module` 怎么分

判据是**被测代码是否需要 DOM**，不是文件名：

| 测试 | 被测模块 | 归层 | 原因 |
|---|---|---|---|
| `unit/shared/money.test.ts` | `money.ts`（零 import） | unit | 纯函数 |
| `unit/business/inventory-logic.test.ts` | `inventory-logic.ts` | unit | 纯函数 |
| `unit/system/mock-specifier.test.ts` | 静态扫盘 | unit | 无渲染、无网络 |
| `module/business/OrdersPage.test.tsx` | `OrdersPage.tsx` | module | 渲染页面 |
| `module/shared/session.test.tsx` | `SessionProvider` | module | 渲染 Provider |

写错了不会报错，只会让 `test:fast` 变慢（把组件测试拖进秒级通道）或让纯逻辑测试挤进
jsdom 通道浪费 20 倍时间。已用 `@testing-library/react` 的 import 作为机械判据扫过一遍。

## 2. 模块定位：只用别名

```ts
import { renderLight } from "@fixtures/render";      // 测试基建（tests/fixtures）
import { OrdersPage } from "@/orders/OrdersPage";    // 被测源码（frontend/src）
vi.mock("@/shared/api/client", () => ({ api: mock }));  // mock 也用别名
```

- `@` → `frontend/src`
- `@fixtures` → `tests/fixtures`
- 禁止 `./` `../`：相对路径搬目录后**仍可能解析到某个存在的文件**，mock 不报错却没命中
  被测模块，测试改用真实现照常通过 —— 保护静默消失。守卫是
  `unit/system/mock-specifier.test.ts`（基线为空，新增即红）。

## 3. 跑法

```text
cd frontend
npm run test:fast                              # 纯逻辑 + 守卫，7s
npm run test:quick                             # 提交前默认，27s
npm run test:react                             # 组件与页面，120s
npm run test:react-deep                        # 重型（不含在 test:full）
npm run test:panel business                    # 某区域
npm run test:changed                           # 按 git 变更选区域
npm test -- tests/frontend/unit/shared/money.test.ts   # 单文件（vitest 直通）
```

`vitest.config.ts` 的 `root` 是**仓库根**，所以单文件过滤路径要写仓库根相对路径。

## 4. 新加一个测试放哪

1. 先定层：需要渲染 → `module/`；不需要 → `unit/`。
2. 再定区域：被测源码在 `src/<domain>/` → 查 `frontend/scripts/test-changed.mjs` 的
   `SRC_DOMAIN_TO_REGION`，没登记就先去登记（否则改动会被判成"未落在业务板块内"）。
3. 文件名唯一：`<组件>.<关注点>.test.tsx`；同名冲突不要靠目录区分（目录已按区域压平）。
4. 更新 `tests/manifest.json` 的 `files / layers / byArea`，否则 `manifest-parity` 红。

## 5. 历史

2026-11-04 之前测试在 `frontend/src/`（与被测组件同层）与 `frontend/tests/`（纯逻辑）。
搬出包外的两个前置条件是本轮才补上的：仓库根有 `node_modules`（npm workspaces + hoisted），
且 `vitest.config.ts` 把 `root` 设为仓库根、`server.fs.allow` 放开到仓库根。缺任一条件，
包外测试会以 `/@fs/... Cannot find module` 或 `Failed to resolve import "axios"` 失败。
