"""修 FundsPage 写操作闭包内的 TS narrowing 失效。

把写操作包进 `write.run(async () => ...)` 后，外部 state（returnTarget/lossTarget/...）
在嵌套闭包里不再保留 `if (!x) return;` 的收窄，TS 报 `string | null | undefined`。
解法：guard 之后先把 id 取成局部 const，闭包内用局部变量。

用法：python3 scripts/fix_funds_closure.py [--apply]
"""
import pathlib
import re
import sys

APPLY = "--apply" in sys.argv
P = pathlib.Path("src/pools/FundsPage.tsx")
src = P.read_text(encoding="utf-8")
orig = src
problems = []


def sub(pattern: str, repl, expect: int, name: str, flags=0):
    global src
    src, n = re.subn(pattern, repl, src, flags=flags)
    if n != expect:
        problems.append(f"{name}: expected {expect}, got {n}")
    print(f"{'ok  ' if n == expect else 'WARN'} {name}: {n}")


# 每个写操作：guard 之后取出局部 id，闭包内改用它
sub(
    r"    if \(!returnTarget\) return;\n(    await write\.run\(async \(\) => \{\n      await depositsApi\.release\()returnTarget\.id(,)",
    r"    if (!returnTarget) return;\n    const targetId = returnTarget.id;\n\1targetId\2",
    1,
    "submitReturn",
)
sub(
    r"    if \(!lossTarget\) return;\n(    await write\.run\(async \(\) => \{\n      await depositsApi\.loss\()lossTarget\.id(,)",
    r"    if (!lossTarget) return;\n    const targetId = lossTarget.id;\n\1targetId\2",
    1,
    "submitLoss",
)
sub(
    r"    if \(!reverseTarget\) return;\n(    await write\.run\(async \(\) => \{\n      await cashflowsApi\.reverse\()reverseTarget\.id(,)",
    r"    if (!reverseTarget) return;\n    const targetId = reverseTarget.id;\n\1targetId\2",
    1,
    "reverseCashflow",
)
sub(
    r"    if \(!repairTarget\?\.transfer_id\) return;\n(    await write\.run\(async \(\) => \{\n      await transfersApi\.repair\()repairTarget\.transfer_id(,)",
    r"    if (!repairTarget?.transfer_id) return;\n    const targetId = repairTarget.transfer_id;\n\1targetId\2",
    1,
    "submitRepair",
)
sub(
    r"    if \(!resolveTarget\) return;\n(    await write\.run\(async \(\) => \{\n      await reconciliationsApi\.resolve\()resolveTarget\.id(,)",
    r"    if (!resolveTarget) return;\n    const targetId = resolveTarget.id;\n\1targetId\2",
    1,
    "resolveReconciliation",
)

if src == orig:
    print("FAIL: no change")
    sys.exit(1)
if problems:
    print("\n=== 未写入 ===")
    for item in problems:
        print(" -", item)
    sys.exit(1)
if APPLY:
    P.write_text(src, encoding="utf-8")
    print("written", P)
else:
    print("(dry-run)")
