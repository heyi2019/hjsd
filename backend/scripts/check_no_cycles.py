#!/usr/bin/env python3
"""全局无环门禁：检测模块顶层 import 形成的文件级强连通分量（真实运行时环）。

为什么只算顶层 import：项目用「函数内延迟 import」作为跨域解耦的既有手法
（如 business 通知触发点延迟 import workbench.notifications.triggers）。这类
导入发生在调用期、不会在模块加载期成环，若一并统计会把合法解耦误判为环。
因此本门禁只取 AST 模块 body 中的 import / ImportFrom，配合 Tarjan 求环。

与 .importlinter 的分工：后者锁「已声明的固定禁止边」，本脚本锁「全局无环」
这条原则本身——补上固定边清单覆盖不到的双向依赖盲区。

退出码：0 无环 / 1 存在环。零副作用、不连库、CI 可安全执行。
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"


def _module_to_file(module: str) -> Path | None:
    """把 app.x.y 解析为对应的 .py 或包 __init__.py。"""
    rel = Path(*module.split("."))
    candidate = APP / rel.with_suffix(".py")
    if candidate.exists():
        return candidate
    candidate = APP / rel / "__init__.py"
    return candidate if candidate.exists() else None


def _top_level_targets(path: Path) -> set[Path]:
    """返回该文件在模块顶层 import 的所有 app 内部目标文件。"""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return set()
    targets: set[Path] = set()
    for node in tree.body:  # 只看模块 body，函数/类内的延迟 import 不计
        modules: list[tuple[str | None, int]] = []
        if isinstance(node, ast.ImportFrom):
            modules.append((node.module, node.level))
        elif isinstance(node, ast.Import):
            modules.extend((alias.name, 0) for alias in node.names)
        else:
            continue
        for module, level in modules:
            if level == 0:
                if not module or not module.startswith("app."):
                    continue
                resolved = _module_to_file(module)
            else:
                # 相对导入：level=1 当前包，level=2 父包，依此类推
                parts = list(path.relative_to(APP).parts[:-1])
                if path.name == "__init__.py":
                    parts = parts[:-1]
                base = parts[: len(parts) - (level - 1)] if level > 1 else parts
                resolved = _module_to_file(".".join(["app", *base, *( [module] if module else [] )]))
            if resolved and resolved != path:
                targets.add(resolved)
    return targets


def main() -> int:
    graph: dict[Path, set[Path]] = {}
    for path in APP.rglob("*.py"):
        graph[path] = _top_level_targets(path)

    index = 0
    stack: list[Path] = []
    on_stack: set[Path] = set()
    ids: dict[Path, int] = {}
    low: dict[Path, int] = {}
    components: list[list[Path]] = []

    def strongconnect(vertex: Path) -> None:
        nonlocal index
        ids[vertex] = low[vertex] = index
        index += 1
        stack.append(vertex)
        on_stack.add(vertex)
        for neighbour in graph.get(vertex, ()):  # 未解析文件不在 graph 中，忽略
            if neighbour not in ids:
                strongconnect(neighbour)
                low[vertex] = min(low[vertex], low[neighbour])
            elif neighbour in on_stack:
                low[vertex] = min(low[vertex], ids[neighbour])
        if low[vertex] == ids[vertex]:
            component: list[Path] = []
            while True:
                item = stack.pop()
                on_stack.discard(item)
                component.append(item)
                if item == vertex:
                    break
            if len(component) > 1:
                components.append(component)

    for path in list(graph):
        if path not in ids:
            strongconnect(path)

    if components:
        print("全局无环门禁失败：发现模块顶层 import 形成的环：")
        for component in sorted(components, key=len, reverse=True):
            names = " -> ".join(str(p.relative_to(APP)) for p in sorted(component))
            print(f"  - {names}")
        return 1
    print(f"全局无环门禁通过：{len(graph)} 个文件，0 个顶层 import 环")
    return 0


if __name__ == "__main__":
    sys.exit(main())
