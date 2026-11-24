# 测试资产索引

目录结构以当前仓库和 `tests/manifest.json` 为准。

本文件回答四个问题：**测试在哪、怎么跑、新测试放哪、怎么判断一个测试有没有价值**。

测试步骤见 [测试流程](../docs/测试流程.md)，数据库配置与分层规则以 [测试规范](../docs/testing/测试规范.md) 为准；上线及阿里云部署见 [发布流程](../docs/发布流程.md)。

> 2026-11-04 已完成整体搬迁：后端、前端、E2E 三端的测试**全部**在仓库根 `tests/` 下，
> 包内不再有测试文件。这是本轮重构的验收项之一——`tests/frontend/unit/system/manifest-parity.test.ts`
> 会扫描 `frontend/src` 与 `frontend/tests`，一旦有残留直接红。

## 1. 目录结构

```text
tests/
├── README.md                     本文件（唯一入口说明）
├── manifest.json                 三端「应该收到多少」的唯一事实源（只存数量，不存文件名）
├── backend/                      pytest
│   ├── conftest.py               11 个共享夹具 + 测试库硬校验 + db 标记派生（唯一一份）
│   ├── _repo.py                  仓库根定位（禁写 parents[N]，层数一变就错）
│   ├── unit/<区域>/              不连库的纯逻辑与静态守卫
│   ├── integration/<区域>/       连真实 PG 的接口与服务测试
│   └── _report/                  生成物（case_index.json 等），gitignore
├── frontend/                     vitest（root = 仓库根）
│   ├── unit/<区域>/              不挂载 React 的纯逻辑
│   └── module/<区域>/            组件与页面测试（含 .deep 重型测试）
├── e2e/                          Playwright
│   ├── <区域>/*.spec.ts          按功能分布；cross/ 集中放跨页面与端到端业务流程
│   └── support/api-stub.ts       规格共用夹具
├── fixtures/                     测试基建：render/mock-api/桩/种子数据（`@fixtures` 别名）
└── config/                       setup.ts、mock-specifier 基线
```

**区域目录名按业务板块统一**：`system`（系统级兜底）/ `workbench`（工作台）/ `business`（业务中心）
/ `customers`（客户中心）/ `finance`（资金中心）/ `operations`（经营中心）/ `settings`（设置）
/ `shared`（跨区域公共层）。功能编号仍用字母前缀（A..F / SYS），映射收敛在
`manifest.json` 的 `regionByCode`，不在代码里各写一份。认证和审计测试按代码放入
`settings`，但继续保留 `SYS01` / `SYS05` 功能编号。

**目录约定**：测试先按 `<层>/<区域>/` 归属，再按需要建立业务子模块目录，例如 `business/orders/`、`business/inventory/`、`operations/reports/` 和 `settings/lists/`；跨功能用例归入相应的 `shared/` 或区域根目录。区域轴用来定位失败范围（改资金中心就只跑
`finance/`），分层轴用来定位执行成本（纯逻辑 vs 要 jsdom vs 要真实 PG）。两轴正交，
任一轴写进另一轴都会让另一轴失效。

**前端为什么能搬出包外**（此前结论是"搬不了"，已作废）：仓库根现在是 npm workspaces
包根（根 `package.json` + 根 `package-lock.json` + 根 `node_modules`），vitest 的
`root` 改成仓库根、`server.fs.allow` 放开到仓库根。三条对照实验确认了必要条件：
删掉根 `node_modules` 立刻 `Cannot find module`，配置文件挪出包外立刻
`@vitejs/plugin-react` 解析失败。

搬迁会改变 nodeid，而 `results.jsonl` 的历史记录靠 nodeid 关联用例编号：写入时
`case_no` 已解析的记录搬完仍能归位，只有 `case_no` 为空的老记录要靠 nodeid 反查
（`make_test_report.py` 的 `load_node_index`）。**实测 1091 条历史前端用例编号零漂移**
（`case_number_map.json` 的键是 `层级|功能编号|文件名|函数名`，文件名搬家不变）。

