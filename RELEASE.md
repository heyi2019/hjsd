# 宜游轩 ERP 发布记录

## V1.1.0

**发布时间：** 2026-10-27 22:15 CST（Asia/Shanghai）

| 项目 | 版本 / 标识 |
| --- | --- |
| 系统发布版本 | `V1.1.0` |
| 前端构建版本 | `1.1.0` |
| 后端 API 版本 | `1.1.0`（唯一事实源 `backend/app/version.py`） |
| 数据库迁移基线 | Alembic `0001` |

### 本次内容

相对 V1.0.0（14 个提交、24 文件、+1067/-52 行），全部为上线前加固：

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
- **版本可追溯**：新增 `backend/app/version.py` 作为版本唯一事实源；`/api/v1/health` 与
  `root` 均返回 `app_version`；镜像 tag 由 `deploy.sh` 解析该文件生成；前端 `package.json` 同步。

### 发布前检查

- 后端 `pytest tests/v1/test_settings.py`、迁移一致性（`alembic check`）通过。
- `deploy/.env` 配置 `APP_ENV=production`、`JWT_SECRET_KEY`（`openssl rand -hex 32`）、空 `CORS_ORIGINS`。
  版本号**不要**写入 `.env`，由 `version.py` 决定。
- `ADMIN_PASSWORD` 以临时 `export` 传入，不写入 `.env`。
- 首次部署后核对：`docker compose ps` 中 backend 为 `Up (healthy)`；
  `curl /api/v1/health` 的 `app_version` 为 `1.1.0`；`docker images | grep heijin-backend` 显示 `1.1.0`。

### 回滚

1. `docker compose down`（禁 `-v`，卷 `erp_db` 含正式库）。
2. 用发布前备份 `data/backups/heijin_erp_v1_<时间戳>.db` + `.sha256` 经 `restore_db.py` 恢复。
3. 切回 `v1.0.0` 对应镜像/提交并完成健康检查。数据库无需回退（本次无迁移变更）。

## V1.0.0

**发布时间：** 2026-10-27 18:57 CST（Asia/Shanghai）

| 项目 | 版本 / 标识 |
| --- | --- |
| 系统发布版本 | `V1.0.0` |
| 前端构建版本 | `1.0.0` |
| 后端 API 版本 | `1.0.0` |
| 数据库迁移基线 | Alembic `0001` |

### 本次内容

- 固化首个正式发布版本标识与前后端语义版本。
- 修复订单创建表单的单控件绑定及代分期末期金额提示。
- 加固部署：首次空数据卷跳过备份；健康检查失败会中止部署；管理员初始化读取 `deploy/.env`。

### 发布前检查

- 在测试环境执行后端与前端测试、数据库迁移一致性检查。
- 生产环境 `deploy/.env` 必须配置 `APP_ENV=production`、强随机 `JWT_SECRET_KEY`、正确的 `CORS_ORIGINS` 与 `ADMIN_PASSWORD`。
- 发布脚本会在已有数据库时创建备份，并在启动后访问 `/api/v1/health`。

### 回滚

1. 停止新版本容器。
2. 使用发布前生成的数据库备份及校验文件恢复数据。
3. 切回本标签前的已验证镜像/提交，并完成健康检查。
