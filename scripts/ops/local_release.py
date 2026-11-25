#!/usr/bin/env python3
"""本地 CI/CD：固定 dev 提交、完整检查并生成待审核发布包。"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
PY313 = "/Users/aries/Applications/Python_3.13/bin/python3"
SSH_TARGET = "heijin-prod"


def validate_candidate(branch: str, commit: str, remote: str, dirty: bool,
                       version: str, production_version: str) -> None:
    if branch != "dev":
        raise ValueError("仅允许从 dev 准备本地发布")
    if dirty:
        raise ValueError("工作区有未提交文件，无法保证测试与构建一致")
    if not re.fullmatch(r"[0-9a-f]{40}", commit) or commit != remote:
        raise ValueError("本地提交与远端 dev 不一致")
    pattern = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    if not re.fullmatch(pattern, version) or not re.fullmatch(pattern, production_version):
        raise ValueError("版本号必须是 x.y.z")
    if tuple(map(int, version.split("."))) <= tuple(map(int, production_version.split("."))):
        raise ValueError("候选版本必须高于线上版本，禁止覆盖或降级")


def validate_pending_record(text: str, version: str) -> None:
    heading = re.search(r"^## 版本发布记录\s*$", text, re.M)
    if not heading:
        raise ValueError("缺少待发布记录")
    tail = text[heading.end():]
    matches = list(re.finditer(rf"^### V{re.escape(version)}\s*$", tail, re.M))
    if len(matches) != 1:
        raise ValueError("待发布版本记录缺失或重复")
    start = matches[0].end()
    next_section = re.search(r"^#{2,3} ", tail[start:], re.M)
    section = tail[start:start + next_section.start()] if next_section else tail[start:]
    for field in ("发布日期", "发布时间", "发布状态"):
        if len(re.findall(rf"^\*\*{field}：\*\* 待发布\s*$", section, re.M)) != 1:
            raise ValueError("待发布版本记录不完整")
    details = re.search(r"^#### 本次更新内容\s*$([\s\S]*?)(?=^#{2,4} |\Z)", section, re.M)
    if not details or not re.search(r"^-\s+\S", details.group(1), re.M):
        raise ValueError("待发布记录缺少更新内容")


def call(args: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None,
         input_text: str | None = None, capture: bool = False) -> str:
    result = subprocess.run(args, cwd=cwd, env=env, input=input_text, text=True,
                            stdout=subprocess.PIPE if capture else None, check=True)
    return result.stdout.strip() if capture else ""


def git(*args: str) -> str:
    return call(["git", *args], capture=True)


def remote_state() -> dict[str, str]:
    script = r'''set -euo pipefail
cd /opt/heijin/deploy
version=$(tr -d '\r\n' < /opt/heijin/VERSION)
case "$version" in *[!0-9.]*|'') exit 1;; esac
backend=$(docker compose ps -q backend)
frontend=$(docker compose ps -q frontend)
test -n "$backend" && test -n "$frontend"
backend_image=$(docker inspect --format '{{.Image}}' "$backend")
frontend_image=$(docker inspect --format '{{.Image}}' "$frontend")
test "$(docker inspect --format '{{.State.Running}}' "$backend")" = true
test "$(docker inspect --format '{{.State.Running}}' "$frontend")" = true
test "$(docker image inspect --format '{{.Id}}' "heijin-backend:$version")" = "$backend_image"
test "$(docker image inspect --format '{{.Id}}' "heijin-frontend:$version")" = "$frontend_image"
test "$(docker image inspect --format '{{.Architecture}}' redis:7.4-alpine)" = amd64
test "$(docker compose exec -T rate-limit redis-cli ping </dev/null)" = PONG
curl -fsS --max-time 10 http://127.0.0.1/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("status")=="ok" and d.get("database_status")=="ok" and d.get("app_version")==sys.argv[1]' "$version"
printf '%s\n%s\n%s\n' "$version" "$backend_image" "$frontend_image"
'''
    lines = call(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", SSH_TARGET, "bash", "-s"],
                 input_text=script, capture=True).splitlines()
    if len(lines) != 3 or not all(re.fullmatch(r"sha256:[0-9a-f]{64}", x) for x in lines[1:]):
        raise ValueError("无法确认线上版本和可回滚镜像")
    return {"version": lines[0], "backend_image": lines[1], "frontend_image": lines[2]}


def candidate_state(production: dict[str, str]) -> tuple[str, str]:
    branch = git("branch", "--show-current")
    commit = git("rev-parse", "HEAD")
    remote_line = call(["git", "ls-remote", "--exit-code", "origin", "refs/heads/dev"], capture=True)
    remote = remote_line.split()[0]
    dirty = bool(git("status", "--porcelain", "--untracked-files=normal"))
    version = git("show", f"{commit}:VERSION").strip()
    validate_candidate(branch, commit, remote, dirty, version, production["version"])
    validate_pending_record(git("show", f"{commit}:docs/版本管理.md"), version)
    return commit, version


def gate_commands() -> list[tuple[str, Path, list[str]]]:
    backend = ROOT / "backend"
    frontend = ROOT / "frontend"
    venv = backend / ".venv" / "bin"
    return [
        ("测试依赖", ROOT, ["python3", "backend/scripts/setup_test_environment.py", "--check"]),
        ("后端静态检查", backend, [str(venv / "python3"), "run_regression.py", "lint"]),
        ("导入分层", backend, [str(venv / "lint-imports")]),
        ("共享层检查", backend, [str(venv / "python3"), "scripts/check_shared_layer.py"]),
        ("迁移基线", backend, ["bash", "scripts/check_baseline.sh"]),
        ("后端全量", backend, [PY313, "run_regression.py", "ci", "--backend-only"]),
        ("前端类型检查", frontend, ["npm", "run", "check"]),
        ("前端全量", frontend, ["npm", "run", "test:full:all"]),
        ("浏览器 E2E", frontend, ["npm", "run", "test:e2e", "--", "--workers=1"]),
        ("前端生产构建", frontend, ["npm", "run", "build"]),
    ]


def required_gates() -> list[str]:
    return ["依赖锁文件一致性", *[entry[0] for entry in gate_commands()],
            "线上结构恢复演练", "镜像架构和内容"]


def validate_bundle(directory: Path) -> dict:
    try:
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        version, commit = manifest["version"], manifest["commit"]
        production = manifest["production"]
        validate_candidate("dev", commit, commit, False, version, production["version"])
        for key in ("backend_image", "frontend_image"):
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", production[key]):
                raise ValueError("旧镜像标识无效")
        expected = [f"heijin-local-{part}:{version}-{commit[:12]}" for part in ("backend", "frontend")]
        if manifest["images"] != expected or manifest["gates"] != required_gates():
            raise ValueError("发布包缺少完整门禁或镜像标识不匹配")
        if not re.fullmatch(r"[0-9a-f]{64}", manifest["schema_sha256"]):
            raise ValueError("结构快照校验值无效")
        for name in ("images.tar.gz", "deployment.tar.gz"):
            checksum = manifest["sha256"][name]
            if not re.fullmatch(r"[0-9a-f]{64}", checksum) or sha256(directory / name) != checksum:
                raise ValueError(f"{name} 校验失败")
        with tarfile.open(directory / "deployment.tar.gz", "r:gz") as data:
            names = set()
            for member in data.getmembers():
                path = Path(member.name)
                allowed = member.name in {"VERSION", "deploy/docker-compose.yml", "deploy/scripts", "frontend/nginx.conf"} or member.name.startswith("deploy/scripts/")
                if (not allowed or ".." in path.parts or member.issym() or member.islnk()
                        or not (member.isfile() or member.isdir()) or path.name.startswith(".env")
                        or path.suffix in {".db", ".dump"} or "data" in path.parts or member.name in names):
                    raise ValueError("发布包包含不允许的文件")
                names.add(member.name)
            required = {"VERSION", "deploy/docker-compose.yml", "deploy/scripts/deploy.sh",
                        "deploy/scripts/backup_daily.sh", "frontend/nginx.conf"}
            if not required.issubset(names):
                raise ValueError("发布包缺少必需文件")
            version_file = data.extractfile("VERSION")
            if version_file is None or version_file.read().decode().strip() != version:
                raise ValueError("发布包中的版本不一致")
    except (KeyError, TypeError, OSError, UnicodeError, json.JSONDecodeError, tarfile.TarError) as exc:
        raise ValueError("发布包不完整或无法校验") from exc
    return manifest


def check_locks(env: dict[str, str]) -> None:
    """在临时目录重算两份锁文件，不覆盖工作区。"""
    tool = ROOT / "backend/.venv/bin/pip-compile"
    with tempfile.TemporaryDirectory(prefix="heijin-lockcheck-") as temp:
        root = Path(temp)
        (root / "backend").mkdir()
        for filename in ("requirements.txt", "requirements-dev.txt", "requirements.lock.txt", "requirements-dev.lock.txt"):
            shutil.copy2(ROOT / "backend" / filename, root / "backend" / filename)
        for args, output in (
            (["--no-emit-index-url", "--output-file=backend/requirements.lock.txt", "--strip-extras", "backend/requirements.txt"], "requirements.lock.txt"),
            (["--no-emit-index-url", "--allow-unsafe", "--constraint", "backend/requirements.lock.txt", "--output-file=backend/requirements-dev.lock.txt", "--strip-extras", "backend/requirements-dev.txt"], "requirements-dev.lock.txt"),
        ):
            call([str(tool), *args], cwd=root, env=env)
            if (root / "backend" / output).read_bytes() != (ROOT / "backend" / output).read_bytes():
                raise RuntimeError(f"{output} 与依赖声明不一致")


def schema_digest_bytes(data: bytes) -> str:
    normalized = b"\n".join(line for line in data.splitlines()
                             if not line.startswith((b"\\restrict ", b"\\unrestrict ")))
    return hashlib.sha256(normalized).hexdigest()


def production_schema_digest() -> str:
    command = '''cd /opt/heijin/deploy && docker compose exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s --no-owner --no-privileges' '''
    data = subprocess.check_output(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", SSH_TARGET, command])
    return schema_digest_bytes(data)


DRILL_SOURCE_PATHS = (
    "VERSION", "backend/Dockerfile", "backend/requirements.lock.txt", "backend/alembic.ini",
    "backend/app", "backend/alembic", "backend/scripts/ensure_idempotency_records.py",
    "backend/scripts/split_sale_form_scopes.py", "deploy/scripts/schema_diff.py",
)
DRILL_REQUIRED_FILES = {
    "VERSION", "backend/Dockerfile", "backend/requirements.lock.txt", "backend/alembic.ini",
    "backend/app/core/settings.py", "backend/alembic/env.py", "backend/scripts/ensure_idempotency_records.py",
    "backend/scripts/split_sale_form_scopes.py", "deploy/scripts/schema_diff.py",
}


def validate_drill_source_archive(archive: Path) -> None:
    """演练包只允许候选源码，拒绝密钥、数据、链接和越界路径。"""
    seen: set[str] = set()
    files: set[str] = set()
    with tarfile.open(archive, "r:") as data:
        for member in data.getmembers():
            name = member.name.rstrip("/")
            path = PurePosixPath(name)
            allowed = (name in DRILL_SOURCE_PATHS or name in {"backend", "backend/scripts", "deploy", "deploy/scripts"}
                       or name.startswith(("backend/app/", "backend/alembic/")))
            if (not allowed or path.is_absolute() or ".." in path.parts or name in seen
                    or member.issym() or member.islnk() or not (member.isfile() or member.isdir())
                    or any(part.startswith(".env") for part in path.parts)
                    or path.suffix in {".db", ".dump", ".sqlite", ".sqlite3"}
                    or "data" in path.parts):
                raise ValueError("演练源码包包含不允许的路径或文件")
            seen.add(name)
            if member.isfile():
                files.add(name)
    if not DRILL_REQUIRED_FILES.issubset(files):
        raise ValueError("演练源码包缺少必需文件")


def run_server_drill(commit: str) -> None:
    """仅上传候选源码；生产快照和临时库均留在服务器内。"""
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("无效的候选提交")
    token = secrets.token_hex(10)
    stage = f"/tmp/heijin-server-drill-{token}"
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", SSH_TARGET]
    script = subprocess.check_output(["git", "show", f"{commit}:scripts/ops/production_drill_remote.sh"], cwd=ROOT)
    with tempfile.TemporaryDirectory(prefix="heijin-drill-source-") as temp:
        archive = Path(temp) / "source.tar"
        with archive.open("wb") as stream:
            subprocess.run(["git", "archive", "--format=tar", commit, *DRILL_SOURCE_PATHS], cwd=ROOT, stdout=stream, check=True)
        validate_drill_source_archive(archive)
        checksum = sha256(archive)
        call([*ssh, "mkdir", "-m", "700", stage])
        started = False
        try:
            with archive.open("rb") as stream:
                subprocess.run([*ssh, f"umask 077; cat > {shlex.quote(stage + '/source.tar')}"], stdin=stream, check=True)
            subprocess.run([*ssh, f"umask 077; cat > {shlex.quote(stage + '/drill.sh')}"], input=script, check=True)
            started = True
            args = ["bash", stage + "/drill.sh", token, checksum]
            subprocess.run([*ssh, " ".join(map(shlex.quote, args))], stdin=subprocess.DEVNULL, check=True)
        finally:
            if not started:
                cleanup = f"test ! -L {shlex.quote(stage)} && rm -rf -- {shlex.quote(stage)}"
                subprocess.run([*ssh, cleanup], stdin=subprocess.DEVNULL, check=False)


def check_production_schema(env: dict[str, str]) -> str:
    """在服务器内恢复生产快照并演练候选迁移；不下载生产数据。"""
    del env
    before = production_schema_digest()
    run_server_drill(git("rev-parse", "HEAD"))
    after = production_schema_digest()
    if before != after:
        raise RuntimeError("线上数据库结构在演练期间发生变化")
    return after


def run_gates(commit: str, version: str) -> tuple[list[str], str]:
    base_env = dict(os.environ)
    for key in ("PYTHONPATH", "DATABASE_URL", "TEST_DATABASE_URL", "E2E_DATABASE_URL", "BASE_URL", "BASELINE_DB"):
        base_env.pop(key, None)
    base_env["TEST_REDIS_URL"] = "redis://127.0.0.1:6389/0"
    env = dict(base_env)
    env["PYTHONPATH"] = os.pathsep.join((str(ROOT / "dependencies/python313-runtime"), str(ROOT / "backend")))
    env["PYTHON"] = PY313
    env["BASELINE_DB"] = "heijin_erp_drill_" + secrets.token_hex(10)
    started = datetime.now(timezone.utc)
    reports = ROOT / "outputs" / "local-release" / "reports"
    reports.mkdir(parents=True, exist_ok=True, mode=0o700)
    run_dir = Path(tempfile.mkdtemp(prefix=f"{version}-{commit[:12]}-{started:%Y%m%dT%H%M%SZ}-", dir=reports))
    path = run_dir / "release-test-report.md"

    commands = gate_commands()
    gates = ["依赖锁文件一致性", *[entry[0] for entry in commands], "线上结构恢复演练"]
    completed: list[str] = []
    failed = gates[0]
    try:
        print(f"\n==> {failed}", flush=True)
        check_locks(base_env)
        completed.append(failed)
        for title, cwd, args in commands:
            failed = title
            print(f"\n==> {title}", flush=True)
            call(args, cwd=cwd, env=env if title in {"迁移基线", "后端全量"} else base_env)
            if git("rev-parse", "HEAD") != commit or git("status", "--porcelain", "--untracked-files=normal"):
                raise RuntimeError("门禁期间代码发生变化，发布中止")
            completed.append(title)
        failed = gates[-1]
        print(f"\n==> {failed}", flush=True)
        schema_digest = check_production_schema(env)
        if git("rev-parse", "HEAD") != commit or git("status", "--porcelain", "--untracked-files=normal"):
            raise RuntimeError("门禁期间代码发生变化，发布中止")
        completed.append(failed)
        failed = ""
        return completed, schema_digest
    finally:
        finished = datetime.now(timezone.utc)
        result = "失败" if failed else "通过"
        report = [
            "# ERP 发布前全量测试报告",
            "",
            "| 项目 | 内容 |",
            "| --- | --- |",
            f"| ERP 版本 | `{version}` |",
            f"| 候选提交 | `{commit}` |",
            "| 通道 | 本地发布 |",
            "| 范围 | 后端全量、前端全量、浏览器 E2E 及发布预检 |",
            f"| 开始时间 | {started.isoformat(timespec='seconds')} |",
            f"| 结束时间 | {finished.isoformat(timespec='seconds')} |",
            f"| 结果 | {result} |",
            "",
            "| 阶段 | 结果 |",
            "| --- | --- |",
        ]
        for gate in gates:
            status = "通过" if gate in completed else "失败" if gate == failed else "未执行"
            report.append(f"| {gate} | {status} |")
        path.write_text("\n".join(report) + "\n", encoding="utf-8")
        print(f"\n全量测试报告：{path}", flush=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_package(commit: str, version: str, production: dict[str, str], gates: list[str], schema_digest: str) -> Path:
    out_root = ROOT / "outputs" / "local-release"
    out_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    output = out_root / f"{version}-{commit[:12]}-{secrets.token_hex(4)}"
    output.mkdir(mode=0o700)
    with tempfile.TemporaryDirectory(prefix="heijin-release-") as temp:
        source = Path(temp) / "source"
        source.mkdir()
        archive = Path(temp) / "source.tar"
        with archive.open("wb") as stream:
            subprocess.run(["git", "archive", "--format=tar", commit], cwd=ROOT, stdout=stream, check=True)
        with tarfile.open(archive) as data:
            data.extractall(source, filter="data")
        tags = [f"heijin-local-{part}:{version}-{commit[:12]}" for part in ("backend", "frontend")]
        for part, tag in zip(("backend", "frontend"), tags):
            call(["docker", "buildx", "build", "--platform", "linux/amd64", "--load", "-t", tag,
                  "-f", str(source / part / "Dockerfile"), str(source)])
            arch = call(["docker", "image", "inspect", "--format", "{{.Architecture}}", tag], capture=True)
            if arch != "amd64":
                raise RuntimeError(f"{tag} 架构不是 amd64")
        backend_size = int(call(["docker", "image", "inspect", "--format", "{{.Size}}", tags[0]], capture=True))
        if backend_size > 34 * 1024 * 1024:
            raise RuntimeError("后端镜像超过云端门禁的 34 MiB 上限")
        inspect_script = r'''set -eu
sp="$(python3 -c 'import site; print(site.getsitepackages()[0])')"
test -d "$sp"
test "$(find "$sp" -name '*.pyc' | wc -l | tr -d ' ')" -eq 0
test "$(find "$sp" -maxdepth 1 \( -iname 'uvloop*' -o -iname 'httptools*' -o -iname 'watchfiles*' \) | wc -l | tr -d ' ')" -eq 0
! command -v strip >/dev/null 2>&1
'''
        call(["docker", "run", "--rm", "--network", "none", "--entrypoint", "sh", tags[0], "-c", inspect_script])
        images = output / "images.tar.gz"
        with images.open("wb") as dest:
            with gzip.GzipFile(fileobj=dest, mode="wb") as compressed:
                proc = subprocess.Popen(["docker", "save", *tags], stdout=subprocess.PIPE)
                assert proc.stdout is not None
                shutil.copyfileobj(proc.stdout, compressed)
                proc.stdout.close()
                if proc.wait() != 0:
                    raise RuntimeError("导出镜像失败")
        deployment = output / "deployment.tar.gz"
        with tarfile.open(deployment, "w:gz") as data:
            for name in ("VERSION", "deploy/docker-compose.yml", "deploy/scripts", "frontend/nginx.conf"):
                data.add(source / name, arcname=name)
        with tarfile.open(deployment, "r:gz") as data:
            for member in data.getmembers():
                path = Path(member.name)
                if (member.issym() or member.islnk() or ".." in path.parts or
                        path.name.startswith(".env") or path.suffix in {".db", ".dump"} or "data" in path.parts):
                    raise RuntimeError("发布包包含链接、敏感配置或数据文件，已中止")
        manifest = {
            "version": version, "commit": commit, "production": production,
            "created_at": datetime.now(timezone.utc).isoformat(), "gates": [*gates, "镜像架构和内容"],
            "images": tags, "schema_sha256": schema_digest,
            "sha256": {images.name: sha256(images), deployment.name: sha256(deployment)},
        }
        (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return output


def deploy_package(directory: Path, manifest: dict, production: dict[str, str]) -> None:
    commit, version = candidate_state(production)
    if (commit, version) != (manifest["commit"], manifest["version"]) or production != manifest["production"]:
        raise ValueError("发布包与当前候选提交或线上状态不一致")
    env = dict(os.environ)
    for key in ("PYTHONPATH", "DATABASE_URL", "TEST_DATABASE_URL", "E2E_DATABASE_URL", "BASE_URL"):
        env.pop(key, None)
    env["PYTHONPATH"] = os.pathsep.join((str(ROOT / "dependencies/python313-runtime"), str(ROOT / "backend")))
    print("==> 再次执行线上结构恢复演练", flush=True)
    schema_digest = check_production_schema(env)
    if schema_digest != manifest["schema_sha256"]:
        raise ValueError("线上数据库结构已变化，请重新运行本地门禁")
    if candidate_state(production) != (commit, version) or remote_state() != production:
        raise ValueError("候选提交或线上状态在演练期间发生变化")
    stage = call(["ssh", "-o", "BatchMode=yes", SSH_TARGET, "mktemp", "-d", "/tmp/heijin-local-cd.XXXXXXXXXX"], capture=True)
    if not re.fullmatch(r"/tmp/heijin-local-cd\.[A-Za-z0-9]{10}", stage):
        raise ValueError("服务器返回了不安全的临时目录")
    for name in ("images.tar.gz", "deployment.tar.gz"):
        print(f"==> 上传 {name}", flush=True)
        with (directory / name).open("rb") as stream:
            subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", SSH_TARGET,
                            f"umask 077; cat > {stage}/{name}"], stdin=stream, check=True)
    args = [stage, version, commit, production["version"], production["backend_image"],
            production["frontend_image"], manifest["sha256"]["images.tar.gz"],
            manifest["sha256"]["deployment.tar.gz"], schema_digest]
    command = "python3 - " + " ".join(shlex.quote(value) for value in args)
    script = subprocess.check_output(["git", "show", f"{commit}:scripts/ops/local_release_apply.py"], cwd=ROOT)
    print("==> 执行部署并核对健康状态", flush=True)
    subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", SSH_TARGET, command],
                   input=script, check=True)
    history = f"/opt/heijin/releases/local-{version}-{commit[:12]}/release.json"
    try:
        release = json.loads(call(["ssh", "-o", "BatchMode=yes", SSH_TARGET, "cat", history], capture=True))
    except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        raise RuntimeError("部署命令已完成，但服务器发布记录无法读取；请先检查线上状态") from exc
    if release.get("version") != version or release.get("commit") != commit:
        raise RuntimeError("服务已更新，但服务器发布记录无法核对；请先检查线上状态")
    try:
        call([sys.executable, "scripts/ops/record_release_published.py", version, "--at", release["published_at"]])
    except (subprocess.CalledProcessError, KeyError) as exc:
        raise RuntimeError("服务已更新，但本地发布记录写入失败；请先检查线上状态") from exc
    cleanup = f"import shutil; shutil.rmtree({stage!r})"
    try:
        call(["ssh", "-o", "BatchMode=yes", SSH_TARGET, "python3", "-c", shlex.quote(cleanup)])
    except subprocess.CalledProcessError:
        print(f"警告：发布已完成，临时目录未清理：{stage}", file=sys.stderr)
    print("本地发布记录已更新；请提交并同步版本记录。", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "prepare", "deploy"))
    parser.add_argument("bundle", nargs="?", type=Path, help="deploy 时指定 prepare 生成的目录")
    args = parser.parse_args()
    production = remote_state()
    if args.action == "deploy":
        if args.bundle is None:
            raise ValueError("deploy 需要指定本地发布包目录")
        manifest = validate_bundle(args.bundle.resolve())
        deploy_package(args.bundle.resolve(), manifest, production)
        return 0
    if args.bundle is not None:
        raise ValueError("仅 deploy 可以指定发布包")
    commit, version = candidate_state(production)
    print(f"线上版本: {production['version']}；候选版本: {version}；提交: {commit}", flush=True)
    if args.action == "check":
        print("候选版本与提交检查通过；尚未运行完整门禁，也未部署。")
        return 0
    gates, schema_digest = run_gates(commit, version)
    if remote_state() != production:
        raise RuntimeError("线上状态在检查期间发生变化，已中止")
    if candidate_state(production) != (commit, version):
        raise RuntimeError("候选提交发生变化，已中止")
    output = build_package(commit, version, production, gates, schema_digest)
    print(f"\n本地 CI 完成，待审核发布包：{output}\n尚未部署生产。")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError, subprocess.CalledProcessError, OSError) as exc:
        print(f"本地发布准备中止：{exc}", file=sys.stderr)
        raise SystemExit(1)
