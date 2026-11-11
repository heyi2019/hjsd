# 宜游轩 ERP 发布记录

## 发版流程入口

正式版发布、阿里云部署、备份和回滚统一按 [docs/研发流程.md](docs/研发流程.md) 执行。本文件只保留版本记录和版本号生成规则，避免维护两套发布步骤。

> **正常推送 `main` 会自动发版。** CI 会按提交类型自动升版：普通修复/工程变更升
> patch，`feat` 升 minor，带 `!` 或 `BREAKING CHANGE` 升 major，并同步三处版本、
> 生成本轮提交摘要和发布章节。下面命令保留给需要本地预览或手动指定版本的场景。

```bash
# 1 升版本号（patch=修 bug / minor=加功能 / major=不兼容）
scripts/ops/bump_version.sh patch         # 先 --dry-run 看将要改什么
scripts/ops/bump_version.sh --check       # 确认三处一致

# 2 生成本文件的发布章节（脚本出骨架，业务口径仍需人工补）
scripts/ops/changelog.sh --from v1.0.1        # 先看草稿，不落盘
scripts/ops/changelog.sh --from v1.0.1 --write # 插入到顶部（已有该版本章节会拒绝）

# 3 提交并打 tag（tag 必须指向含本次版本改动的提交）
git add backend/app/version.py frontend/package.json package-lock.json RELEASE.md
git commit -m "release: v1.1.1 ..."
scripts/ops/bump_version.sh --tag         # 或 git tag -a v1.1.1
```

> **漏写会被测试挡住**：`tests/backend/unit/system/test_settings.py::test_release_notes_has_section_for_current_version`
> 断言本文件存在当前版本的 `## Vx.y.z` 章节，且章节内含「发布时间」「本次内容」。
> 版本号涨了、章节没跟上 → `run_regression.py ci` 直接红，不再依赖人记得。

一次改动三处，缺一处即失效：

| 文件 | 作用 | 漏改的后果 |
| --- | --- | --- |
| `backend/app/version.py` | 唯一事实源；`deploy.sh` 据此生成镜像 tag | `/health` 与镜像 tag 报旧版本 |
| `frontend/package.json` | 前端包版本 | 前端无法反查 |
| `package-lock.json`（仓库根） | workspaces 子包 `packages["frontend"].version` | `npm ci` 结果与 package.json 不符 |

部署侧**无需任何配置**：`deploy.sh` 用 `sed` 从 `version.py` 解析并 `export APP_VERSION`，
镜像 tag（`heijin-backend:<版本>`）与容器内 `/api/v1/health` 的 `app_version` 自动跟随。

---

## V0.1.3

**发布时间：** 2026-11-11 22:58:57 CST（Asia/Shanghai）

### 本次内容

本轮自动汇总以下提交，按 Bug 修复、功能更新和工程变更分类：

相对提交 `8746a42699ad`，共 7 个非合并提交；18 files changed, 406 insertions(+), 484 deletions(-)。

### 工程与其他变更

- 后端换 python:3.12-alpine 提速，构建上下文排除 backups（`f2968e1e`）
- 移除 PII 扫描门禁与白名单（`297e9f02`）
- 主流程门禁轮询改为批量判定（`347f39eb`）
- 部署构建与门禁并行，上传仍受门禁保护（`0d2a9f41`）
- 后端门禁按变更选测，压缩发版前等待（`676373f8`）
- 消除门禁双跑，压缩发布轮询等待（`9845796c`）
- 前端门禁按变更选测，修复 gha 构建缓存未写入（`63977bbf`）

### 发布结果

- 自动版本：`V0.1.3`
- 更新级别：`patch`
- CI 门禁：lint、前端构建/测试、后端核心测试
- 部署：门禁全部通过后自动发布到 ECS

---
## V0.1.2

**发布时间：** 2026-11-11 18:16:26 CST（Asia/Shanghai）

### 本次内容

本轮自动汇总以下提交，按 Bug 修复、功能更新和工程变更分类：

相对提交 `47336bc8e354`，共 19 个非合并提交；227 files changed, 1305 insertions(+), 32768 deletions(-)。

### Bug 修复

