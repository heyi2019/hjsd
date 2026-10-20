"""给「停用/拉黑/启用」类一键生效操作加二次确认，并补齐客户缺失的解除拉黑入口。

背景：全站 Popconfirm 仅 4 处，停用用户/团队/资金池、客户拉黑都是一键生效。
停用用户会把在职财务瞬间锁在门外；客户拉黑在前端原本不可逆（只有拉黑、没有解除）。

用法：python3 scripts/fix_confirm_actions.py [--apply]
"""
import pathlib
import re
import sys

APPLY = "--apply" in sys.argv
ROOT = pathlib.Path("src")
problems = []


def patch(rel: str, steps):
    p = ROOT / rel
    src = p.read_text(encoding="utf-8")
    orig = src
    for pattern, repl, expect, name in steps:
        src, n = re.subn(pattern, repl, src, flags=re.S)
        if n != expect:
            problems.append(f"{rel} :: {name}: expected {expect}, got {n}")
        print(f"{'ok  ' if n == expect else 'WARN'} {rel} :: {name}: {n}")
    if src != orig and not problems:
        if APPLY:
            p.write_text(src, encoding="utf-8")
            print("  written", rel)
    return src


def add_import(src: str, name: str) -> str:
    return src.replace("  PermissionButton,\n", f"  {name},\n  PermissionButton,\n", 1)


# ---------- CustomersPage：客户拉黑 → 确认 + 可解除（桌面 + 移动） ----------
def customers(src: str) -> str:
    src = add_import(src, "ConfirmButton")
    # 桌面：允许 DISABLED 解除，文案随状态切换
    src, n1 = re.subn(
        r'          <PermissionButton\n'
        r'            permission="customer\.update"\n'
        r'            size="small"\n'
        r'            disabled=\{row\.status !== "ACTIVE"\}\n'
        r'            onClick=\{async \(\) => \{\n'
        r'              await customersApi\.setStatus\(row\.id, "DISABLED"\);\n'
        r'              message\.success\("客户已拉黑，历史关系保留"\);\n'
        r'              await load\(\);\n'
        r'            \}\}\n'
        r'          >\n'
        r'            拉黑\n'
        r'          </PermissionButton>',
        '          <ConfirmButton\n'
        '            permission="customer.update"\n'
        '            size="small"\n'
        '            title={row.status === "ACTIVE" ? "拉黑该客户" : "解除拉黑"}\n'
        '            description={row.status === "ACTIVE"\n'
        '              ? "拉黑后不可作为新订单参与方；历史订单、分期与需求保留。"\n'
        '              : "解除后可重新作为新订单参与方。"}\n'
        '            danger={row.status === "ACTIVE"}\n'
        '            onConfirm={async () => {\n'
        '              await customersApi.setStatus(row.id, row.status === "ACTIVE" ? "DISABLED" : "ACTIVE");\n'
        '              message.success(row.status === "ACTIVE" ? "客户已拉黑，历史关系保留" : "客户已解除拉黑");\n'
        '              await load();\n'
        '            }}\n'
        '          >\n'
        '            {row.status === "ACTIVE" ? "拉黑" : "解除拉黑"}\n'
        '          </ConfirmButton>',
        src,
    )
    print(f"{'ok  ' if n1 == 1 else 'WARN'} customers desktop disable: {n1}")
    if n1 != 1:
        problems.append("customers desktop disable")

    src, n2 = re.subn(
        r'        onDisable=\{async \(row\) => \{\n'
        r'          await customersApi\.setStatus\(row\.id, "DISABLED"\);\n'
        r'          message\.success\("客户已拉黑，历史关系保留"\);\n'
        r'          await load\(\);\n'
        r'        \}\}',
        '        onDisable={async (row) => {\n'
        '          await customersApi.setStatus(row.id, row.status === "ACTIVE" ? "DISABLED" : "ACTIVE");\n'
        '          message.success(row.status === "ACTIVE" ? "客户已拉黑，历史关系保留" : "客户已解除拉黑");\n'
        '          await load();\n'
        '        }}',
        src,
    )
    print(f"{'ok  ' if n2 == 1 else 'WARN'} customers mobile disable: {n2}")
    if n2 != 1:
        problems.append("customers mobile disable")

    # 合作方拉黑/解除：补确认
    src, n3 = re.subn(
        r'          <PermissionButton\n'
        r'            permission="counterparty\.manage"\n'
        r'            size="small"\n'
        r'            onClick=\{async \(\) => \{\n'
        r'              await counterpartiesApi\.setStatus\(row\.id, row\.status !== "ACTIVE"\);\n'
        r'              message\.success\(row\.status === "ACTIVE" \? "合作方已拉黑，历史关系保留" : "合作方已解除拉黑"\);\n'
        r'              await load\(\);\n'
        r'            \}\}\n'
        r'          >\n'
        r'            \{row\.status === "ACTIVE" \? "拉黑" : "解除拉黑"\}\n'
        r'          </PermissionButton>',
        '          <ConfirmButton\n'
        '            permission="counterparty.manage"\n'
        '            size="small"\n'
        '            title={row.status === "ACTIVE" ? "拉黑该合作方" : "解除拉黑"}\n'
        '            description={row.status === "ACTIVE"\n'
        '              ? "拉黑后不可作为新订单对手方；有历史参与关系的仅可拉黑，不可删除。"\n'
        '              : "解除后可重新作为新订单对手方。"}\n'
        '            danger={row.status === "ACTIVE"}\n'
        '            onConfirm={async () => {\n'
        '              await counterpartiesApi.setStatus(row.id, row.status !== "ACTIVE");\n'
        '              message.success(row.status === "ACTIVE" ? "合作方已拉黑，历史关系保留" : "合作方已解除拉黑");\n'
        '              await load();\n'
        '            }}\n'
        '          >\n'
        '            {row.status === "ACTIVE" ? "拉黑" : "解除拉黑"}\n'
        '          </ConfirmButton>',
        src,
    )
    print(f"{'ok  ' if n3 == 1 else 'WARN'} customers counterparty disable: {n3}")
    if n3 != 1:
        problems.append("customers counterparty disable")
    return src


