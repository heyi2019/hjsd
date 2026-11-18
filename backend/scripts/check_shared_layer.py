#!/usr/bin/env python3
"""shared 层防膨胀门禁：守住「只放真共享原语」这条四层模型命脉。

为什么需要：importlinter 契约②只挡住「shared 依赖业务域」（判据第 3 条），
但挡不住有人图省事把一个域的专属逻辑丢进 shared（判据第 1、2 条）。
一旦发生，shared 会退化成新的垃圾桶层，四层模型的价值归零。

两条检查：
1. 白名单：shared 顶层模块必须全部登记在 REGISTRY，新增模块需显式写明归位理由；
2. 引用闭包：每个模块必须被 ≥2 个业务域经「直接或传递」引用
   （用 AST 建 shared 内部依赖图求传递闭包，避免 form_field_value 这类
   被上层原语间接共用的二级模块被误报为死代码）。

退出码：0 通过 / 1 违规。零副作用、不连库、CI 可安全执行。
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
SHARED = BACKEND / "app" / "shared"
APP = BACKEND / "app"

# 归位理由简表：新增模块必须在此登记，否则门禁红。
REGISTRY: dict[str, str] = {
    "audit": "写路径审计留痕，被全部写域共用",
    "business_numbering": "业务编号发放，finance/installments/orders 共用",
    "form_field_rules": "表单字段校验规则，订单/资金/分期共用",
    "form_field_value": "单值校验纯函数，经 form_values/form_field_rules 间接服务多域",
    "form_values": "form_extra 读写，客户/库存/订单/资金/分期共用",
    "installment_amounts": "分期应收款口径，customer_center/installments 共用",
    "numbering": "通用编号序列发放，八域共用",
    "operation_operators": "操作人归并，客户/资金/分期/订单共用",
    "order_access": "订单只读访问，资金/分期/订单/分润共用",
    "order_amounts": "订单收入/支出/利润唯一权威，五六域共用",
    "scope": "数据范围判定，七域共用",
}

DOMAIN_PREFIXES = (
    "orders", "customer_center", "finance", "stocks", "installments",
    "field_definitions", "reporting", "workbench", "lists", "auth",
    "audit", "attachments", "options", "notifications", "profit_allocation",
)


def _imports_of(path: Path) -> tuple[set[str], set[str]]:
    """返回 (业务域集合, shared 内部模块集合)，用 AST 解析 import 语句。"""
    domains: set[str] = set()
    shared_mods: set[str] = set()
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return domains, shared_mods
    for node in ast.walk(tree):
        mod = ""
        if isinstance(node, ast.ImportFrom) and node.module:
            mod = node.module
        elif isinstance(node, ast.Import):
            mod = node.names[0].name if node.names else ""
        if not mod.startswith("app."):
            continue
        parts = mod.split(".")
        if len(parts) < 2:
            continue
        if parts[1] in DOMAIN_PREFIXES:
            domains.add(parts[1])
        elif parts[1] == "shared" and len(parts) >= 3:
            shared_mods.add(parts[2])
    return domains, shared_mods


def main() -> int:
    modules = {p.stem for p in SHARED.glob("*.py") if p.stem != "__init__"}
    errors: list[str] = []

    unregistered = sorted(modules - REGISTRY.keys())
    if unregistered:
        errors.append(f"未登记的 shared 模块（需在 REGISTRY 写明归位理由）：{unregistered}")
    stale = sorted(REGISTRY.keys() - modules)
    if stale:
        errors.append(f"REGISTRY 已登记但磁盘不存在（删模块须同步此表）：{stale}")

    domain_refs: dict[str, set[str]] = {m: set() for m in modules}
    internal: dict[str, set[str]] = {m: set() for m in modules}
    for path in APP.rglob("*.py"):
        rel = path.relative_to(APP)
        top = rel.parts[0]
        _, shared_imports = _imports_of(path)
        if top == "shared":
            if len(rel.parts) >= 2 and rel.stem != "__init__":
                internal[rel.stem] = shared_imports
            continue
        if top not in DOMAIN_PREFIXES:
            continue
        # 业务域文件直接 import 了哪些 shared 模块，就把该域记为这些模块的消费者。
        for target in shared_imports:
            if target in domain_refs:
                domain_refs[target].add(top)

    # 传递闭包：shared 模块 A 引用 B，则 A 的引用域也算 B 的间接消费者。
    # 例如 form_field_value 只被 form_values / form_field_rules 引用，
    # 但后两者被多域共用，故 form_field_value 也应继承这些域。
    # 域集合单调增长，最多 |modules|×|domains| 轮收敛；设上限防止逻辑错误时死循环。
    for _ in range(len(modules) * len(DOMAIN_PREFIXES)):
        changed = False
        for m in modules:
            for dep in internal.get(m, set()):
                if dep in domain_refs and not domain_refs[m].issubset(domain_refs[dep]):
                    domain_refs[dep].update(domain_refs[m])
                    changed = True
        if not changed:
            break

    for m in sorted(modules):
        refs = domain_refs[m]
        if len(refs) < 2:
            errors.append(f"shared.{m} 仅被 {len(refs)} 个业务域引用（{sorted(refs)}），不符「≥2 域共用」判据")

    if errors:
        print("shared 层门禁失败：")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(f"shared 层门禁通过：{len(modules)} 个模块全部登记，且均被 ≥2 个业务域引用")
    return 0


if __name__ == "__main__":
    sys.exit(main())
