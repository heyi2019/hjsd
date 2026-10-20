"""一次性修复 pools/FundsPage.tsx 的交互缺陷（原子替换 + 断言）。

覆盖：P0-3 写操作无 loading/防重、P0-4 Modal 内错误不可见、
P0-5 破坏性操作无确认、P0-6 金额裸 Input、P0-7 流水硬截断无提示。

要点：每步都是**独立、非跨函数**的替换。此前用 `try { ... } catch` 的一次性跨行匹配
会把相邻函数体一起吃掉，已改成分开替换并靠函数名定位，避免再次错位。

用法：python3 scripts/fix_funds_page.py           # dry-run
      python3 scripts/fix_funds_page.py --apply    # 写入
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
    mark = "ok  " if n == expect else "WARN"
    if n != expect:
        problems.append(f"{name}: expected {expect}, got {n}")
    print(f"{mark} {name}: {n}")


# 1) imports
sub(
    r"import \{\n  DataTable,\n  ErrorBanner,\n  MoneyText,\n  PermissionButton,\n  StatRow,\n  StatusTag,\n\} from \"\.\./shared/ui\";",
    'import {\n  ConfirmButton,\n  DataTable,\n  ErrorBanner,\n  InlineError,\n  MoneyInput,\n  MoneyText,\n  PermissionButton,\n  StatRow,\n  StatusTag,\n} from "../shared/ui";\n'
    'import { useAsyncAction } from "../shared/hooks/useAsyncAction";\n'
    'import { requiredMoneyRules } from "../shared/lib/validators";',
    1,
    "imports",
)

# 2) 声明统一写操作
sub(
    r"  const \[error, setError\] = useState<\{ message: string; code\?: string \} \| null>\(null\);",
    "  const [error, setError] = useState<{ message: string; code?: string } | null>(null);\n"
    "  // 弹窗不会同时打开，故全部写操作共用一个 pending/error 即可覆盖。\n"
    "  const write = useAsyncAction();",
    1,
    "declare action",
)

# 3a) 只给写操作函数（submit*/review*/reverse*/resolve*）的 try 换成 action.run。
#     靠函数名定位，避免误伤带 finally 的 load()。
sub(
    # 部分函数在 try 前还有 guard（如 `if (!returnTarget) return;`），故允许中间隔若干行。
    r"(  const (?:submit|review|reverse|resolve)\w* = async [^\n]*\n)((?:    [^\n]*\n)*?)    try \{\n",
    r"\1\2    await write.run(async () => {\n",
    11,
    "open action.run",
)

# 3b) 对应收口：无 finally 的 catch → 关闭 action.run
sub(
    r"    \} catch \(err\) \{\n      setError\(normalizeError\(err\)\);\n    \}\n",
    "    });\n",
    11,
    "close action.run",
)

# 4) 每个 Modal 的提交按钮补 loading
sub(
    r'(<PermissionButton permission="[a-z.]+" type="primary" htmlType="submit")>',
    r"\1 loading={write.pending}>",
    11,
    "submit loading",
)

# 5) 每个 Modal 内放进错误提示（此前错误只落页面顶部，被遮罩挡住）
def inline_error(m):
    nl, indent, form = m.group(1), m.group(2), m.group(3)
    return (
        f"{nl}{indent}<InlineError error={{write.error}} />"
        f"{nl}{indent}  <Form form={{{form}}} layout=\"vertical\""
    )


sub(
    r'(\n)(\s*)<Form form=\{(\w+)\} layout="vertical"',
    inline_error,
    11,
    "inline error",
)

# 6) 金额字段：必填 + 数字/两位小数/非负校验，并换成 MoneyInput
def money_field(m):
    body = m.group(3).replace("<Input />", "<MoneyInput />")
    return f'{m.group(1)}rules={{requiredMoneyRules("{m.group(2)}")}}>' + body + "</Form.Item>"


sub(
    r'(<Form\.Item name="(?:amount|statement_balance)" label="([^"]+)" )rules=\{\[\{ required: true \}\]\}>(.*?)</Form\.Item>',
    money_field,
    6,
    "money field",
    flags=re.S,
)

# 7) 流水审核：一键过账 → 二次确认（含后果说明）
sub(
    r'          \{row\.status === "PENDING" && \(\n'
    r'            <PermissionButton permission="deposit\.post" size="small" onClick=\{\(\) => void reviewCashflow\("approve", row\)\}>\n'
    r'              审核\n'
    r'            </PermissionButton>\n'
    r'          \)\}',
    '          {row.status === "PENDING" && (\n'
    '            <ConfirmButton\n'
    '              permission="deposit.post"\n'
    '              size="small"\n'
    '              title="审核通过这笔流水"\n'
    '              description="审核后流水计入损益且不可撤销。如金额有误，请先冲销或拒绝。"\n'
    '              okText="确认审核"\n'
    '              onConfirm={() => reviewCashflow("approve", row)}\n'
    '            >\n'
    '              审核\n'
    '            </ConfirmButton>\n'
    '          )}',
    1,
    "approve confirm",
)

# 8) 流水硬截断 500 条：明示上限
def limit_notice(m):
    _, indent = m.group(1), m.group(2)
    return (
        m.group(0)
        + "\n"
        + indent
        + '{cashflows.length >= 500 ? (\n'
        + indent
        + '  <Typography.Text type="warning">流水仅加载最近 500 条，请用日期区间缩小范围以查看更早数据。</Typography.Text>\n'
        + indent
        + ") : null}"
    )


sub(
    r'(<Input aria-label="流水结束日期" value=\{cashflowTo\} placeholder="结束日期" onChange=\{\(event\) => setCashflowTo\(event\.target\.value\)\} />\n(\s*)</div>)',
    limit_notice,
    1,
    "cashflow limit notice",
)

if src == orig:
    print("FAIL: no change at all")
    sys.exit(1)

if problems:
    print("\n=== 命中数与预期不一致，未写入 ===")
    for item in problems:
        print(" -", item)
    sys.exit(1)

if APPLY:
    P.write_text(src, encoding="utf-8")
    print("\nwritten", P)
else:
    print("\n(dry-run) 未写入。确认无误后加 --apply")