# ---------- UsersPanel：停用用户 ----------
def users(src: str) -> str:
    src = add_import(src, "ConfirmButton")
    src, n = re.subn(
        r'<PermissionButton permission="user\.manage" size="small" onClick=\{\(\) => toggleUser\(user\)\}>\{user\.is_active \? "停用" : "启用"\}</PermissionButton>',
        '<ConfirmButton\n'
        '              permission="user.manage"\n'
        '              size="small"\n'
        '              title={user.is_active ? "停用该用户" : "启用该用户"}\n'
        '              description={user.is_active\n'
        '                ? "停用后该用户立即无法登录，其在途业务不受影响。"\n'
        '                : "启用后该用户可重新登录。"}\n'
        '              danger={user.is_active}\n'
        '              onConfirm={() => toggleUser(user)}\n'
        '            >\n'
        '              {user.is_active ? "停用" : "启用"}\n'
        '            </ConfirmButton>',
        src,
    )
    print(f"{'ok  ' if n == 1 else 'WARN'} users toggle: {n}")
    if n != 1:
        problems.append("users toggle")
    return src


# ---------- TeamsPanel：停用团队 ----------
def teams(src: str) -> str:
    src = add_import(src, "ConfirmButton")
    src, n = re.subn(
        r'<PermissionButton permission="user\.manage" size="small" onClick=\{\(\) => toggle\(team\)\}>\{team\.is_active \? "停用" : "启用"\}</PermissionButton>',
        '<ConfirmButton\n'
        '              permission="user.manage"\n'
        '              size="small"\n'
        '              title={team.is_active ? "停用该团队" : "启用该团队"}\n'
        '              description={team.is_active ? "停用后团队成员的数据范围将受影响。" : "启用后恢复该团队的数据范围。"}\n'
        '              danger={team.is_active}\n'
        '              onConfirm={() => toggle(team)}\n'
        '            >\n'
        '              {team.is_active ? "停用" : "启用"}\n'
        '            </ConfirmButton>',
        src,
    )
    print(f"{'ok  ' if n == 1 else 'WARN'} teams toggle: {n}")
    if n != 1:
        problems.append("teams toggle")
    return src


# ---------- PoolsPanel：停用资金池 ----------
def pools(src: str) -> str:
    src = add_import(src, "ConfirmButton")
    src, n = re.subn(
        r'<PermissionButton permission="pool\.manage" size="small" onClick=\{\(\) => void toggleStatus\(row\)\}>\{row\.status === "ACTIVE" \? "停用" : "启用"\}</PermissionButton>',
        '<ConfirmButton\n'
        '              permission="pool.manage"\n'
        '              size="small"\n'
        '              title={row.status === "ACTIVE" ? "停用该资金池" : "启用该资金池"}\n'
        '              description={row.status === "ACTIVE"\n'
        '                ? "停用后该池不可入账，收款、划转与押金登记都会失败。请先确认池内余额与在途流水已处理。"\n'
        '                : "启用后该池可重新入账。"}\n'
        '              danger={row.status === "ACTIVE"}\n'
        '              onConfirm={() => toggleStatus(row)}\n'
        '            >\n'
        '              {row.status === "ACTIVE" ? "停用" : "启用"}\n'
        '            </ConfirmButton>',
        src,
    )
    print(f"{'ok  ' if n == 1 else 'WARN'} pools toggle: {n}")
    if n != 1:
        problems.append("pools toggle")
    return src


results = {}
for rel, fn in [
    ("customers/CustomersPage.tsx", customers),
    ("users/UsersPanel.tsx", users),
    ("users/TeamsPanel.tsx", teams),
    ("field-definitions/panels/PoolsPanel.tsx", pools),
]:
    p = ROOT / rel
    results[rel] = fn(p.read_text(encoding="utf-8"))

if problems:
    print("\n=== 未写入 ===")
    for item in problems:
        print(" -", item)
    sys.exit(1)

if APPLY:
    for rel, content in results.items():
        (ROOT / rel).write_text(content, encoding="utf-8")
        print("written", rel)
else:
    print("(dry-run)")
