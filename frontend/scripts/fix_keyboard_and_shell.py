"""第三批：
1) OrdersPage 用 Typography.Link 承载点击 → 改 Button type="link"（键盘可达）。
   此前「查看详情」是订单列表主路径，键盘用户根本无法聚焦。
2) AppShell 退出登录加二次确认；session.logout 用 finally 保证本地一定退出
   （此前 /auth/logout 失败会让「退出登录」点了没反应且产生 unhandled rejection）。

用法：python3 scripts/fix_keyboard_and_shell.py [--apply]
"""
import pathlib
import re
import sys

APPLY = "--apply" in sys.argv
ROOT = pathlib.Path("src")
problems = []


def sub(src, pattern, repl, expect, name, flags=0):
    src, n = re.subn(pattern, repl, src, flags=flags)
    if n != expect:
        problems.append(f"{name}: expected {expect}, got {n}")
    print(f"{'ok  ' if n == expect else 'WARN'} {name}: {n}")
    return src


# ---------- OrdersPage ----------
rel = "orders/OrdersPage.tsx"
p = ROOT / rel
s = p.read_text(encoding="utf-8")

old = "import { Card, Descriptions, Drawer, Dropdown, Form, Input, Modal, Segmented, Select as AntSelect, Space, Tabs, Typography, message } from \"antd\";"
new = "import { Button, Card, Descriptions, Drawer, Dropdown, Form, Input, Modal, Segmented, Select as AntSelect, Space, Tabs, Typography, message } from \"antd\";"
assert s.count(old) == 1
s = s.replace(old, new, 1)
print("ok   orders import Button")

s = sub(
    s,
    r'<Typography\.Link onClick=\{(\(\) => props\.onSelect\(order\)|\(\) => void openOrder\(order\))\}>查看详情</Typography\.Link>',
    r'<Button type="link" onClick={\1}>查看详情</Button>',
    2,
    "orders 查看详情",
)
s = sub(s, r"<Typography\.Link>更多⌄</Typography\.Link>", '<Button type="link">更多⌄</Button>', 1, "orders 更多")
s = sub(
    s,
    r'<Typography\.Link onClick=\{\(\) => \{ setActiveTab\("inventory"\); setSelectedOrder\(null\); \}\}>\n(\s*)去库存中心\n\s*</Typography\.Link>',
    r'<Button type="link" onClick={() => { setActiveTab("inventory"); setSelectedOrder(null); }}>\n\1去库存中心\n            </Button>',
    1,
    "orders 去库存中心",
)
s = sub(
    s,
    r'<Typography\.Link onClick=\{\(\) => \{ setActiveTab\("collections"\); setSelectedOrder\(null\); \}\}>\n(\s*)去分期与回款\n\s*</Typography\.Link>',
    r'<Button type="link" onClick={() => { setActiveTab("collections"); setSelectedOrder(null); }}>\n\1去分期与回款\n            </Button>',
    1,
    "orders 去分期与回款",
)
(ROOT / rel).write_text(s, encoding="utf-8") if APPLY and not problems else None

# ---------- session.tsx：logout 必须本地退出 ----------
rel2 = "shared/state/session.tsx"
p2 = ROOT / rel2
s2 = p2.read_text(encoding="utf-8")
s2 = sub(
    s2,
    r"  const logout = useCallback\(async \(\) => \{\n    await logoutApi\(\);\n    setAuthenticated\(false\);\n    setMustChangePassword\(false\);\n  \}, \[\]\);",
    "  const logout = useCallback(async () => {\n"
    "    // 后端 /auth/logout 失败也必须退出本地会话：否则「退出登录」点了没反应，\n"
    "    // 用户以为已退出却仍停留在已登录界面。\n"
    "    try {\n"
    "      await logoutApi();\n"
    "    } finally {\n"
    "      setAuthenticated(false);\n"
    "      setMustChangePassword(false);\n"
    "    }\n"
    "  }, []);",
    1,
    "session logout",
)
(ROOT / rel2).write_text(s2, encoding="utf-8") if APPLY and not problems else None

# ---------- AppShell：退出确认 ----------
rel3 = "app/AppShell.tsx"
p3 = ROOT / rel3
s3 = p3.read_text(encoding="utf-8")
s3 = sub(s3, r'import \{ Modal, Space \} from "antd";', 'import { Modal, Popconfirm, Space } from "antd";', 1, "shell import")
s3 = sub(
    s3,
    r'<button type="button" className="topbar-action topbar-action--logout" onClick=\{\(\) => void logout\(\)\}>退出登录</button>',
    '<Popconfirm\n'
    '              title="退出登录"\n'
    '              description="退出后需要重新登录才能继续操作。"\n'
    '              okText="退出"\n'
    '              cancelText="取消"\n'
    '              onConfirm={() => void logout()}\n'
    '            >\n'
    '              <button type="button" className="topbar-action topbar-action--logout">退出登录</button>\n'
    '            </Popconfirm>',
    1,
    "shell logout confirm",
)
(ROOT / rel3).write_text(s3, encoding="utf-8") if APPLY and not problems else None

if problems:
    print("\n=== 未写入 ===")
    for i in problems:
        print(" -", i)
    sys.exit(1)

if APPLY:
    print("written:", rel, rel2, rel3)
else:
    print("(dry-run)")
