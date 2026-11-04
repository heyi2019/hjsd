"""系统发布版本的唯一事实源。

约定：
1. API 对外版本用 SemVer（如 `1.0.0`），**不带** `v` 前缀；`v1.0.0` 只作为 git tag / 发布标签。
2. 发版只改这一个文件，`Settings.app_version` 与 `/api/v1/health` 自动跟随，
   避免"代码里一处、tag 一处、部署配置一处"各自漂移。
3. 部署时可用环境变量 `APP_VERSION` 覆盖，用于回溯验证线上实际运行版本。
"""

from __future__ import annotations

__version__ = "1.0.3"

__all__ = ["__version__"]
