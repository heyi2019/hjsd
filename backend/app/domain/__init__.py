"""domain：v1 领域模型包。"""
from app.domain import options  # 副作用导入：把 option_sets 模型注册进 Base.metadata

# pyflakes 不认 `# noqa`，故用 __all__ 声明这是有意对外公开的副作用注册。
# 删除前请确认：alembic/env.py 已显式补 Derived 模型的注册路径，
# 且没有代码走 `app.domain.options.X` 这种包级属性访问。
__all__ = ["options"]
