# 宜游轩 ERP 发布记录

## 发版流程（每次发正式版照此执行）

> **版本号不会自动升。** 必须显式执行下面第 1 步；不做则三处版本停在旧值，
> 且 `test_frontend_version_matches_backend_release_version` 会在只改一处时直接红。

```bash
# 1 升版本号（patch=修 bug / minor=加功能 / major=不兼容）
scripts/ops/bump_version.sh patch         # 先 --dry-run 看将要改什么
scripts/ops/bump_version.sh --check       # 确认三处一致

# 2 写本文件的发布说明（新版本章节，脚本不代写）

# 3 提交并打 tag（tag 必须指向含本次版本改动的提交）
git add backend/app/version.py frontend/package.json frontend/package-lock.json RELEASE.md
git commit -m "release: v1.1.1 ..."
scripts/ops/bump_version.sh --tag         # 或 git tag -a v1.1.1
```

一次改动三处，缺一处即失效：

| 文件 | 作用 | 漏改的后果 |
| --- | --- | --- |
| `backend/app/version.py` | 唯一事实源；`deploy.sh` 据此生成镜像 tag | `/health` 与镜像 tag 报旧版本 |
| `frontend/package.json` | 前端包版本 | 前端无法反查 |
| `frontend/package-lock.json` | 根包版本（顶层 + `packages[""]` 两处） | `npm ci` 结果与 package.json 不符 |

部署侧**无需任何配置**：`deploy.sh` 用 `sed` 从 `version.py` 解析并 `export APP_VERSION`，
镜像 tag（`heijin-backend:<版本>`）与容器内 `/api/v1/health` 的 `app_version` 自动跟随。

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