## 2. 三根轴，各管一件事

文件放哪里、属于哪个板块、保护哪条承诺，是三件不同的事，**不允许任何一根轴兼任另一根**。

**回归不是独立的测试类别**：修复缺陷后，仍有长期保护价值的断言并入对应功能测试；若只是重复覆盖、依赖已删除行为或没有明确业务承诺，则删除。不要按修复批次长期保留独立的“回归测试桶”。

| 轴 | 载体 | 回答 |
|---|---|---|
| 怎么跑 | `db` marker（**由夹具依赖派生**）+ 功能分组 | 这次改动该跑哪些、要多久 |
| 属于哪个板块 | 功能分组 + 文件名前缀 | 改这个板块对应哪些测试 |
| 保护什么 | **文件头承诺 ID** + `docs/testing/测试元数据台账.csv`（`PROMISE`） | 前后端是否对得上、哪条承诺无人守 |

承诺轴独立于路径，所以搬目录、改文件名都不会影响功能归属。解析与校验见
`backend/scripts/promise_catalog.py` 与 `tests/backend/test_promise_declaration.py`。

## 3. 怎么加一个测试（四步，缺一即游离）

1. **进分组**：在 `backend/run_regression.py` 的 `GROUPS` 里登记（否则 `all` / `ci` / `changed` 都不会跑它）。
2. **声明承诺**：文件 docstring 第一段写上承诺 ID，如 `"""REVERSAL-01 冲销必须成对…"""`。
   新承诺先写进 `docs/testing/测试元数据台账.csv`，`记录类型` 填 `PROMISE`，注明层级、负责端、失效后果、验证证据。
3. **标类型**：`pytestmark = [pytest.mark.unit]` 或 `integration`，与目录归属保持一致。
4. **跑完再交**：只跑直接相关文件，不跑全量（见第 5 节）。

第 1 步与第 2 步都有守卫，且都属 `unit` 组（毫秒级，不连库）：

- 第 1 步 → `test_group_coverage.py`：磁盘上每个 `test_*.py` 必须在 `GROUPS` 里，漏登记直接红并点名文件；
  反向也查死条目（白名单指向已改名/删除的文件）与路径前缀（必须是 `tests/backend/`）。
- 第 2 步 → `test_promise_declaration.py`：无归属文件、超基线的新增未登记声明、清单证据指向不存在的文件，均报错。

## 4. 业务承诺（PROMISE 记录）

`docs/testing/测试元数据台账.csv` 的 `PROMISE` 记录是「什么绝对不能错」的单一事实源，按失效后果分层；条数与覆盖状态以台账实时内容为准，不在本文写时点数字。后端测试文件必须全部自带已登记承诺码。

| 层级 | 含义 | 典型 |
|---|---|---|
| L0 | 钱错、不可逆 | 金额精度、余额=流水和、冲销成对、押金不为负 |
| L1 | 事实被污染 | 编号唯一、不得重复入库、非法状态拒绝、事件只追加 |
| L2 | 可追责、有补救 | 越权 403、敏感字段权限范围、审计留痕 |
| L3 | 可改可回滚 | 标签、列序、配色（抽样与快照即可，允许漏） |

`覆盖状态` 三态：`已覆盖`（有测试）、`待核`（有测试但断言强度未逐条核对）、`缺失（写明原因）`。
**`待核` 不等于已守住**，它只表示证据来自文件名或关键词，尚未验证断言本身。

`IDEMPOTENCY-01` 的后端验收覆盖手工流水、订单关联流水和订单事件。测试断言同键重试返回同一结果、只写一次流水，同键改内容返回冲突，失败回滚后可用原键重试。

## 5. 执行入口

### 后端

