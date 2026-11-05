"""测试目录搬迁后的仓库根解析。

背景：10 个测试文件用 ``Path(__file__).resolve().parents[2]`` 当仓库根。测试文件
下沉到 ``tests/backend/{unit,integration}/<区域>/`` 后层数变成 4，``parents[2]``
指向 ``tests/backend``，于是「读 deploy/scripts/harden_host.sh」「定位 frontend/src」
「import run_regression」全部错位。

写死层数只能撑到下一次搬家，故改为**向上找 pytest.ini**——它固定在仓库根，
且 pytest 本身就是靠它确定 rootdir 的。

本模块由 ``tests/backend/conftest.py`` 所在目录进入 sys.path（pytest 的 prepend
导入模式会插入 conftest 所在目录），故测试文件可直接 ``from _repo import REPO_ROOT``。
"""

from __future__ import annotations

from pathlib import Path


def repo_root() -> Path:
    here = Path(__file__).resolve()
    for candidate in (here, *here.parents):
        if (candidate / "pytest.ini").exists():
            return candidate
    raise RuntimeError("找不到仓库根：向上没有任何一层含 pytest.ini")


REPO_ROOT = repo_root()
BACKEND_DIR = REPO_ROOT / "backend"
FRONTEND_DIR = REPO_ROOT / "frontend"
TESTS_DIR = REPO_ROOT / "tests"
BE_TESTS = TESTS_DIR / "backend"
