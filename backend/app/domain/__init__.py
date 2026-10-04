"""domain：v1 领域模型包。

与 legacy `app.models`（v0 单文件模型）物理隔离：
包名不叫 `models` 是为了避免与 `app/models.py` 同名冲突，
旧库、旧路由在迁移完成前不得引用本包。
"""
