"""修复 installments/InstallmentsPanel.tsx 交互缺陷（原子替换 + 断言）。

覆盖：写操作无 loading/防重、Modal 内错误被遮罩挡住、金额裸 Input、Modal 残留上次输入。

注意：本文件 `load()` 也有 `try/catch/setError`，故 open/close 必须**合并成一次**
以 `const submitX = async` 为锚点的替换，单独替换 catch 会误伤 load。

用法：python3 scripts/fix_installments.py [--apply]
"""
import pathlib
import re
import sys

APPLY = "--apply" in sys.argv
P = pathlib.Path("src/installments/InstallmentsPanel.tsx")
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
    r"import \{\n  DataTable,\n  ErrorBanner,\n  MoneyText,\n  PermissionButton,\n  StatRow,\n  StatusTag,\n\} from \"\.\./shared/ui\";",
    'import {\n  DataTable,\n  ErrorBanner,\n  InlineError,\n  MoneyInput,\n  MoneyText,\n  PermissionButton,\n  StatRow,\n  StatusTag,\n} from "../shared/ui";\n'
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
    "declare write",
)


# 3) 四个写操作整体套 write.run（含 try→开、catch→闭，锚定函数名避免误伤 load）
def wrap(m):
    head, guard, body = m.group(1), m.group(2), m.group(3)
    body2 = "\n".join(("  " + line if line.strip() else line) for line in body.split("\n"))
    return head + guard + "    await write.run(async () => {\n" + body2 + "    });\n"


sub(
    r"(  const submit\w* = async [^\n]*\n)((?:    [^\n]*\n)*?)    try \{\n(.*?)    \} catch \(err\) \{\n      setError\(normalizeError\(err\)\);\n    \}\n",
    wrap,
    4,
    "wrap submit",
    flags=re.S,
)

# 4) 提交按钮补 loading（含 danger 变体）
sub(
    r'(<PermissionButton permission="[a-z.]+" type="primary"(?: danger)? htmlType="submit")>',
    r"\1 loading={write.pending}>",
    4,
    "submit loading",
)

# 5) Modal 内错误提示
def inline_error(m):
    nl, indent, form = m.group(1), m.group(2), m.group(3)
    return (
        f"{nl}{indent}<InlineError error={{write.error}} />"
        f"{nl}{indent}  <Form form={{{form}}} layout=\"vertical\""
    )


sub(
    r'(\n)(\s*)<Form form=\{(\w+)\} layout="vertical"',
    inline_error,
    4,
    "inline error",
)

# 6) 金额字段校验 + MoneyInput
sub(
    r'(<Form\.Item name="amount" label="([^"]+)" )rules=\{\[\{ required: true \}\]\}>(.*?)</Form\.Item>',
    lambda m: f'{m.group(1)}rules={{requiredMoneyRules("{m.group(2)}")}}>'
    + m.group(3).replace("<Input />", "<MoneyInput />")
    + "</Form.Item>",
    1,
    "money field",
    flags=re.S,
)

# 7) 打开弹窗前先 resetFields，避免残留上一行的输入
for form, setter in [("payForm", "setPayTarget"), ("deliverForm", "setDeliverTarget"),
                     ("recoverForm", "setRecoverTarget"), ("cancelForm", "setCancelTarget")]:
    sub(
        rf"              {setter}\(row\);",
        f"              {form}.resetFields();\n              {setter}(row);",
        1,
        f"reset {form}",
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
