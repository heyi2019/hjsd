"""BOOT-01 main 入口契约测试：uvicorn 唯一入口必须可导入且已挂载 v1 路由。"""
from __future__ import annotations


def test_main_app_is_ready():
    from app.main import app

    paths = {route.path for route in app.routes}
    assert "/api/v1/health" in paths
