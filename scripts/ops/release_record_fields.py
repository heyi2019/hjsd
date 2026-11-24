"""候选提交的迁移编号与待发布章节组件版本字段。"""
from __future__ import annotations

import ast
from configparser import ConfigParser, Error as ConfigError
from pathlib import PurePosixPath
import re
import subprocess


def candidate_migration_revision(commit: str) -> str:
    """从候选提交的 Alembic 配置与活动基线读取 revision，无需连接数据库。"""
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], check=True, capture_output=True, encoding="utf-8",
        ).stdout

    try:
        config = ConfigParser(defaults={"here": "backend"})
        config.read_string(git("show", f"{commit}:backend/alembic.ini"))
        location = config.get("alembic", "version_locations")
        active = PurePosixPath(location)
        if not location or active.is_absolute() or ".." in active.parts:
            raise ValueError("Alembic 活动迁移目录须位于仓库内")

        names = git("ls-tree", "-z", "--name-only", f"{commit}:{active}").split("\0")
        files = [name for name in names if name.endswith(".py") and not name.startswith("_")]
        if len(files) != 1:
            raise ValueError("Alembic 活动迁移目录须只有一份基线")

        tree = ast.parse(git("show", f"{commit}:{active / files[0]}"))
        revisions = []
        for node in tree.body:
            if isinstance(node, ast.Assign):
                targets = node.targets
            elif isinstance(node, ast.AnnAssign):
                targets = [node.target]
            else:
                continue
            if any(isinstance(target, ast.Name) and target.id == "revision" for target in targets):
                revisions.append(ast.literal_eval(node.value))
        if len(revisions) != 1 or not isinstance(revisions[0], str) or not re.fullmatch(r"[A-Za-z0-9_-]+", revisions[0]):
            raise ValueError("Alembic 基线须声明有效的 revision")
        return revisions[0]
    except (ConfigError, OSError, subprocess.CalledProcessError, SyntaxError, ValueError) as exc:
        raise SystemExit(f"✗ 无法从候选提交 {commit} 读取数据库迁移编号：{exc}") from exc


def with_release_component_versions(section: str, version: str, revision: str) -> str:
    """刷新待发布章节的组件版本，保留业务更新内容。"""
    versions = {
        "前端版本": f"V{version}",
        "后端版本": f"V{version}",
        "数据库迁移编号": f"`{revision}`",
    }
    metadata, separator, details = section.partition("\n#### ")
    names = "|".join(map(re.escape, versions))
    metadata = re.sub(rf"^\*\*(?:{names})：\*\*[^\n]*\n\n?", "", metadata, flags=re.M)
    block = "\n\n".join(f"**{name}：** {value}" for name, value in versions.items())
    metadata = re.sub(
        r"^\*\*发布日期：\*\* 待发布[^\S\n]*$",
        lambda date: f"{block}\n\n{date[0]}", metadata, count=1, flags=re.M,
    )
    return metadata + separator + details