```text
cd backend
.venv/bin/python3 run_regression.py smoke        # 提交前（契约 + 编号 + 状态机 + 金额守卫）
.venv/bin/python3 run_regression.py unit         # 秒级
.venv/bin/python3 run_regression.py changed      # 按 git 变更反查分组
.venv/bin/python3 run_regression.py <域>         # orders / finance / parties / …
.venv/bin/python3 run_regression.py all          # 全量（发版前）
.venv/bin/python3 run_regression.py ci          # 后端全量回归
.venv/bin/python3 run_regression.py lint         # pyflakes，只拦净增
.venv/bin/python3 scripts/promise_catalog.py     # 承诺覆盖报告
.venv/bin/python3 scripts/trim_test_results.py   # 裁剪执行历史（先 --dry-run 看计划）
```

#### 执行通道：`db` 标记由夹具依赖派生，不由目录声明

按「是否连库」分两条通道：

```text
../scripts/ops/test-local.sh ../tests/backend -m "not db"  # 快通道
../scripts/ops/test-local.sh ../tests/backend -m db        # 数据库通道，运行时临时库
```

标记不是人写的，也不是目录名，而是**从夹具依赖派生**：全仓唯一创建引擎的夹具是 `v1_engine`，
pytest 已把传递依赖展开进 `item.fixturenames`，`conftest.py` 的 `pytest_collection_modifyitems`
据此自动加标。搬文件、改文件名、换目录都绕不过它。

不走 `v1_engine`、自己在用例里 `create_engine` 并 `.connect()` 的文件（当前两个：
`test_migration.py`、`test_numbering.py`）派生机制看不见，必须在模块级写
`pytestmark = pytest.mark.db`，并在 `test_db_channel.py` 的 `DECLARED_DB_FILES` 登记。

守卫 `test_db_channel.py`（4 条断言，0.08s，在 `unit` 组）守四件事：派生统计仍在写、
`v1_engine` 夹具没被改名、自建连接的文件必须显式声明、手工标记必须逐个登记。

**为什么不用目录。** 目录是一种声明，代码一变就过期，而且没有任何机制会发现它过期——
今天不需要库的用例，明天加一行 DB 断言，目录名不会改，人也不会检查。派生值读的是运行期
真实依赖，天然不会说谎。曾建过 `backend/unit/`、`backend/integration/` 两个空壳，已删除。

这条判据不是推的，是测出来的：把 `DATABASE_URL` / `TEST_DATABASE_URL` 指向不可达端口后跑
`-m "not db"`，最初 **12 错误 + 1 失败**（`test_migration.py` 自建临时库、`test_numbering.py`
并发取号自建探针库，都没走 `v1_engine`），补齐声明后 **313 通过**，只剩 3 条 `test_settings`
的配置断言失败——它们断言 URL 字符串本身，不连库，属实验扰动。

### 前端

```text
cd frontend
npm run test:fast            # 纯逻辑 + 静态守卫：14 文件 / 96 例 / 8.4s
npm run test:quick           # 提交前默认：8 文件 / 88 例 / 23.3s
npm run test:react           # 组件与页面：56 文件 / 756 例 / 116.6s
npm run test:react-deep      # 重型交互（不含在 test:full 里）：16 文件 / 124 例 / 37.3s
npm run test:full            # fast + quick + react，轻量层并发、重层串行，约 145s
npm run test:full:all        # 再加 react-deep（发版前），约 182s
npm run test:panel business  # 只跑某区域：tests/frontend/<unit|module>/business
npm run test:changed         # 按 git 变更自动选区域（改 src/orders → business）
npm run test:e2e             # Playwright + 真实后端 + 每轮独立临时库
```

CI（`frontend-gate`）默认按变更选测：`workflow_dispatch` 传 `full_suite=true` → `test:ci` 全量（发版收口）；
本次提交有前端/测试变更 → `test:changed`（命中公共层或分层配置时运行完整前端测试）；
无前端/测试变更 → `test:quick` 冒烟，不静默跳过。E2E 规格变更会运行相应浏览器测试，E2E 共享配置变更运行完整浏览器测试。变更路径由 workflow 算 commit diff 后经
`TEST_CHANGED_PATHS` 注入（CI checkout 后 `git status` 恒为空）。

