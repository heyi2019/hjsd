"""第二批：给字段/游戏类型/业务类型停启用与规则发布加二次确认。

用法：python3 scripts/fix_confirm_actions2.py [--apply]
"""
import pathlib
import re
import sys

APPLY = "--apply" in sys.argv
ROOT = pathlib.Path("src")
problems = []


def sub(src, pattern, repl, expect, name):
    src, n = re.subn(pattern, repl, src, flags=re.S)
    if n != expect:
        problems.append(f"{name}: expected {expect}, got {n}")
    print(f"{'ok  ' if n == expect else 'WARN'} {name}: {n}")
    return src


def add_import(src, old, new, name):
    assert src.count(old) == 1, f"{name}: import anchor count={src.count(old)}"
    return src.replace(old, new, 1)


out = {}

# ---- FieldsPanel：停用活字段 ----
rel = "field-definitions/panels/FieldsPanel.tsx"
s = (ROOT / rel).read_text(encoding="utf-8")
s = sub(
    s,
    r'            <PermissionButton\n'
    r'              permission="field-definition\.manage"\n'
    r'              size="small"\n'
    r'              onClick=\{async \(\) => \{\n'
    r'                await fieldsApi\.setActive\(row\.id, !row\.is_active\);\n'
    r'                await load\(\);\n'
    r'              \}\}\n'
    r'            >\n'
    r'              \{row\.is_active \? "停用" : "启用"\}\n'
    r'            </PermissionButton>',
    '            <ConfirmButton\n'
    '              permission="field-definition.manage"\n'
    '              size="small"\n'
    '              title={row.is_active ? `停用字段「${row.label}」` : `启用字段「${row.label}」`}\n'
    '              description={row.is_active\n'
    '                ? "停用后该字段从所有表单消失，已填写的历史值保留。"\n'
    '                : "启用后该字段重新出现在表单中。"}\n'
    '              danger={row.is_active}\n'
    '              onConfirm={async () => {\n'
    '                await fieldsApi.setActive(row.id, !row.is_active);\n'
    '                await load();\n'
    '              }}\n'
    '            >\n'
    '              {row.is_active ? "停用" : "启用"}\n'
    '            </ConfirmButton>',
    1,
    "fields toggle",
)
s = add_import(
    s,
    'import { DataTable, ErrorBanner, PermissionButton, PermissionGate } from "../../shared/ui";',
    'import { ConfirmButton, DataTable, ErrorBanner, PermissionButton, PermissionGate } from "../../shared/ui";',
    "fields import",
) if 'import { DataTable, ErrorBanner, PermissionButton, PermissionGate } from "../../shared/ui";' in s else s
out[rel] = s

# ---- GameTypeSettingsPanel：停用游戏类型 ----
rel = "field-definitions/panels/GameTypeSettingsPanel.tsx"
s = (ROOT / rel).read_text(encoding="utf-8")
s = sub(
    s,
    r'            <PermissionButton\n'
    r'              permission="order-type\.manage"\n'
    r'              size="small"\n'
    r'              disabled=\{row\.is_default\}\n'
    r'              onClick=\{\(\) => void run\(\(\) => gameTypesApi\.setActive\(row\.id, !row\.is_active\)\)\}\n'
    r'            >\n'
    r'              \{row\.is_active \? "停用" : "启用"\}\n'
    r'            </PermissionButton>',
    '            <ConfirmButton\n'
    '              permission="order-type.manage"\n'
    '              size="small"\n'
    '              disabled={row.is_default}\n'
    '              title={row.is_active ? `停用游戏类型「${row.name}」` : `启用游戏类型「${row.name}」`}\n'
    '              description={row.is_active\n'
    '                ? "停用后新建订单与账号不再带出该类型；已有数据保留。"\n'
    '                : "启用后新建表单可重新选择该类型。"}\n'
    '              danger={row.is_active}\n'
    '              onConfirm={() => run(() => gameTypesApi.setActive(row.id, !row.is_active))}\n'
    '            >\n'
    '              {row.is_active ? "停用" : "启用"}\n'
    '            </ConfirmButton>',
    1,
    "gametype toggle",
)
out[rel] = s

# ---- OrderTypesPanel：停用业务类型（原为裸 button，无 loading 无确认） ----
rel = "field-definitions/panels/OrderTypesPanel.tsx"
s = (ROOT / rel).read_text(encoding="utf-8")
s = sub(
    s,
    r'<button type="button" className="ui-button ui-button--small" onClick=\{\(\) => void toggleActive\(row\)\}>\{row\.is_active \? "停用" : "启用"\}</button>',
    '<ConfirmButton\n'
    '              permission="order-type.manage"\n'
    '              size="small"\n'
    '              title={row.is_active ? `停用业务类型「${row.name}」` : `启用业务类型「${row.name}」`}\n'
    '              description={row.is_active\n'
    '                ? "停用后无法新建该类型订单；已有订单与历史数据不受影响。"\n'
    '                : "启用后可重新新建该类型订单。"}\n'
    '              danger={row.is_active}\n'
    '              onConfirm={() => toggleActive(row)}\n'
    '            >\n'
    '              {row.is_active ? "停用" : "启用"}\n'
    '            </ConfirmButton>',
    1,
    "ordertype toggle",
)
out[rel] = s

# ---- PolicySettingsPanel：发布规则（不可逆） ----
rel = "policy/PolicySettingsPanel.tsx"
s = (ROOT / rel).read_text(encoding="utf-8")
s = sub(
    s,
    r'          <PermissionButton\n'
    r'            permission="policy\.approve"\n'
    r'            size="small"\n'
    r'            type="primary"\n'
    r'            loading=\{acting\}\n'
    r'            disabled=\{row\.status !== "DRAFT"\}\n'
    r'            onClick=\{\(\) => void act\(\(\) => policyApi\.approve\(row\.id, \{\}\)\)\}\n'
    r'          >\n'
    r'            发布\n'
    r'          </PermissionButton>',
    '          <ConfirmButton\n'
    '            permission="policy.approve"\n'
    '            size="small"\n'
    '            type="primary"\n'
    '            disabled={row.status !== "DRAFT"}\n'
    '            title="发布该规则版本"\n'
    '            description="发布后对生效日之后的新单生效；已发布版本不可修改，只能新建版本。"\n'
    '            onConfirm={() => act(() => policyApi.approve(row.id, {}))}\n'
    '          >\n'
    '            发布\n'
    '          </ConfirmButton>',
    1,
    "policy approve",
)
out[rel] = s

if problems:
    print("\n=== 未写入 ===")
    for i in problems:
        print(" -", i)
    sys.exit(1)

if APPLY:
    for rel, content in out.items():
        (ROOT / rel).write_text(content, encoding="utf-8")
        print("written", rel)
else:
    print("(dry-run)")
