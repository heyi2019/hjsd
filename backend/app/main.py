"""ERP v1 唯一 uvicorn 入口。

```bash
cd backend
PY=/Users/aries/Applications/Python_3.13/bin/python3
$PY -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

健康：GET /           健康检查：GET /api/v1/health
文档：/docs          业务接口统一前缀：/api/v1

业务规则唯一依据：docs/ERP_PRD_v1.0.md 等九份 v1.0 文档。
v1 之前的那套实现（旧 main / routers / models / models_new）已下线，
原样归档于 `archive/v0_backend/`，仅作 P2 历史迁移参考，不再被本入口挂载。
"""
from app.api_v1 import create_app

app = create_app()

__all__ = ["app", "create_app"]