- drop stale test triggers, guard release loop and restore B4 script（`3f543b4e`）
- restore RELEASE.md and align indexes with purged assets（`b638ea75`）

### 工程与其他变更

- merge interface/state/permission contracts and absorb FE mapping into tests README（`bb1d8071`）
- merge feature registry and promise ledger into one metadata ledger（`f0e88b36`）
- merge test specs, drop stale baselines, allow code-to-doc refs（`2be75129`）
- retire stale specs and merge process/component docs（`7ba0c18e`）
- normalize doc filenames and date-stamp test reports（`fa8e71da`）
- retire archived docs and trim PII allowlist to live files（`bb6cb154`）
- merge test asset manifests and retire dated baselines（`bc2d1653`）
- absorb finished test-system ledger into tests README（`fbee2f6c`）
- correct test asset map with live specs and task ledger（`a3bdb035`）
- align local db ownership with split dev/main env files（`107c572c`）
- correct stale db name, artifact retention and test-branch wording（`d88782a9`）
- purge orphan mutation script and redundant placeholders（`5266e145`）
- sync flows with three-gate auto release chain（`264a5bdf`）
- align release, development and test flows with origin/main-only CI（`b58a614b`）
- purge archived docs, import scripts and dev helpers（`e38936a1`）
- unify backup retention defaults to 7 days（`71fdcebb`）
- remove stale test-branch triggers and RELEASE.md（`dcddca18`）

### 发布结果

- 自动版本：`V0.1.2`
- 更新级别：`patch`
- CI 门禁：lint、前端构建/测试、后端核心测试
- 部署：门禁全部通过后自动发布到 ECS

---
## V0.1.1

**发布时间：** 2026-11-11 01:59:58 CST（Asia/Shanghai）

### 本次内容

本轮自动汇总以下提交，按 Bug 修复、功能更新和工程变更分类：

相对提交 `4f2b23da5b72`，共 1 个非合并提交；2 files changed, 5 insertions(+), 2 deletions(-)。

### Bug 修复

- include required release content heading（`f071a2ed`）

### 发布结果

- 自动版本：`V0.1.1`
- 更新级别：`patch`
- CI 门禁：lint、前端构建/测试、后端核心测试
- 部署：门禁全部通过后自动发布到 ECS

---
## V0.1.0

**发布时间：** 2026-11-11 01:55:27 CST（Asia/Shanghai）

### 本次内容

本轮自动汇总以下提交，按 Bug 修复、功能更新和工程变更分类：

相对提交 `21e9031290ab`，共 1 个非合并提交；4 files changed, 206 insertions(+), 11 deletions(-)。

### 功能更新

- automate release versioning and change summaries（`8a9040d6`）

### 发布结果

- 自动版本：`V0.1.0`
- 更新级别：`minor`
- CI 门禁：lint、前端构建/测试、后端核心测试
- 部署：门禁全部通过后自动发布到 ECS

---
## V0.0.9

**发布时间：** 2026-11-10 CST（Asia/Shanghai）

### 本次内容

- 数据库只保留当前 ORM 的 `0001` 初始化基线；已移除旧版本增量迁移、旧库对齐与修复脚本。
- 本地 dev、release、test、e2e 数据库从 `0001` 重新创建。
- 发布工作流提供仅手动触发的全量数据库重建开关，普通发布默认不清库。

### 升级与回滚

本版仅支持全新数据库初始化；如需全量置换，必须在手动发布时显式启用数据库重建，并使用发布前快照回退。

---

## V1.0.4

**发布时间：** 2026-11-05 CST（Asia/Shanghai）

| 项目 | 版本 / 标识 |
| --- | --- |
| 系统发布版本 | `V1.0.4` |
| 前端构建版本 | `1.0.4` |
| 后端 API 版本 | `1.0.4`（唯一事实源 `backend/app/version.py`） |
| 数据库迁移基线 | 活动链仅 `0001` = head；**本版零 DDL**，历史表 `rebate_settlements` 保留不 drop |

### 本次内容

相对 `v1.0.3` 共 36 个非合并提交（139 文件，+4698 / −1176）。**按终态交付口径**：