后端 CI（`backend-gate`）同样默认按 `main-ci-cd` 注入的「原始 push 范围」路径集选测：
`workflow_dispatch` 传 `full_suite=true` → `ci` 全量（发版收口/里程碑）；
命中核心、共享、配置、测试基建或跨模块取数路径，以及 `backend/` 下无法归入业务域的改动
→ 自动降级全量；其余按业务域选组，且每轮固定附 `smoke` + `unit` 秒级资产守卫
（分组覆盖 / 承诺归属 / 清单一致性）；无后端业务变更 → 只跑 `smoke` + `unit`，不静默跳过。
PR 与手动 dispatch 未带路径集仍走原分层策略。命令形态：
`run_regression.py changed --backend-only --changed-paths <逗号分隔路径>`，
不传 `--changed-paths` 时回退本地 `git status --short`。

三层与四档的关系：`fast`/`quick`/`react`/`react-deep` 是**跑法**（执行成本档），
`unit`/`module` 与区域是**归属**（文件放哪）。`test-layers.mjs` 只登记前者的文件清单，
归属永远扫磁盘——两套清单必然漂移，这是 2026-10-27 已经付过学费的坑。

#### 耗时账（2026-11-04 实测，8 核 macOS；数字会随机器变，结论看比例）

整轮 `test:full:all`：**185.5s → 181.9s**。单看比例不大，因为耗时结构本身就长这样：

| 层 | 串行实测 | 说明 |
|---|---|---|
| fast | 8.4s / 14 文件 | 纯逻辑 + 守卫，无 jsdom 重渲染 |
| quick | 23.3s / 8 文件 | 其中 `CreateBusinessModal` **14.8s**，单个重文件就是本层下界 |
| react | 116.6s / 56 文件 / 756 例 | 4 worker（核数 / 2） |
| react-deep | 37.3s / 16 文件 / 124 例 | 2 worker（核数 / 4），4 worker 32.7s、1 worker 45.8s |

**react 层的 116.6s 花在哪**（`vitest --reporter=verbose` 自报占比）：
tests 50% / import 26% / transform 14% / environment 7% / setup 2%。
即**只有一半是真在跑用例**，另一半是每个文件各自重建 jsdom 与模块图的固定成本。

**并行效率为什么只有 1.4×**：同一份 react 层，单 worker **163.5s**（三次实测
164.74 / 160.84 / 164.92），4 worker **116.6s**，8 worker **120.9s**（更差）。
固定成本 ≈ 1.3s/文件（jsdom 环境 + antd 模块图求值），56 文件 ≈ 73s，这部分**只能靠
`isolate:false` 消掉，而它已验证不可用**（见下）。用例体本身 ≈ 90s，4 worker 摊下来
14.5s/worker，却要等固定成本排队——所以加 worker 到 8 反而回退。

**一条测量纪律**：并发跑出来的「单例耗时」不可用于优化决策。同一批 4 个慢文件，
8 核 4 worker 下自报 79.5s，单 worker 实测只有 **31.3s**——膨胀 2.5×，是 CPU 抢占
计入用例时长。判断某条用例慢不慢，必须 `--maxWorkers=1` 单跑。

**采纳的优化**（每条都有前后对照）：

| 优化 | 前后 | 收益 |
|---|---|---|
| quick 层 `forks` → `threads` | 27.20s → 19.28s | -29%，8 个文件各自起进程的冷启动成本占大头 |
| react-deep 1 → 2 worker | 45.77s → 34.08s | -26%；4 worker 32.65s 边际已很小，取 2 以适应 CI |
| worker 数按核推导（不写死 4） | — | 本地 8 核 → 4/2，CI 4 vCPU → 2/2，避免超订 |
| fast 与 quick 并发（`test:full` 内） | 31.7s → 27.7s | -13%，仅核数 ≥6 时启用，4 vCPU 以下回落串行并保持日志不交错 |
| 五层 4 worker 上限 | — | 实测 4 = 116.6s、6 = 110.8s、8 = 120.9s，取核数/2 |

**已否决的方案**（勿再试，均实测）：

