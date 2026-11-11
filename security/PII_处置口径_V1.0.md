# PII 处置口径 V1.0

| 项 | 内容 |
|---|---|
| 文件编号 | `security/PII_处置口径_V1.0` |
| 运行域 | 工作经营 · 宜游轩ERP 仓库安全 |
| 阅读对象 | 仓库 owner、协作者、接手运维人员 |
| 编写日期 | 2026-10-28 |
| 编写人 | 何一（AI 协助起草，待 owner 确认） |

## 一、结论（口径先行）

1. **`rawdata/原始数据/*.json` 保留在仓库内**，作为 v1 迁移的可复现源数据，不因含 PII 而移出。
2. **仓库必须保持 private**。这是本口径成立的前提；一旦转公开或对外分享，必须先执行第五节的"转公开前置动作"。
3. **PII 只许进数据文件，不许进代码、测试固件新增文件、文档正文、日志**。
4. **靠门禁拦新增，不靠人记**：`backend/scripts/scan_pii.py` 已接入 CI（`lint-gate` 的 `pii` job），只拦 `security/pii_allowlist.txt` 之外的命中。

## 二、事实依据（可复验）

| 事实 | 核验方式 |
|---|---|
| 远程仓库为 private | `gh repo view heyi2019/hjsd --json visibility` → `PRIVATE` |
| `rawdata` 是迁移源数据，非临时产物 | `backend/scripts/land_raw_import.py:42` 以 `rawdata/原始数据` 为 `SOURCE_DIR`；`README.md` 列为只读源 JSON。重新导出覆盖后需重跑迁移脚本，历史迁移报告已清退、需要时从 git 历史追溯 |
| PII 集中在 2 个数据文件 | `backend/scripts/scan_pii.py --all` → 真实号码仅命中 `sheet16_accounts.json`、`sheet17_installments.json` |
| 其余命中均为合成占位值 | 同上，测试/文档中为 `138****0000` 一类占位号，已在白名单分组登记 |
| 无身份证/银行卡/密钥特征命中 | 同上，`id_card` / `bank_card` / `secret_key` / `private_key` 规则零命中 |

## 三、分层处置

### 允许
- `rawdata/原始数据/` 下的金山文档导出 JSON（含游戏账号绑定手机号）。
- 测试代码与文档中的**合成占位号码**（不可使用真实客户号码）。
- `game_password` 明文——本项为 owner 既定裁决（不加密），不在本口径约束范围内，但同样禁止外泄。

### 禁止
- 在 `.py` / `.ts` / `.tsx` 源码、配置文件、日志、提交信息中写入真实手机号、身份证、银行卡、密钥。
- 把真实客户数据复制进测试固件（需脱敏或用占位值）。
- 将仓库改为 public，或将仓库内容打包外发。

## 四、门禁机制（已落地）

```bash
# 门禁模式（CI 使用）：仅报白名单外命中，有则 exit 1
python backend/scripts/scan_pii.py

# 审计模式：连白名单内一起报，用于定期复核数据量变化
python backend/scripts/scan_pii.py --all

# 登记新命中（必须人工复核 diff，只登记业务上确属必要的条目）
python backend/scripts/scan_pii.py --update-allowlist
```

设计要点：
- **白名单按「路径 :: 规则名」登记，不含行号**——数据文件重新导出、行号漂移不会误报，也无需频繁改清单。
- **输出脱敏**——只报文件、行号、规则名、条数，绝不回显原始值，避免 CI 日志成为二次泄露渠道。
- **扫描范围含未跟踪文件**——新文件在 `git add` 之前就能被本地发现。
- **死条目提示**——白名单指向已删除/改名的路径时会提示清理（不阻断）。

## 五、转公开前置动作（触发即执行，勿跳过）

若仓库需要转 public、对外演示、或交给外部团队：

1. 将 `rawdata/原始数据/` 移出仓库并加 `.gitignore`（同时更新 `backend/scripts/land_raw_import.py` 的 `SOURCE_DIR` 指向外部路径）。
2. **清理 Git 历史中的 PII**（`git filter-repo --path rawdata/原始数据 --invert-paths`，需所有协作者重新克隆；不可逆，执行前先整仓备份）。
3. 用 `python backend/scripts/scan_pii.py --all` 复核为零真实命中后，方可切换可见性。

> 仅删工作区文件而不清历史 = 未处置。历史仍可取回。

## 六、复核节奏

| 频率 | 动作 |
|---|---|
| 每次 `rawdata` 重新导出 | `scan_pii.py --all` 看命中总量是否合理增长；不需要改白名单 |
| 每季度 | 核对白名单每条是否仍必要；清理死条目 |
| 仓库可见性变更前 | 执行第五节全部三步 |

## 版本记录

| 版本 | 日期 | 变更 |
|---|---|---|
| V1.0 | 2026-10-28 | 首版：确立"rawdata 保留 + 仓库私有 + 门禁拦新增"口径，落地 `scan_pii.py` 并接入 CI |