- **售出表单三分**：回收 / 提号 / 代挂由共用 `SALE` 拆为 `SALEREC` / `SALETH` / `SALEDG`，字段与板块标题各自配置、互不影响；差异化后 28 / 28 / 21 项，代挂金额称「利润」且不含分期与分笔字段。**已有库升级必须跑 `backend/scripts/split_sale_form_scopes.py`**，字段总数 220 → 297。
- **利润与报表同源**：分润基数 = 单订单所有收入 − 所有支出（可正可负可 0）；返点记录计入收入、分期坏账计入支出；结算展示列与 `rebate_settlements` 模型层下线，返点金额唯一取 `rebate_records.base_amount`。
- **订单与账号台账**：成交日期可编辑并平移事件/流水账期、重取规则快照；台账编辑态三个时间联动；账号删除仅管理员、原因必填、关联单据保留并显式解绑；亏损单允许按金额负数分润；一个动作多人按人数均分；「我的订单」覆盖全部事件执行人。
- **前端单入口**：H5 两套入口与微信 H5 通道已下线，手机访问靠 `responsive.css` 三断点；移动端隐藏列按列 key 打标，禁用 nth-child。
- **登录**：桌面端密码 / 手机号验证码 / 微信三入口保留，不开放注册；生产 `.env` 两条免密链路仍显式关闭。
- **质量口径**：三端全量回归全绿（后端 1728、前端落库 1081 全 PASS、E2E 62），官方报告 FAIL / ERROR / SKIP / 未执行 / 弱标准均归零；版本三处一致由 `bump_version.sh --check` 守卫。
- **发布通道合规**：`deploy.sh` 移除 `db_version` 自建表与 `policy_definitions` 预置两处副作用，只保留升级前后库状态不变量自检（失败即中止发布），不再内置 B4 补齐；`deploy-production.yml` 持久化 ECS `.env` 的 `APP_VERSION`，避免后续单独 `compose up` 静默回落旧镜像。

> 提交历史中曾出现 `feat(h5)` 系列，最终已整体下线，**不属于本版交付内容**。发布记录按终态口径书写，勿按提交列表逐条对外引用。

### 升级与回滚

按 `docs/研发流程.md` **自动 CI/CD 原地增量升级**：`git push origin main` → `main-ci-cd` 自动升版并生成 `chore(release)` 提交 → dispatch 三个 CI 门禁（lint / frontend / backend）→ 全绿后 dispatch `deploy-production` → ECS 原地增量部署。生产数据不出 ECS；B4 不在 `deploy.sh` 内自动执行，已有库升级须在 ECS 现场按当期执行单手动跑 `backend/scripts/split_sale_form_scopes.py`。回滚按研发流程中的备份与恢复步骤执行。

### 已知遗留

首次设密死锁修复未包含在本版；生产两条免密链路保持关闭，开放前需单独发版。高负载下两条 E2E flake 仍待裁决；`origin/main` 是唯一发布通道，`push origin main` **误触等同生产上线**。

---

## V1.0.3

**发布时间：** 2026-11-05 CST（Asia/Shanghai）

| 项目 | 版本 / 标识 |
| --- | --- |
| 系统发布版本 | `V1.0.3` |
| 前端构建版本 | `1.0.3` |
| 后端 API 版本 | `1.0.3`（唯一事实源 `backend/app/version.py`） |
| 数据库迁移基线 | 活动链仅 `0001` = head（`create_all` + `seed_catalog`），不再加增量迁移 |

### 本次内容