| 方案 | 结果 |
|---|---|
| `isolate: false` 复用模块图 | **99 条失败**：跨文件 mock/模块状态串扰，`resetAllMocks` + 清 body 都兜不住。这是省掉 1.3s/文件固定成本的唯一途径，代价太大，放弃 |
| `userEvent.setup({ delay: null })` 全库 130 处 | 116.5s → 114.1s（-2%，噪声级），且 `InstallmentsPanel` **3 条红**（依赖事件间让出微任务）。收益不抵风险 |
| react 改 `pool: forks` | 116.48s vs threads 116.6s，打平，无理由改 |
| react + react-deep 并发 | 148.3s vs 串行 153.9s（-3.6%），且 deep 出现 1 条 60s 超时。重层并发会互相抢 CPU |
| fast + quick + deep 三者并发 | 64.4s vs 串行 69.0s，但 deep 被拖慢 37.3s→~60s，不稳定 |
| 全外部化 antd（关 `deps.inline`） | cssinjs 桩失效，丢掉 5× 提速来源，交互用例确定性失败 |
| `theme.token.motion=false` 替代 rc-motion 桩 | 功能可行但更慢（78.85s → 94~100s） |

**结构性结论**：react 层已是「56 个文件各自重建环境」的成本主导，用例体只占一半；
在不牺牲 `isolate` 的前提下，把单个用例再抠 10~20ms 对整轮毫无意义。要再上一个台阶，
唯一的杠杆是减少单文件渲染量（不是减少用例）——目前没有安全做法，故止步于此。

#### 前端测试的模块定位：一律用 `@/` 与 `@fixtures/`

`@` 指向 `frontend/src`（被测源码），`@fixtures` 指向 `tests/fixtures`（测试基建）。
在 `vitest.config.ts`、`vite.config.ts`、`tsconfig.json` 三处必须同步。测试里的
`import` 与 `vi.mock` 都写别名，不写 `./` `../`：

```ts
vi.mock("@/shared/api/client", () => ({ api: mocks }));      // 对
vi.mock("../shared/api/client", () => ({ api: mocks }));     // 错
import { renderLight } from "@fixtures/render";              // 对
```

相对路径的危险不是「解析失败」（那会显式报错），而是**搬家后仍解析到某个存在的文件**：
mock 注册了却没命中被测模块，测试改用真实现照常通过，保护静默消失。守卫
`unit/system/mock-specifier.test.ts` 把它变成提交时的显式失败。**2026-11-04 搬迁时存量
74 处已全部清零**，基线文件保留但为空：此后新增一条相对路径即红，没有冻结豁免。

本轮搬迁正是靠这条守卫抓到两个真缺陷：`OrdersPage.actions.test.tsx` 里
`vi.mock("../../stocks/InventoryPanel")` 从 `src/orders/` 解析到根本不存在的
`frontend/stocks/`，mock 从未生效，测试一直在渲染真面板——而它的断言恰恰依赖真面板
（切到「分期与回款」会真发请求）。修正说明符后立刻红了，说明「修 mock ≠ 修意图」，
最终删掉这两行死 mock 并注明原因。

### 环境约束

- 后端测试只认 `TEST_DATABASE_URL`，**刻意不回落 `DATABASE_URL`**；库名必须含 `test`，
  且命中 `release`/`prod` 等黑名单或与 `DATABASE_URL` 同库时直接 abort（夹具会 TRUNCATE 全表）。
- 本机 `scripts/ops/test-local.sh` 和 `run_regression.py` 每轮创建独立测试库，退出后回收；
  测试库地址必须是本机 PostgreSQL，且不得与开发库相同。
- E2E 必须用 `npm run test:e2e` 启动：每轮创建独立临时库，成功后回收；失败或中断时保留，
  至少 24 小时后在下次 E2E 启动时回收无连接的过期库。不会清理未标记的库。

## 6. 当前已知缺口

