"""准备本机隔离测试依赖及独立 Redis；不修改共享 Python 环境。"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / "backend/requirements.lock.txt"
DEV_LOCK = ROOT / "backend/requirements-dev.lock.txt"
RUNTIME = ROOT / "dependencies/python313-runtime"
PYTHON = Path("/Users/aries/Applications/Python_3.13/bin/python3")
REDIS_NAME = "heijin-test-redis"


def runtime_mismatches(lock: Path, runtime: Path) -> list[str]:
    """只检查隔离目录内的锁定包，不读取共享 site-packages。"""
    installed: dict[str, set[str]] = {}
    for dist in importlib.metadata.distributions(path=[str(runtime)]):
        name = dist.metadata.get("Name")
        if name:
            key = re.sub(r"[-_.]+", "-", name).lower()
            installed.setdefault(key, set()).add(dist.version)
    mismatches = []
    for line in lock.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([^ ;]+)", line.strip())
        if not match:
            continue
        name, wanted = match.groups()
        versions = installed.get(re.sub(r"[-_.]+", "-", name).lower(), set())
        if versions != {wanted}:
            actual = ", ".join(sorted(versions)) if versions else "未安装"
            mismatches.append(f"{name}: {actual} != {wanted}")
    return mismatches


def prepare_runtime() -> None:
    mismatches = runtime_mismatches(LOCK, RUNTIME) + runtime_mismatches(DEV_LOCK, RUNTIME)
    if not mismatches:
        print("Python 测试依赖已与锁文件一致")
        return
    if not PYTHON.is_file():
        raise RuntimeError(f"缺少指定 Python: {PYTHON}")
    if RUNTIME.is_symlink():
        raise RuntimeError(f"拒绝覆盖链接形式的依赖目录: {RUNTIME}")
    RUNTIME.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".python313-runtime-", dir=RUNTIME.parent))
    staging = temporary / "runtime"
    installer = temporary / "installer"
    previous = RUNTIME.parent / ".python313-runtime-previous"
    if previous.exists():
        shutil.rmtree(temporary)
        raise RuntimeError(f"存在上次保留的依赖目录，请先检查: {previous}")
    try:
        subprocess.run([str(PYTHON), "-I", "-m", "venv", str(installer)], check=True)
        subprocess.run([str(installer / "bin/python"), "-I", "-m", "pip", "install", "--ignore-installed", "--target", str(staging), "-r", str(LOCK), "-r", str(DEV_LOCK)], check=True)
        remaining = runtime_mismatches(LOCK, staging) + runtime_mismatches(DEV_LOCK, staging)
        if remaining:
            raise RuntimeError("新依赖与锁文件不一致: " + "; ".join(remaining))
        if RUNTIME.exists():
            RUNTIME.rename(previous)
        try:
            staging.rename(RUNTIME)
        except Exception:
            if previous.exists():
                previous.rename(RUNTIME)
            raise
        if previous.exists():
            shutil.rmtree(previous)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    print("Python 测试依赖已更新")


def ensure_redis() -> None:
    result = subprocess.run(["docker", "container", "inspect", REDIS_NAME], capture_output=True, text=True)
    if result.returncode:
        subprocess.run(["docker", "run", "-d", "--name", REDIS_NAME, "--restart", "unless-stopped", "-p", "127.0.0.1:6389:6379", "redis:7-alpine", "redis-server", "--save", "", "--appendonly", "no"], check=True)
    else:
        info = json.loads(result.stdout)[0]
        ports = info["HostConfig"].get("PortBindings") or {}
        expected = [{"HostIp": "127.0.0.1", "HostPort": "6389"}]
        if info["Config"].get("Image") != "redis:7-alpine" or ports.get("6379/tcp") != expected:
            raise RuntimeError(f"{REDIS_NAME} 不是预期的独立本机 Redis，拒绝修改")
        if not info["State"]["Running"]:
            subprocess.run(["docker", "start", REDIS_NAME], check=True)
    subprocess.run(["docker", "exec", REDIS_NAME, "redis-cli", "ping"], check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="准备本机 Python 3.13 测试依赖和独立 Redis")
    parser.add_argument("--check", action="store_true", help="只检查依赖与锁文件是否一致")
    args = parser.parse_args()
    if args.check:
        mismatches = runtime_mismatches(LOCK, RUNTIME) + runtime_mismatches(DEV_LOCK, RUNTIME)
        if mismatches:
            raise SystemExit("测试依赖不一致，请运行 python3 backend/scripts/setup_test_environment.py：\n" + "\n".join(mismatches))
        print("Python 测试依赖与锁文件一致")
        return
    prepare_runtime()
    ensure_redis()


if __name__ == "__main__":
    main()