- **售出表单三分**：回收 / 提号 / 代挂售出由共用 `SALE` 拆为 `SALEREC` / `SALETH` / `SALEDG` 独立作用域，三份字段与板块标题各自配置、互不影响；按界面差异化补齐后可配字段 28 / 28 / 21 项，代挂金额称「利润」且不含分期与分笔字段。**已有库升级必须执行 `backend/scripts/split_sale_form_scopes.py`**，否则回落默认值并丢失管理员配置。
- **利润口径统一**：分润基数 = 该订单所有收入 − 所有支出，可正可负可 0；返点记录计入收入、分期坏账计入支出（二者不生成 cashflow）；报表与订单详情同源。结算展示层与 `rebate_settlements` 模型层下线，已有库历史表保留不 drop。
- **分润与订单**：亏损单允许按金额负数分润；一个动作多人时按人数均分，台账增删执行人联动分润人数；「我的订单」覆盖全部事件执行人而非仅 SELL。
- **时间与删除**：成交日期可编辑并按天数平移该单事件/流水账期、重取规则快照；账号台账编辑态三个时间联动平移（含系统时间戳）；账号删除仅管理员、原因必填、关联单据保留并显式解绑、审计留全快照。
- **登录**：桌面端免密登录（密码 / 手机号验证码 / 微信）保留，准入为已配置手机号且在职、不开放注册；**H5 两套入口与微信 H5 通道已下线**，前端回到单入口。生产 `.env` 显式关闭两条免密链路。
- **上线口径**：迁移链压平为活基线 `0001`，上线改为原地增量（dump → drill → `schema_diff.py` 只补缺失 → `APP_VERSION` 换镜像），主键须单独核 `pg_constraint`。

### 发布前检查

- `scripts/ops/bump_version.sh --check` 三处版本一致；`run_regression.py ci` / `fe` 与 Playwright E2E 结果已定性。
- 已有库按 `docs/研发流程.md` 的发布前检查在 ECS 现场执行 B4，并检查字段数增量为预期。
- 结构比对除列与索引外，必须核对 `pg_constraint.contype='p'`（业务表缺失主键数为 0）。

### 回滚

镜像按 `APP_VERSION` 回退到上一版；数据库侧拆分脚本只插不删、旧 `SALE` 行完整保留，`rebate_settlements` 历史表亦未 drop，回退旧镜像无需清理数据。

### 已知遗留

**1.0.3 不含首次设密死锁修复**：启用免密登录前必须先发 1.0.4；当前生产两条链路显式关闭，请勿在 1.0.3 上开启。

---

## V1.0.1

**发布时间：** 2026-10-31 CST（Asia/Shanghai）

| 项目 | 版本 / 标识 |
| --- | --- |
| 系统发布版本 | `V1.0.1` |
| 前端构建版本 | `1.0.1` |
| 后端 API 版本 | `1.0.1`（唯一事实源 `backend/app/version.py`） |
| 数据库迁移基线 | Alembic 活动链 `0001` → `0003`（head `0003`）。**历史口径**：10-31 曾将 `0002..0071` 压平并 stamp 至 `0003`；迁移链后续再次压平，现行活动链只剩活基线 `0001`（见《研发流程》） |

### 本次内容

V1.0.0 之后的维护性发布，修复依赖锁与 CI/CD 标签链路，使全自动 CD（推 `test` → 4 个 CI gate 全绿 → 自动合 `main` → 自动部署 + 锁版 tag）真正闭环。

修复项：

- **依赖锁修复**：`backend/requirements.lock.txt` 中 `websockets==17.4` 在部署用的阿里云 PyPI 镜像上缺货（仅到 17.3），导致 `pip install -r requirements.lock.txt` 构建失败、部署中断。降级为 `websockets==17.3`（与 uvicorn 约束兼容）修复。
- **CI/CD 标签链路修复**（让「自动合 main 后自动部署 + 锁版 tag」闭环）：
  - `auto-merge-test-to-main.yml` 合并 `main` 后，因默认 `GITHUB_TOKEN` 推送不点燃下游 push 事件，改用 `gh workflow run deploy-production.yml --ref main` 显式触发部署。
  - `deploy-production.yml` 的 `Tag release` 步骤补充 git 提交者身份（避免 `empty ident name` 打 tag 失败），并将 tag 名由 `env:` 字面量 `v${APP_VERSION}` 改为 shell 内展开，修复打出非法 tag 名 `v${APP_VERSION}` 的缺陷，正确生成 `v1.0.1`。
- **版本一致性**：同步 `.env.example` 的 `APP_VERSION=1.0.1`，消除与 `version.py` 漂移；前后端三处版本经 `scripts/ops/bump_version.sh` 统一为 `1.0.1`，CI 版本一致性测试通过。

### 发布前检查