| 项 | 状态 |
|---|---|
| ~~13 个后端测试文件未进任何分组~~ | **已解决**：全部登记，`test_group_coverage.py` 拦截复发 |
| ~~33 个文件头写的功能码尚未登记进承诺清单~~ | **已解决**：112/112 全部自带承诺码，历史回退机制已封存 |
| ~~后端测试扁平存放，没有分层~~ | **已解决**：`unit/integration` × 区域两层（2026-11-04），`test_manifest_parity.py` 守着分布 |
| ~~前端测试散在包内 `src/` 与 `frontend/tests/`~~ | **已解决**：当前前端测试文件全部迁入 `tests/frontend/{unit,module}/<区域>/`；包内扫描为空的断言在 `manifest-parity.test.ts` |
| ~~`vi.mock` 用相对路径，测试文件搬迁后静默失效~~ | **已解决**：`@`/`@fixtures` 别名 + `mock-specifier.test.ts`，74 处存量已清零（基线为空） |
| ~~E2E 规格散在包内 `frontend/e2e/`~~ | **已解决**：规格统一迁入 `tests/e2e/<区域>/`，快照目录随 `visual.spec.ts` 走 |
| ~~前端测试只能整层跑，改一个板块要跑全部~~ | **已解决**：`test:panel <区域>` 与 `test:changed`（按 git 变更推断区域） |
| `results.jsonl` 只增不减，日增约 14 MB | **已解决**：`scripts/trim_test_results.py` 覆盖保持式裁剪，14.61 MB / 102 run → **3.82 MB / 24 run**，被裁行归档进 `测试结果库/archive/`（gitignore）。裁剪后报告「未执行 0 / FAIL 0」与裁剪前逐项一致 |
| 后端 `integration` 与 `unit` 的判定仍是「文件内 db 用例多数派」 | **已知取舍**：35 个混层文件（31%），极端如 `test_orders_contract.py` 105 集成 + 1 单元被整体归入 integration。代价是 57 条快用例跟进集成通道；未拆文件，因为拆文件会改 nodeid 与用例编号 |
| 前端功能映射中的文件路径逐文件二次核对 | **低优先**：映射初版部分路径为探索推断，非阻断 |
| CI schema 一致性校验（`create_all` vs Alembic） | **低优先**：尚未接入门禁；结构性变更按当期执行单在 ECS 现场比对 |
| 用例「合格标准」标为待确认（约 2200 条） | **已知取舍**：用例缺 docstring 预期句，按「业务规则不明确」标记，非阻断 |

> 测试体系（分层架构、模块编号 A–F + SYS、用例库、执行记录 / 报告链、CI 门禁）已建成；上表为仅存的非阻断未决项，过程留痕见 git 历史。

## 7. 子目录约定

### 7.1 `frontend/`（vitest）

本目录是前端测试的唯一根，`frontend/src/**` 下不再放测试文件。

| 层 | 判据 | 目录 |
|---|---|---|
| `unit/<区域>/` | 不需要 DOM：纯函数、请求构造、静态守卫 | `tests/frontend/unit/` |
| `module/<区域>/` | 需要挂载组件渲染与交互（jsdom + antd） | `tests/frontend/module/` |

判据是**被测代码是否需要 DOM**，不是文件名。放错不会报错，只会让快通道变慢或把纯逻辑挤进 jsdom 浪费一个数量级时间。

**模块定位只用别名**：`@` → `frontend/src`，`@fixtures` → `tests/fixtures`；禁止 `./` `../`——相对路径搬目录后可能解析到另一个存在的文件，mock 不报错却没命中被测模块，测试改用真实现照常通过，保护静默消失。守卫是 `unit/system/mock-specifier.test.ts`。`vitest.config.ts` 的 `root` 是仓库根，单文件过滤路径要写仓库根相对路径。

新增测试四步：定层 → 定区域（查 `frontend/scripts/test-changed.mjs` 的 `SRC_DOMAIN_TO_REGION`，未登记先登记）→ 文件名 `<组件>.<关注点>.test.tsx` 唯一 → 更新 `tests/manifest.json` 的 `files / layers / byArea`，否则 `manifest-parity` 红。

