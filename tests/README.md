# 测试资产索引

更新时间：2026-11-04

本文件回答四个问题：**测试在哪、怎么跑、新测试放哪、怎么判断一个测试有没有价值**。

> 目录重构仍在进行中，本文件描述的是**目标结构 + 当前实际状态**，两者不一致处已逐条标注。
> 上一版（2026-11-01）写的 `backend/tests/v1/` 已不存在，后端测试已于 11-04 迁至 `tests/backend/`。

## 1. 目录结构

```text
tests/
├── README.md                     本文件（唯一入口说明）
├── backend/
│   ├── conftest.py               11 个共享夹具 + 测试库硬校验 + db 标记派生（唯一一份）
│   ├── test_*.py                 113 个文件扁平存放，**不按 unit/integration 拆目录**
│   └── _report/                  生成物（case_index.json 等），已 gitignore
├── fixtures/                     合成数据与图片，禁止真实客户资料
├── manifests/                    用例 ↔ 文件映射表（人写）
└── results/                      执行基线记录（人写）
```

**前端测试不在本目录**，理由不是"还没搬"，是**搬不了**（2026-11-04 实测）：仓库根没有
`node_modules`，而 vitest 的 root 是 `frontend/`，包外测试会先被 Vite 的 fs 白名单拦
（`/@fs/... Cannot find module`），放开白名单后 bare 依赖（`axios` 等）又按 importer
所在目录向上找不到包。故两个前端目录都在包内：

```text
frontend/src/**/*.test.tsx        组件测试（与被测组件同层）
frontend/tests/**/*.test.ts       纯逻辑测试（15 个文件 / 105 条用例，准入标准见该目录 README）
frontend/e2e/*.spec.ts            Playwright 规格
```

后端测试的搬迁已在 2026-11-04 完成（`backend/tests/v1/` → `tests/backend/`）。搬迁会改变
nodeid，而 `results.jsonl` 的历史记录靠 nodeid 关联用例编号：写入时 `case_no` 已解析的记录
搬完仍能归位，只有 `case_no` 为空的老记录要靠 nodeid 反查（`make_test_report.py` 的
`load_node_index`）。实测 1091 条历史前端用例的编号零漂移。

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
.venv/bin/python3 run_coverage_gate.py           # 四域覆盖率闸门（缺失行基线）
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
npm run test:fast            # 纯逻辑（13 文件 = frontend/tests/ 的 10 个 + src 内 3 个基建自测）
npm run test:quick           # 提交前默认
npm run test:react           # 组件 / 面板
npm run test:react-deep
npm run test:full:all        # 全量分片
npm run test:e2e             # Playwright + 真实后端 + 独立库 heijin_erp_e2e
```

#### 前端测试的模块定位：一律用 `@/`

`@` 指向 `frontend/src`，在 `vitest.config.ts`、`vite.config.ts`、`tsconfig.json` 三处必须同步。
测试里的 `import` 与 `vi.mock` 都写 `@/...`，不写 `./` `../`：

```ts
vi.mock("@/shared/api/client", () => ({ api: mocks }));   // 对
vi.mock("../shared/api/client", () => ({ api: mocks }));  // 错
```

相对路径的危险不是「解析失败」（那会显式报错），而是**搬家后仍解析到某个存在的文件**：mock 注册了
却没命中被测模块，测试改用真实现照常通过，保护静默消失。守卫 `src/test/mock-specifier.test.ts`
把它变成提交时的显式失败——新增相对路径直接红，存量 74 处冻结在
`src/test/mock-specifier-baseline.json`（只减不增，条目失效必须删除）。守卫在 `test:fast` 档。

### 环境约束

- 后端测试只认 `TEST_DATABASE_URL`，**刻意不回落 `DATABASE_URL`**；库名必须含 `test`，
  且命中 `release`/`prod` 等黑名单或与 `DATABASE_URL` 同库时直接 abort（夹具会 TRUNCATE 全表）。
- E2E 用 `heijin_erp_e2e`，每次运行重建并重播种子，用完即弃，绝不触碰 dev/test/release。

## 6. 当前已知缺口

| 项 | 状态 |
|---|---|
| ~~13 个后端测试文件未进任何分组~~ | **已解决**：全部登记，`test_group_coverage.py` 拦截复发 |
| ~~33 个文件头写的功能码尚未登记进承诺清单（基线值，只降不升）~~ | **已解决**：112/112 全部自带承诺码，历史回退机制已封存 |
| ~~后端 112 个文件仍扁平存放，`unit/` `integration/` 只是空壳~~ | **已决策**：不拆目录，改用 `db` marker 派生；两个空壳目录已删除 |
| ~~前端纯逻辑测试迁出 `src/`~~ | **已完成**：15 个文件 / 105 条用例迁入 `frontend/tests/`；落点选包内而非仓库根，因包外必撞 Vite fs 白名单与 bare 依赖解析（实测）。组件测试按准入标准不迁 |
| ~~`vi.mock` 用相对路径，测试文件搬迁后静默失效~~ | **已解决**：`@` 别名 + `mock-specifier.test.ts` 守卫，74 处存量冻结 |
| `results.jsonl` 只增不减，日增约 14 MB | **已解决**：`scripts/trim_test_results.py` 覆盖保持式裁剪，14.61 MB / 102 run → **3.82 MB / 24 run**，被裁行归档进 `测试结果库/archive/`（gitignore）。裁剪后报告「未执行 0 / FAIL 0」与裁剪前逐项一致 |

## 7. 维护规则

- 本文件是测试资产的唯一索引；新增测试目录或执行入口时同步更新第 1、5 节。
- 手工用例与报告在 `docs/testing/`，不在本目录；历史证据在 `docs/archive/`，不作为现行通过依据。
- Fixture 不得包含真实账号、密码、手机号、客户资料或生产数据。
