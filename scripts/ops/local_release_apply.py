#!/usr/bin/env python3
"""服务器端本地发布执行器：只接收已校验的独立发布包，不清库。"""
from __future__ import annotations

import argparse
import fcntl
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/opt/heijin")
DEPLOY = ROOT / "deploy"


def verify_source_archive(path: Path, version: str) -> None:
    required = {"VERSION", "deploy/docker-compose.yml", "deploy/scripts/deploy.sh",
                "deploy/scripts/backup_daily.sh", "frontend/nginx.conf"}
    with tarfile.open(path, "r:gz") as data:
        names = set()
        for member in data.getmembers():
            item = Path(member.name)
            allowed = member.name in {"VERSION", "deploy/docker-compose.yml", "deploy/scripts", "frontend/nginx.conf"} or member.name.startswith("deploy/scripts/")
            if (not allowed or ".." in item.parts or member.issym() or member.islnk()
                    or not (member.isfile() or member.isdir()) or item.name.startswith(".env")
                    or item.suffix in {".db", ".dump"} or "data" in item.parts or member.name in names):
                raise ValueError("发布包包含不允许的路径或文件")
            names.add(member.name)
        if not required.issubset(names):
            raise ValueError("发布包缺少必需文件")
        version_file = data.extractfile("VERSION")
        if version_file is None or version_file.read().decode().strip() != version:
            raise ValueError("发布包版本不一致")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def schema_digest_bytes(data: bytes) -> str:
    normalized = b"\n".join(line for line in data.splitlines()
                             if not line.startswith((b"\\restrict ", b"\\unrestrict ")))
    return hashlib.sha256(normalized).hexdigest()


def output(args: list[str], *, cwd: Path | None = None) -> str:
    return subprocess.check_output(args, cwd=cwd or DEPLOY, text=True).strip()


def run(args: list[str], *, cwd: Path | None = None, env: dict | None = None) -> None:
    subprocess.run(args, cwd=cwd or DEPLOY, env=env, check=True)


def install_files(archive: Path) -> None:
    with tarfile.open(archive, "r:gz") as data:
        for member in data.getmembers():
            target = ROOT / member.name
            if not target.resolve().is_relative_to(ROOT.resolve()) or target.is_symlink():
                raise ValueError("发布目标路径越界")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = data.extractfile(member)
            if source is None:
                raise ValueError("发布文件不可读取")
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as dest:
                temp = Path(dest.name)
                try:
                    shutil.copyfileobj(source, dest)
                    os.fchmod(dest.fileno(), member.mode & 0o777)
                except Exception:
                    temp.unlink(missing_ok=True)
                    raise
            os.replace(temp, target)


def update_env_version(version: str) -> None:
    path = DEPLOY / ".env"
    info = path.stat()
    original = path.read_text(encoding="utf-8")
    matches = list(re.finditer(r"^APP_VERSION=.*$", original, re.M))
    if len(matches) > 1:
        raise ValueError("生产配置存在重复 APP_VERSION")
    updated = re.sub(r"^APP_VERSION=.*$", f"APP_VERSION={version}", original, count=1, flags=re.M) if matches else original.rstrip("\n") + f"\nAPP_VERSION={version}\n"
    with tempfile.NamedTemporaryFile(mode="w", dir=DEPLOY, encoding="utf-8", delete=False) as dest:
        temp = Path(dest.name)
        try:
            os.fchmod(dest.fileno(), info.st_mode & 0o777)
            os.fchown(dest.fileno(), info.st_uid, info.st_gid)
            dest.write(updated)
        except Exception:
            temp.unlink(missing_ok=True)
            raise
    os.replace(temp, path)


