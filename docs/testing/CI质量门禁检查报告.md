# 宜游轩 ERP CI 质量门禁检查报告

> 检查日期：2026-11-03｜目标工作流：本地 dev → GitHub test → CI → GitHub main → CD

---

## 1. 现有 Workflow 实测（`.github/workflows/`）

| Workflow | 触发 | 实际执行内容 | 是否跑测试 |
|---|---|---|---|
| `lint-gate.yml` | push(main/master/test)+PR+手动 | pyflakes(钉版4.0.3) + PII 扫描；仅拦基线外新增告警 | 否（仅静态） |
| `frontend-gate.yml` | 同上 + 每日 02:00 兜底 | TS/UI 守卫 + 分层测试(fast/quick/react) + build；`test-react-deep` 仅 main/定时/手动 | 是（前端部分） |
| `coverage-gate.yml` | push+PR+手动 | 起 `postgres:16-alpine`，跑**后端全量 + 覆盖率闸门** | 是（后端全量） |
| `auto-merge-test-to-main.yml` | push(test) | 轮询三 gate 全绿后 `--no-ff` 合 main → 触发部署 | 否（依赖结论） |
| `deploy-production.yml` | push(main)+手动 | 构建镜像 + SCP + deploy + 健康检查 + 打 tag | 否 |
| `rollback.yml` | 手动 | SSH 切回指定版本 | 否 |

> **命名勘误**：任务假设存在 `frontend-e2e`，实际**不存在**（E2E 已整体下线，见 `auto-merge` 注释）。

## 2. 门禁有效性评估

### 已有效
- `coverage-gate` 是后端测试的唯一真实执行点，且强制独立临时 PG（`POSTGRES_DB=heijin_erp_test`），CI 同库校验被跳过（合理）。
- `lint-gate` 增量告警门禁，避免历史告警掩盖新引入问题。
- `auto-merge` 必须三 gate 全 success 才合 main，提供合并门禁。

### 问题（按风险）

**P1 — 覆盖率闸门阈值失真（gate 可能"假绿"）**
- `run_coverage_gate.py` 内联 `GATES = {foundation:0, core:0, reporting:0, finance:7}`，但 `load_gates()` 实际读 `coverage_baseline.json`：
  - `app/foundation` max_missing=**2**
  - `app/core` max_missing=**4**
  - `app/reporting` max_missing=**22**
  - `app/finance` max_missing=**43**
- 注释/代码与真实阈值严重不符；`finance` 容忍 **43 行**未覆盖，闸门对关键资金模块极宽松。
- **建议**：以真实基线为起点，按风险逐步收紧；修正代码内联常量误导。

**P2 — 前端 deep 层在 PR/test 跳过**
- `frontend-gate` 的 `test-react-deep`（4 分片、16 个重型用例）`if` 条件=非 PR 且（非 push 或 ref 为 main/master），即 **PR 与 test 分支跳过**，仅 main/定时/手动触发。
- 聚合 gate `frontend-tests` 对 `skipped` 视为通过 → PR 门禁未覆盖 deep 回归，最长 24h（夜间）才发现。
- **建议**：将 deep 层纳入 PR（或至少 test 分支），或明确告知"deep 仅 main 守护"并在报告标注。

**P2 — 前端覆盖率无强制阈值**
- `@vitest/coverage-v8` 已配但无 `fail_under`；任何 gate 不强制前端覆盖率 → 可静默回退。
- **建议**：设与后端一致的"增量不恶化"门槛。

**P2 — 测试库建表双路径（CI 与生产漂移）**
- 测试 `create_all` vs 生产 Alembic；常规 CI 不验证"迁移后 schema == ORM"。仅 `test_migration.py` 单独 subprocess 验迁移。
- **建议**：CI 增一步 `test_migration` 或 schema 一致性校验。

## 3. 分支保护与 Ruleset（需人工确认）

- 当前未在本仓读取到 branch protection / Ruleset 配置（CI 通过 `auto-merge` 轮询实现"test→main"门禁，而非 GitHub 原生保护规则）。
- **未验证项**：是否设置了 main 的 required status checks、是否禁止直接 push main。
- **行动**：需在 GitHub 仓库设置页确认；如需配置强制 status check，应报告待配置项，**不擅自更改仓库级保护**。

## 4. 结论

CI 具备基础门禁骨架，但存在"假绿"风险（覆盖率阈值失真 + deep 跳过 + 前端无门槛）。修复 P1/P2 后，CI 方能真正阻止不合格代码合并。当前 CI 对后端全量测试的覆盖是真实有效的。