### 7.2 `e2e/`（Playwright）

**职责边界**：只验证跨层集成后才暴露的用户可见承诺（弹窗是否真的关掉、深链是否落到正确页面、写操作后界面是否真的变化）。jsdom 能测的（纯逻辑、单组件渲染）不在这里重复——组件测试里 `onClose` 是 `vi.fn()`，父组件不会真的把 `open` 置 false，antd Modal 关闭后 DOM 也不移除，所以「点了关闭按钮」在单测里全绿、真实浏览器里弹窗关不掉。凡「点了之后界面是否真的消失 / 退回」的断言只能放这里，且必须断言**界面结果**而非「回调被调用」。

**环境**：`npm run test:e2e` 每次创建独立临时 E2E 库，初始化表和测试数据；成功后删除，失败或中断后保留至少 24 小时，下次 E2E 启动时清理过期且没有连接的已标记库。**绝不触碰** `heijin_erp_dev` / `heijin_erp_test` / ECS 生产库 `heijin_erp`。E2E 按需本地运行。

**快照**：`visual.spec.ts-snapshots/` 必须与 spec 同目录整目录搬迁，快照按 spec 路径定位，spec 动而快照留原地会导致 `visual.spec.ts` 全部失败。

**承诺对齐**：新增 spec 时在文件头声明承诺 ID，并在 `docs/testing/测试元数据台账.csv` 更新对应 `PROMISE` 记录的 E2E 证据。

### 7.3 `fixtures/`

`v1_acceptance_seed.json` 是 A01–A11 的**假数据**，不含生产客户资料或真实金额：

- 每个测试运行前导入独立临时数据库；不得导入开发或生产数据库。
- `expected` 是验收断言，不是业务服务直接写入的汇总字段。
- 测试必须通过业务 API/Service 创建订单、事件和现金流，不能直接更新余额或订单状态。
- 完整场景与断言以 `docs/testing/测试用例库.csv` 及 `tests/` 下对应测试文件为准。

`account-image-test-20261101.png` 是仅用于图片上传 / 预览 / 保存 / 详情回显验证的合成测试图片（图内已标注「测试图片 TEST」），仅限 dev / 测试环境，不得上传生产或作为真实账号资料；优先验证「添加图片 → 预览 → 保存 → 详情回显 → 再次编辑」完整链路。

## 8. FE 手工用例 ↔ 自动化映射

`FE-001 ~ FE-240` 是前端手工用例锚点（`docs/前端测试用例库.md`），**不得废弃**。下表按业务范围登记自动化归属；「已有关联自动化」只表示对应模块已有测试，**不代表逐用例覆盖，也不代表当前通过**。各资产的执行入口见第 5 节，生成物登记见 `docs/README.md` 3.2；`docs/archive/ux-audit/` 被 E2E 用例与 `ux-audit.mjs` 直接读取，**不可删**。