def apply(stage: Path, version: str, commit: str, previous: str,
          backend_id: str, frontend_id: str, images_hash: str, source_hash: str, schema_hash: str) -> None:
    if (not re.fullmatch(r"/tmp/heijin-local-cd\.[A-Za-z0-9]{10}", str(stage))
            or stage.is_symlink() or stage.resolve().parent != Path("/tmp").resolve()):
        raise ValueError("临时目录不安全")
    semver = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    if (not re.fullmatch(semver, version) or not re.fullmatch(semver, previous)
            or tuple(map(int, version.split('.'))) <= tuple(map(int, previous.split('.')))
            or not re.fullmatch(r"[0-9a-f]{40}", commit)):
        raise ValueError("版本或提交无效")
    if not all(re.fullmatch(r"sha256:[0-9a-f]{64}", x) for x in (backend_id, frontend_id)):
        raise ValueError("原镜像标识无效")
    if not all(re.fullmatch(r"[0-9a-f]{64}", x) for x in (images_hash, source_hash, schema_hash)):
        raise ValueError("发布包校验值无效")
    images, source = stage / "images.tar.gz", stage / "deployment.tar.gz"
    if sha256(images) != images_hash or sha256(source) != source_hash:
        raise ValueError("发布包校验失败")
    verify_source_archive(source, version)
    with (DEPLOY / ".local-cd.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (ROOT / "VERSION").read_text().strip() != previous:
            raise ValueError("线上版本已变化")
        for service, image_id in (("backend", backend_id), ("frontend", frontend_id)):
            cid = output(["docker", "compose", "ps", "-q", service])
            if not cid or output(["docker", "inspect", "--format", "{{.Image}}", cid]) != image_id:
                raise ValueError("线上运行镜像已变化")
            if output(["docker", "inspect", "--format", "{{.State.Running}}", cid]) != "true":
                raise ValueError("线上服务未在运行")
            if output(["docker", "image", "inspect", "--format", "{{.Id}}", f"heijin-{service}:{previous}"]) != image_id:
                raise ValueError("旧版回滚镜像不存在")
            if subprocess.run(["docker", "image", "inspect", f"heijin-{service}:{version}"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                raise ValueError("新版本镜像标签已存在，拒绝覆盖")
        if output(["docker", "image", "inspect", "--format", "{{.Architecture}}", "redis:7.4-alpine"]) != "amd64":
            raise ValueError("线上 Redis 镜像架构不正确")
        health = json.loads(output(["curl", "-fsS", "--max-time", "10", "http://127.0.0.1/api/health"]))
        if health.get("status") != "ok" or health.get("database_status") != "ok" or health.get("app_version") != previous:
            raise ValueError("线上健康或版本状态不符合预期")
        schema = subprocess.check_output(["docker", "compose", "exec", "-T", "db", "sh", "-c",
                                          'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s --no-owner --no-privileges'], cwd=DEPLOY)
        if schema_digest_bytes(schema) != schema_hash:
            raise ValueError("线上数据库结构在演练后发生变化")
        print("==> 发布前备份", flush=True)
        run(["bash", "scripts/backup_daily.sh"])
        history_root = ROOT / "releases"
        history_root.mkdir(mode=0o700, exist_ok=True)
        history = history_root / f"local-{version}-{commit[:12]}"
        history.mkdir(mode=0o700)
        snapshot = history / "previous-config.tar.gz"
        with tarfile.open(snapshot, "w:gz") as data:
            for name in ("VERSION", "deploy/docker-compose.yml", "deploy/scripts", "frontend/nginx.conf"):
                data.add(ROOT / name, arcname=name)
        verify_source_archive(snapshot, previous)
        shutil.copy2(DEPLOY / ".env", history / "previous.env")
        os.chmod(history / "previous.env", 0o600)
        with gzip.open(images, "rb") as stream:
            proc = subprocess.Popen(["docker", "load"], stdin=subprocess.PIPE)
            assert proc.stdin is not None
            try:
                shutil.copyfileobj(stream, proc.stdin)
            finally:
                proc.stdin.close()
            if proc.wait() != 0:
                raise RuntimeError("导入镜像失败")
        for service in ("backend", "frontend"):
            candidate = f"heijin-local-{service}:{version}-{commit[:12]}"
            if output(["docker", "image", "inspect", "--format", "{{.Architecture}}", candidate]) != "amd64":
                raise ValueError("候选镜像架构不正确")
            run(["docker", "tag", candidate, f"heijin-{service}:{version}"])
        try:
            install_files(source)
            print("==> 执行原地增量部署", flush=True)
            run(["bash", "scripts/deploy.sh"], env={**os.environ, "ERP_SKIP_BUILD": "1", "APP_VERSION": version})
            health = json.loads(output(["curl", "-fsS", "--max-time", "10", "http://127.0.0.1/api/health"]))
            if health.get("status") != "ok" or health.get("database_status") != "ok" or health.get("app_version") != version:
                raise RuntimeError("部署后的健康状态或版本不匹配")
            if output(["docker", "compose", "exec", "-T", "rate-limit", "redis-cli", "ping"]) != "PONG":
                raise RuntimeError("部署后限流 Redis 未就绪")
            running = set(output(["docker", "compose", "ps", "--status", "running", "--services"]).splitlines())
            if not {"backend", "frontend", "db", "rate-limit"}.issubset(running):
                raise RuntimeError("部署后服务未全部运行")
        except Exception:
            print(f"部署失败；容器或配置可能已变化，已保留现场和备份，请先检查后再回滚：{history}", file=sys.stderr)
            raise
        try:
            update_env_version(version)
        except Exception:
            print("服务已更新，但版本配置写入失败；请勿重启，先检查生产配置。", file=sys.stderr)
            raise
        record = {"version": version, "commit": commit, "previous_version": previous,
                  "previous_backend_image": backend_id, "previous_frontend_image": frontend_id,
                  "published_at": datetime.now(timezone.utc).isoformat()}
        (history / "release.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
        print(f"部署和健康检查完成；记录与回滚配置：{history}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("stage", "version", "commit", "previous", "backend_id", "frontend_id", "images_hash", "source_hash", "schema_hash"):
        parser.add_argument(name)
    args = parser.parse_args()
    try:
        apply(Path(args.stage), args.version, args.commit, args.previous, args.backend_id,
              args.frontend_id, args.images_hash, args.source_hash, args.schema_hash)
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError, tarfile.TarError) as exc:
        print(f"本地部署失败：{exc}", file=sys.stderr)
        raise SystemExit(1)
