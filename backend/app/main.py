"""ERP 唯一 uvicorn 入口。

```bash
cd backend
PY=/Users/aries/Applications/Python_3.13/bin/python3
$PY -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8123
```

健康：GET /           健康检查：GET /api/health
文档：/docs          业务接口统一前缀：/api

运行时契约以应用自身路由和响应模型为准。
"""
from app.api import create_app

app = create_app()

__all__ = ["app", "create_app"]
