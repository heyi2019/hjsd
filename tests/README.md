# 测试文件管理索引

更新时间：2026-11-01

本目录用于统一说明测试资产的位置、归属和维护规则。当前只增加索引，不移动或删除已有测试文件，避免影响现有运行命令。

## 1. 测试资产总览

| 类型 | 当前文件位置 | 维护方式 | 主要入口 |
|---|---|---|---|
| 后端单元/服务测试 | `backend/tests/v1/` | pytest；通过文件名和回归分组维护 | `cd backend && .venv/bin/python -m pytest tests/v1 -q` |
| 前端单元/组件测试 | `frontend/src/**/*.test.ts(x)`、`frontend/src/**/*.spec.ts(x)` | Vitest；按 fast、quick、react、react-deep 分层 | `cd frontend && npm run test:quick` |
| 前端集成/E2E 测试 | `frontend/e2e/` | Playwright；真实浏览器路径，联调时使用独立 E2E 数据库 | `cd frontend && npm run test:e2e` |
| CI 测试 | `.github/workflows/` | GitHub Actions；Lint、前端、E2E、覆盖率四类门禁 | push/PR 触发，具体规则见工作流文件 |
| 后端回归测试 | `backend/run_regression.py`、`backend/tests/v1/` | 按业务域分组，可按变更选择分组 | `cd backend && .venv/bin/python run_regression.py <group>` |
| 前端回归测试 | `frontend/scripts/test-full-sharded.mjs`、`frontend/package.json` | fast、quick、react、react-deep 分层执行 | `cd frontend && npm run test:full:all` |
| 测试数据与图片 | `tests/fixtures/` | 只存假数据和合成文件，不存真实客户资料 | 见 `tests/fixtures/README.md` |
| 手工测试用例库 | `docs/前端测试用例库_20261101.md` | 编号 `FE-001` 起，持续维护 | 页面操作测试 |
| 手工测试报告 | `docs/前端建单与页面交互测试报告_20261101.md` | 记录执行值、缺陷和复测结果 | 本轮 Dev 前端测试 |
| 自动化执行结果 | `tests/results/` | 记录命令、环境、通过数量和边界 | 当前回归基线 |
| 历史测试资料 | `docs/archive/` | 只读归档，不作为当前版本通过依据 | 需要追溯历史时查看 |

详细的“用例/文件/执行入口”映射见：`tests/manifests/测试资产映射_20261101.md`。

前端手工用例与 Vitest/Playwright 的模块映射见：`tests/manifests/前端用例自动化映射_20261101.md`。

## 2. 目录管理原则

### 2.1 自动化测试

- 后端测试暂不搬动，继续保留在 `backend/tests/v1/`，通过 `backend/run_regression.py` 的分组管理。
- 前端 Vitest 测试继续跟随被测模块放在 `frontend/src/` 附近，避免测试和组件脱节。
- 浏览器端场景统一放在 `frontend/e2e/`，文件名使用业务或能力名称，例如 `business-write.spec.ts`、`visual.spec.ts`。
- 新增测试必须使用稳定的测试数据，不得依赖生产数据库或开发者个人数据。
- 本地测试环境文件、数据库备份和运行产物不得提交；具体忽略规则见根目录 `.gitignore`。

### 2.2 手工用例与报告

- 当前可执行的手工用例放在 `docs/前端测试用例库_20261101.md`。
- 当前执行证据放在 `docs/前端建单与页面交互测试报告_20261101.md`。
- 历史版本报告、旧用例库和旧验收资料放入 `docs/archive/`，不覆盖当前文档。
- 新增问题应同时记录：用例编号、严重级别、复现步骤、期望结果、实际结果、截图或数据证据、复测状态。

### 2.3 Fixture

- `tests/fixtures/v1_acceptance_seed.json`：自动化验收假数据。
- `tests/fixtures/account-image-test-20261101.png`：图片上传、预览、保存和详情回显的合成图片。
- `tests/fixtures/raw_imports/`：导入类文件的存放位置。
- Fixture 不得包含真实账号、密码、手机号、客户资料或生产数据。

## 3. 当前执行入口

### 前端

```text
npm run check
npm run test:fast
npm run test:quick
npm run test:react
npm run test:react-deep
npm run test:e2e:critical
npm run test:full:all
```

### 后端

```text
.venv/bin/python run_regression.py smoke
.venv/bin/python run_regression.py p0
.venv/bin/python run_regression.py changed
.venv/bin/python run_regression.py all
.venv/bin/python run_coverage_gate.py
```

## 4. 后续维护要求

新增用例时至少补充以下信息：

1. 测试类型：单元、集成、CI 或回归。
2. 用例编号或关联编号。
3. 自动化文件路径或手工执行文档。
4. 对应 CI 门禁或回归分组。
5. 测试数据来源和清理/隔离方式。
6. 最近一次执行结果。

当前索引不替代自动化测试代码；它只负责回答“测试文件在哪里、由谁执行、属于哪一类、结果记录在哪里”。
