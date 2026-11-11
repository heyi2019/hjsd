# 测试资产索引

更新时间：2026-11-04（测试体系整体重构完成）

本文件回答四个问题：**测试在哪、怎么跑、新测试放哪、怎么判断一个测试有没有价值**。

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
│   ├── unit/<区域>/              不连库的纯逻辑与静态守卫（32 文件 / 297 例）
│   ├── integration/<区域>/       连真实 PG 的接口与服务测试（82 文件 / 1387 例）
│   └── _report/                  生成物（case_index.json 等），gitignore
├── frontend/                     vitest（root = 仓库根）
│   ├── unit/<区域>/              不挂载 React 的纯逻辑（24 文件）
│   └── module/<区域>/            组件与页面测试（70 文件，含 16 个 .deep 重型）
├── e2e/                          Playwright
│   ├── <区域>/*.spec.ts          按区域分布；cross/ 是跨区域串联
│   └── support/api-stub.ts       规格共用夹具
├── fixtures/                     测试基建：render/mock-api/桩/种子数据（`@fixtures` 别名）
├── config/                       setup.ts、mock-specifier 基线
├── manifests/                    用例 ↔ 文件映射表（人写）
└── results/                      执行基线记录（人写）
```

**区域目录名 = 一级导航名**：`system`（系统级兜底）/ `workbench`（工作台）/ `business`（业务中心）
/ `customer`（客户中心）/ `finance`（资金中心）/ `operations`（经营中心）/ `settings`（设置）
/ `shared`（跨区域公共层）。功能编号仍用字母前缀（A..F / SYS），映射收敛在
`manifest.json` 的 `regionByCode`，不在代码里各写一份。

**为什么三端都按 `<层>/<区域>/` 分两层**：区域轴用来定位失败范围（改资金中心就只跑
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

| 轴 | 载体 | 回答 |
|---|---|---|
| 怎么跑 | `db` marker（**由夹具依赖派生**）+ `GROUPS` | 这次改动该跑哪些、要多久 |
| 属于哪个板块 | `run_regression.py` 的 `GROUPS` + 文件名前缀 | 改这个板块要回归什么 |
| 保护什么 | **文件头承诺 ID** + `docs/testing/承诺清单.csv` | 前后端是否对得上、哪条承诺无人守 |

承诺轴独立于路径，所以搬目录、改文件名都不会影响功能归属。解析与校验见
`backend/scripts/promise_catalog.py` 与 `tests/backend/test_promise_declaration.py`。

## 3. 怎么加一个测试（四步，缺一即游离）

1. **进分组**：在 `backend/run_regression.py` 的 `GROUPS` 里登记（否则 `all` / `ci` / `changed` 都不会跑它）。
2. **声明承诺**：文件 docstring 第一段写上承诺 ID，如 `"""REVERSAL-01 冲销必须成对…"""`。
   新承诺先写进 `docs/testing/承诺清单.csv`，注明层级、负责端、失效后果、验证证据。
3. **标类型**：`pytestmark = [pytest.mark.unit]` 或 `integration`，与目录归属保持一致。
4. **跑完再交**：只跑直接相关文件，不跑全量（见第 5 节）。

第 1 步与第 2 步都有守卫，且都属 `unit` 组（毫秒级，不连库）：

- 第 1 步 → `test_group_coverage.py`：磁盘上每个 `test_*.py` 必须在 `GROUPS` 里，漏登记直接红并点名文件；
  反向也查死条目（白名单指向已改名/删除的文件）与路径前缀（必须是 `tests/backend/`）。
- 第 2 步 → `test_promise_declaration.py`：无归属文件、超基线的新增未登记声明、清单证据指向不存在的文件，均报错。

## 4. 承诺清单（新引入）

`docs/testing/承诺清单.csv` 是「什么绝对不能错」的单一事实源，按失效后果分层：

当前 **48 条**（L0 12 / L1 20 / L2 14 / L3 2），112 个后端测试文件全部自带已登记承诺码。

| 层级 | 含义 | 典型 |
|---|---|---|
| L0 | 钱错、不可逆 | 金额精度、余额=流水和、冲销成对、押金不为负 |
| L1 | 事实被污染 | 编号唯一、不得重复入库、非法状态拒绝、事件只追加 |
| L2 | 可追责、有补救 | 越权 403、脱敏、审计留痕 |
| L3 | 可改可回滚 | 标签、列序、配色（抽样与快照即可，允许漏） |

`覆盖状态` 三态：`已覆盖`（有测试）、`待核`（有测试但断言强度未逐条核对）、`缺失（写明原因）`。
**`待核` 不等于已守住**，它只表示证据来自文件名或关键词，尚未验证断言本身。

当前 L0 状态：12 条中 1 条缺失（`IDEMPOTENCY-01` 重复提交不产生第二笔流水——现有测试
`test_finance_idempotency_service.py` 断言的是「缺陷会发生」，不是守卫）、3 条待核。

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
.venv/bin/python3 -m pytest ../tests/backend -m "not db"   # 快通道：不连 PostgreSQL，当前 316 例
.venv/bin/python3 -m pytest ../tests/backend -m db         # 连库通道：当前 1360 例
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
npm run test:e2e             # Playwright + 真实后端 + 独立库 heijin_erp_e2e（15 spec / 62 例）
```

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
- E2E 用 `heijin_erp_e2e`，常驻复用、每轮不清数据（`e2e_db.py` 默认 keep 分支补表 + 幂等播种，
  夹具按类型补足 `IN_STOCK` 账号供重复跑测；CI 全新空库由 keep 分支建表初始化），
  绝不触碰 dev/test/release。

## 6. 当前已知缺口

| 项 | 状态 |
|---|---|
| ~~13 个后端测试文件未进任何分组~~ | **已解决**：全部登记，`test_group_coverage.py` 拦截复发 |
| ~~33 个文件头写的功能码尚未登记进承诺清单~~ | **已解决**：112/112 全部自带承诺码，历史回退机制已封存 |
| ~~后端测试扁平存放，没有分层~~ | **已解决**：`unit/integration` × 区域两层（2026-11-04），`test_manifest_parity.py` 守着分布 |
| ~~前端测试散在包内 `src/` 与 `frontend/tests/`~~ | **已解决**：94 个文件全部迁入 `tests/frontend/{unit,module}/<区域>/`；包内扫描为空的断言在 `manifest-parity.test.ts` |
| ~~`vi.mock` 用相对路径，测试文件搬迁后静默失效~~ | **已解决**：`@`/`@fixtures` 别名 + `mock-specifier.test.ts`，74 处存量已清零（基线为空） |
| ~~E2E 规格散在包内 `frontend/e2e/`~~ | **已解决**：15 个 spec 迁入 `tests/e2e/<区域>/`，快照目录随 `visual.spec.ts` 走 |
| ~~前端测试只能整层跑，改一个板块要跑全部~~ | **已解决**：`test:panel <区域>` 与 `test:changed`（按 git 变更推断区域） |
| `results.jsonl` 只增不减，日增约 14 MB | **已解决**：`scripts/trim_test_results.py` 覆盖保持式裁剪，14.61 MB / 102 run → **3.82 MB / 24 run**，被裁行归档进 `测试结果库/archive/`（gitignore）。裁剪后报告「未执行 0 / FAIL 0」与裁剪前逐项一致 |
| 后端 `integration` 与 `unit` 的判定仍是「文件内 db 用例多数派」 | **已知取舍**：35 个混层文件（31%），极端如 `test_orders_contract.py` 105 集成 + 1 单元被整体归入 integration。代价是 57 条快用例跟进集成通道；未拆文件，因为拆文件会改 nodeid 与用例编号 |
| 前端功能映射中的文件路径逐文件二次核对 | **低优先**：映射初版部分路径为探索推断，非阻断 |
| CI schema 一致性校验（`create_all` vs Alembic） | **低优先**：尚未接入门禁；结构性变更按当期执行单在 ECS 现场比对 |
| 用例「合格标准」标为待确认（约 2200 条） | **已知取舍**：用例缺 docstring 预期句，按「业务规则不明确」标记，非阻断 |

> 测试体系建设（分层架构、模块编号 A–F + SYS、用例库、执行记录 / 报告链、CI 门禁收口）已完成。阶段性建设台账《测试体系建设任务清单》已于 2026-11-11 吸收进本表，**不再单独维护**；上表三项是台账中仅存的未决项，均为非阻断。审计基线、误判核销与阶段验收等过程留痕见 git 历史，不作为现行执行依据。

## 7. 维护规则

- 本文件是测试资产的唯一索引；新增测试目录或执行入口时同步更新第 1、5 节；`FE-*` 用例与自动化的映射在 `tests/manifests/测试资产映射.md`。
- 手工用例在 `docs/前端测试用例库_20261101.md`，自动生成的用例库与报告在 `docs/testing/`；历史证据在 `docs/archive/`，不作为现行通过依据。
- Fixture 不得包含真实账号、密码、手机号、客户资料或生产数据。
- 视觉快照失败先确认是否为预期产品变更，**不得直接按实际图覆盖快照**；拖拽、loading 与退出反馈类失败要复核事件命中与样式清理，**不得靠放宽断言超时掩盖**。
- 2026-11-01 的《前端快速回归基线》已吸收进本文后下线：其中通过数量、覆盖率门禁、SQLite E2E 库及已废弃命令均属时点数据，现行执行入口与耗时基线以第 5 节为准，过程留痕见 git 历史。