| 用例范围 | 业务范围 | Vitest 归属（`tests/frontend/module/`） | Playwright 归属（`tests/e2e/`） | 覆盖判断 |
|---|---|---|---|---|
| FE-001 ~ FE-007 | 登录态、导航、首次加载、空态、弹窗基础行为 | `workbench/`、`shared/`、`system/` | `system/smoke.spec.ts`、`system/navigation-leaves.spec.ts`、`system/fallback.spec.ts`、`system/visual.spec.ts` | 模块自动化已有；异常路径仍以手工为主 |
| FE-008 ~ FE-024 | 回收/提号/代挂建单、字段校验、费用、图片、库存 | `business/`、`shared/` | `cross/business-write.spec.ts`、`cross/integration.spec.ts` | 建单主路径已有；下拉、图片、重复提交需补逐用例关联 |
| FE-025 ~ FE-037 | 售出、分期、寄售、返点、取消和重复操作 | `business/`、`finance/` | `cross/business-write.spec.ts`、`cross/finance-write-ui.spec.ts`、`cross/integration.spec.ts` | 业务模块已有；终态与跨页面一致性需补专项功能用例 |
| FE-038 ~ FE-047 | 客户、合作方、用户、团队、密码和权限 | `customers/`、`settings/`、`system/` | `cross/crud.spec.ts`、`system/auth-login.spec.ts`、`system/role-switch.spec.ts` | 主路径已有；格式校验、重复编码和异常反馈需补关联 |
| FE-048 ~ FE-056 | 资金划转、冲销、报表、导出和审计 | `finance/`、`operations/`、`system/` | `cross/finance-write-ui.spec.ts`、`finance/other-integration.spec.ts`、`cross/integration.spec.ts` | 模块自动化已有；导出反馈和报表口径需补专项场景 |
| FE-057 ~ FE-073 | 自定义字段、列配置、游戏渠道、资金池、导入、视觉 | `settings/`、`operations/`、`workbench/` | `system/visual.spec.ts`、`cross/integration.spec.ts` | 配置与视觉已有；导入异常和下拉完整性需补逐用例关联 |
| FE-074 ~ FE-140 | 终态动作、附件、质量、需求、资金和权限扩展场景 | `business/`、`customers/`、`operations/`、`finance/`、`settings/` | `cross/crud.spec.ts`、`cross/finance-write-ui.spec.ts`、`finance/other-integration.spec.ts` | 组件级覆盖较多；组合流程与异常恢复以手工为主 |
| FE-141 ~ FE-240 | 跨页面一致性、可访问性、超时、错误态、下拉和保存保护 | 各业务区域的 `.deep.test.tsx` / `.actions.test.tsx` / `.write.test.tsx` | `system/fallback.spec.ts`、`cross/integration.spec.ts`、`cross/upgrade-integration.spec.ts`、`system/visual.spec.ts` | 主要来自手工探索发现，自动化映射与稳定复现仍不足 |

### 8.1 补映射规则

新增或补齐自动化时，在手工用例表格中增加「自动化路径」字段，格式统一为：

```text
Vitest: tests/frontend/module/business/shared/CreateBusinessModal.test.tsx
或
Playwright: tests/e2e/cross/business-write.spec.ts
```

同一条 FE 用例可以关联多个自动化文件，但不能把「同模块已有测试」直接当作该用例已覆盖。优先补：

1. 当前失败且涉及数据正确性的用例。
2. 重复提交、超时、刷新、重试和结果未知场景。
3. 下拉选项完整性和字段联动。
4. 弹窗关闭、错误清理和保存反馈。
5. 报表导出、敏感字段和跨页面状态一致性。

### 8.2 结果归档与当前结论

- 运行日志、覆盖率、Playwright HTML 报告和临时截图不入库，走 `.gitignore` 产物规则。
- 可复用假数据、图片与导入样本放 `tests/fixtures/`；`.env.*-test`、数据库备份及含密钥或业务数据的文件不得提交。
- 可复现的测试结论与缺陷证据放 `docs/` 现役文档；过期的 `测试报告_YYYYMMDD.*` 由生成器移入 `docs/testing/报告归档/`（不入库），不得用历史报告替代当前结果。

前端自动化已覆盖主要模块，但与 240 条手工用例还不是一对一关系。修复一个问题时补一条自动化关联，避免只增加手工用例数量而不增加可重复的自动化保护。

## 9. 维护规则

- 本文件是测试资产的唯一索引；新增测试目录或执行入口时同步更新第 1、5、7 节；`FE-*` 用例与自动化的映射见第 8 节。
- 手工用例在 `docs/前端测试用例库.md`，自动生成的用例库与报告在 `docs/testing/`；UX 审计证据在 `docs/archive/ux-audit/`，不作为现行通过依据。
- Fixture 不得包含真实账号、密码、手机号、客户资料或生产数据。
- 视觉快照失败先确认是否为预期产品变更，**不得直接按实际图覆盖快照**；拖拽、loading 与退出反馈类失败要复核事件命中与样式清理，**不得靠放宽断言超时掩盖**。
