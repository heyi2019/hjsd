"""修复 rebates/RebatesPanel.tsx 交互缺陷（原子替换 + 断言）。

覆盖：写操作无 loading/防重、Modal 内错误被遮罩挡住、
到账金额/手续费裸 Input、返点比例无 0–100 校验、弹窗残留上次输入。

用法：python3 scripts/fix_rebates.py [--apply]
"""
import pathlib
import re
import sys

APPLY = "--apply" in sys.argv
P = pathlib.Path("src/rebates/RebatesPanel.tsx")
src = P.read_text(encoding="utf-8")
orig = src
problems = []


def sub(pattern: str, repl, expect: int, name: str, flags=0):
    global src
    src, n = re.subn(pattern, repl, src, flags=flags)
    if n != expect:
        problems.append(f"{name}: expected {expect}, got {n}")
    print(f"{'ok  ' if n == expect else 'WARN'} {name}: {n}")


# 1) imports
sub(
    r"import \{\n  DataTable,\n  ErrorBanner,\n  MoneyInput,\n  MoneyText,\n  PermissionButton,\n  StatRow,\n  StatusTag,\n\} from \"\.\./shared/ui\";",
    'import {\n  DataTable,\n  ErrorBanner,\n  InlineError,\n  MoneyInput,\n  MoneyText,\n  PermissionButton,\n  StatRow,\n  StatusTag,\n} from "../shared/ui";\n'
    'import { useAsyncAction } from "../shared/hooks/useAsyncAction";\n'
    'import { percentRules, requiredMoneyRules } from "../shared/lib/validators";',
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
    "declare write",
)


# 3) 写操作整体套 write.run（锚定函数名，避免误伤 load）
def wrap(m):
    head, guard, body = m.group(1), m.group(2), m.group(3)
    body2 = "\n".join(("  " + line if line.strip() else line) for line in body.split("\n"))
    return head + guard + "    await write.run(async () => {\n" + body2 + "    });\n"


sub(
    r"(  const submit\w* = async [^\n]*\n)((?:    [^\n]*\n)*?)    try \{\n(.*?)    \} catch \(err\) \{\n      setError\(normalizeError\(err\)\);\n    \}\n",
    wrap,
    2,
    "wrap submit",
    flags=re.S,
)

# 4) 提交按钮补 loading
sub(
    r'(<PermissionButton permission="order\.event\.post" type="primary" htmlType="submit")>',
    r"\1 loading={write.pending}>",
    2,
    "submit loading",
)


# 5) Modal 内错误提示（两个 Form：一个单行、一个跨行属性，统一 \s+ 兼容）
def inline_error(m):
    nl, indent, form = m.group(1), m.group(2), m.group(3)
    return (
        f"{nl}{indent}<InlineError error={{write.error}} />"
        f"{nl}{indent}<Form form={{{form}}} layout=\"vertical\""
    )


sub(
    r'(\n)(\s*)<Form\s+form=\{(\w+)\}\s+layout="vertical"',
    inline_error,
    2,
    "inline error",
)

# 6) 金额字段校验（base_amount 已是 MoneyInput，只补规则）
sub(
    r'(<Form\.Item name="base_amount" label="返点金额" )rules=\{\[\{ required: true \}\]\}>',
    lambda m: f'{m.group(1)}rules={{requiredMoneyRules("返点金额")}}>',
    1,
    "base_amount rules",
)

sub(
    r'(<Form\.Item name="(?:gross_amount|platform_fee)" label="([^"]+)" )rules=\{\[\{ required: true \}\]\}>(.*?)</Form\.Item>',
    lambda m: f'{m.group(1)}rules={{requiredMoneyRules("{m.group(2)}")}}>'
    + m.group(3).replace("<Input />", "<MoneyInput />")
    + "</Form.Item>",
    1,
    "gross_amount money",
    flags=re.S,
)

# platform_fee 非必填，单独处理
sub(
    r'<Form\.Item name="platform_fee" label="平台手续费（自动生成费用流水）">\n\s*<Input />',
    '<Form.Item name="platform_fee" label="平台手续费（自动生成费用流水）" rules={requiredMoneyRules("平台手续费").slice(1)}>\n            <MoneyInput />',
    1,
    "platform_fee money",
)

# 7) 返点比例 0–100
sub(
    r'(<Form\.Item name="rate" label="返点比例")>',
    r'\1 rules={percentRules("返点比例")}>',
    1,
    "rate rules",
)

# 8) 打开弹窗前先 resetFields
sub(
    r"onClick=\{\(\) => setCreateOpen\(true\)\}",
    "onClick={() => {\n              form.resetFields();\n              setCreateOpen(true);\n            }}",
    1,
    "reset create",
)
sub(
    r"            setSettleTarget\(row\);",
    "            settleForm.resetFields();\n            setSettleTarget(row);",
    1,
    "reset settle",
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