- 4 个 CI gate（lint / frontend / coverage / frontend-e2e）在 `test` 全绿；`auto-merge` 成功合入 `main`；`deploy-production` 部署成功并打 `v1.0.1` tag。
- 生产 `docker images | grep heijin-backend` 显示 `1.0.1`；`curl /api/v1/health` 的 `app_version` 为 `1.0.1`。

### 回滚

- 与 V1.0.0 同机制；回退目标为 `v1.0.1` 镜像 tag + 部署前数据库备份。

---

## V1.0.0（首发）

**发布时间：** 2026-10-27 CST（Asia/Shanghai）

| 项目 | 版本 / 标识 |
| --- | --- |
| 系统发布版本 | `V1.0.0` |
| 前端构建版本 | `1.0.0` |
| 后端 API 版本 | `1.0.0`（唯一事实源 `backend/app/version.py`） |
| 数据库迁移基线 | Alembic `0001`（37 张业务表 + 68 索引） |

### 本次内容

**首发上线版本，此前无对外发布**，故不与上一版比对。生产库从空库起始（不搬迁开发库数据）。

业务能力：

- 订单 / 客户 / 分期 / 返点 / 资金池 / 对账 / 报表全链路；表单字段 47 个作用域；
  选项词典 12 组 57 项；经营规则（返点 / 提成 / 分期 / 混合）保存即发布；权限 26 点 5 角色。
- 修复订单创建表单的单控件绑定、代分期末期金额提示。

上线前加固（本次交付的核心）：

- **公开发布安全**：生产关闭 `/docs`、`/redoc`、`/openapi.json`；nginx 六个安全头（含 CSP）修复
  「子级 `add_header` 导致首页继承失效」的缺陷，改为公共片段逐 `location` 显式 include；
  登录接口限流防爆破；JWT 占位符 `replace-with-` 前缀直接拒绝启动。
- **镜像瘦身**：后端 547MB→207MB（拆分 `requirements-dev.txt`）、基础镜像切 alpine，
  两镜像合计 625MB→227MB。
- **部署可靠性**：`deploy.sh` 补政策定义预置与迁移兜底（`stamp_baseline`）；空数据卷跳过备份；
  健康检查失败即中止；新增 `harden_host.sh` 主机加固脚本。
- **备份灾备**：新增 `backup_daily.sh`（ECS 每日快照）与 `pull_backup.sh`（本机拉取，
  暂存校验后原子替换，坏备份不覆盖本地好备份）；`backup_db.py` 修掉 WAL 影子文件导致
  「SHA256 校验通过却丢页」的隐患，备份强制自洽单文件。
- **版本可追溯**：`backend/app/version.py` 为版本唯一事实源；`/api/v1/health` 与 `root`
  均返回 `app_version`；镜像 tag 由 `deploy.sh` 解析生成；`scripts/ops/bump_version.sh`
  一键改齐三处，并有测试断言前后端版本一致。

### 发布前检查

- 后端 `pytest tests/v1/test_settings.py`、迁移一致性（`alembic check`）通过。
- `deploy/.env` 配置 `APP_ENV=production`、`JWT_SECRET_KEY`（`openssl rand -hex 32`）、空 `CORS_ORIGINS`。
  版本号**不要**写入 `.env`，由 `version.py` 决定。
- `ADMIN_PASSWORD` 以临时 `export` 传入，不写入 `.env`。
- 首次部署后核对：`docker compose ps` 中 backend 为 `Up (healthy)`；
  `curl /api/v1/health` 的 `app_version` 为 `1.0.0`；`docker images | grep heijin-backend` 显示 `1.0.0`。

### 回滚

1. `docker compose down`（禁 `-v`，卷 `erp_db` 含正式库）。
2. 用发布前备份 `data/backups/heijin_erp_v1_<时间戳>.db` + `.sha256` 经 `restore_db.py` 恢复。
3. 切回上一份已验证的镜像 tag 并完成健康检查。数据库无需回退（本次无迁移变更）。

> V1.0.0 是首个上线版本，因此没有「上一版」可回退；真正的回退目标是 **部署前快照**
> （数据库）+ **上一份通过验收的镜像**（代码）。这也是 `deploy.sh` 每次部署前强制备份的原因。
