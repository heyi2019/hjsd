"""把 WPS 订单表转成 ERP 口径的标准导入表（CSV + XLSX）。"""
import csv
import json
from collections import Counter, defaultdict
from pathlib import Path

BASE = Path(__file__).parent
rows = json.loads((BASE / "wps_orders.json").read_text())

# WPS 订单类型 -> ERP 业务类型
# 口径（2026-11-01 用户裁决）：代挂若我方付出了本金，本质是回收，归 HS；零本金才留 DG。
TYPE_MAP = {
    "回收": ("HS", "回收后自营售卖"),
    "氪金联盟提号": ("TH", "同行提号转售"),
    "代挂": ("DG", "代客挂售收服务费"),
    "蹭点": ("DG", "蹭点按代挂口径"),
    "返点": ("", "附加收入：需关联主单，不入订单"),
    "打赏": ("", "附加收入：需关联主单，不入订单"),
}


def resolve_type(raw: str, principal: float) -> tuple[str, str]:
    """按本金是否实付二次判定：代挂类垫付本金 -> HS。"""
    erp_type, reason = TYPE_MAP.get(raw, ("", "未知类型"))
    if raw in ("代挂", "蹭点") and principal > 0:
        return "HS", f"{raw}但垫付本金 {principal:,.2f}，按回收口径归 HS"
    return erp_type, reason

PLAN_BASE = 1  # HJ_INVEST
PLAN_PROFIT = 2  # HJ_PROFIT

out_rows = []
skipped = []
for i, r in enumerate(rows, start=1):
    erp_type, reason = resolve_type(r["order_type_raw"], r["principal"])
    accounts = r["accounts"]
    to_principal = "投资款荷包（本金）" in accounts
    to_profit = "利润荷包（利润）" in accounts
    if not erp_type:
        skipped.append((i, r["date"], r["order_type_raw"], r["profit"], reason))
    out_rows.append(
        {
            "序号": i,
            "日期": r["date"],
            "WPS订单类型": r["order_type_raw"],
            "ERP业务类型": erp_type or "—",
            "类型判定依据": reason,
            "交易金额": r["amount"],
            "本金": r["principal"],
            "利润": r["profit"],
            "毛利率": (round(r["profit"] / r["amount"] * 100, 2) if r["amount"] else ""),
            "回收员": "、".join(r["recover_by"]),
            "售卖员": "、".join(r["sell_by"]),
            "回款本金池": "是" if to_principal else "否",
            "回款利润池": "是" if to_profit else "否",
            "WPS备注": r["note"],
            "导入动作": "建单+事件" if erp_type else "跳过（附加收入）",
        }
    )

FIELDS = list(out_rows[0].keys())
csv_path = BASE / "WPS订单_规范化.csv"
with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=FIELDS)
    w.writeheader()
    w.writerows(out_rows)
print("CSV:", csv_path, len(out_rows), "行")

# XLSX
from openpyxl import Workbook  # noqa: E402
from openpyxl.styles import Alignment, Font, PatternFill  # noqa: E402
from openpyxl.utils import get_column_letter  # noqa: E402

wb = Workbook()
ws = wb.active
ws.title = "订单导入表"
head_fill = PatternFill("solid", fgColor="1F4E79")
head_font = Font(color="FFFFFF", bold=True, size=10)
ws.append(FIELDS)
for c in ws[1]:
    c.fill = head_fill
    c.font = head_font
    c.alignment = Alignment(horizontal="center", vertical="center")
for r in out_rows:
    ws.append([r[f] for f in FIELDS])
widths = [5, 12, 12, 10, 34, 11, 10, 10, 9, 10, 10, 11, 12, 30, 16]
for i, wd in enumerate(widths, start=1):
    ws.column_dimensions[get_column_letter(i)].width = wd
ws.freeze_panes = "A2"
ws.auto_filter.ref = ws.dimensions
for row in ws.iter_rows(min_row=2, min_col=6, max_col=8):
    for c in row:
        c.number_format = "#,##0.00"

# 汇总页
ws2 = wb.create_sheet("分类汇总")
by_type = defaultdict(lambda: {"n": 0, "amt": 0.0, "pri": 0.0, "profit": 0.0})
for r in rows:
    erp_type, _ = resolve_type(r["order_type_raw"], r["principal"])
    key = f"{r['order_type_raw']} → {erp_type or '跳过'}"
    by_type[key]["n"] += 1
    by_type[key]["amt"] += r["amount"]
    by_type[key]["pri"] += r["principal"]
    by_type[key]["profit"] += r["profit"]
ws2.append(["WPS类型 → ERP类型", "单数", "交易金额", "本金", "利润"])
for c in ws2[1]:
    c.fill = head_fill
    c.font = head_font
for t, v in sorted(by_type.items(), key=lambda x: -x[1]["n"]):
    ws2.append([t, v["n"], round(v["amt"], 2), round(v["pri"], 2), round(v["profit"], 2)])
tot = [len(rows), round(sum(r["amount"] for r in rows), 2),
       round(sum(r["principal"] for r in rows), 2), round(sum(r["profit"] for r in rows), 2)]
ws2.append(["合计", *tot])
for c in ws2[ws2.max_row]:
    c.font = Font(bold=True)
for i, wd in enumerate([22, 8, 14, 12, 12], start=1):
    ws2.column_dimensions[get_column_letter(i)].width = wd

xlsx_path = BASE / "WPS订单_规范化.xlsx"
wb.save(xlsx_path)
print("XLSX:", xlsx_path)
print()
print("=== 分类汇总 ===")
for t, v in sorted(by_type.items(), key=lambda x: -x[1]["n"]):
    print(f"  {t:22s} {v['n']:3d} 单  交易{v['amt']:>11.2f}  本金{v['pri']:>11.2f}  利润{v['profit']:>10.2f}")
print(f"  {'合计':22s} {len(rows):3d} 单  交易{tot[1]:>11.2f}  本金{tot[2]:>11.2f}  利润{tot[3]:>10.2f}")
print()
print("=== 跳过（非订单）===", len(skipped), "条")
need = [r for r in rows if resolve_type(r['order_type_raw'], r['principal'])[0]]
print("=== 需要建单 ===", len(need), "条")
for code in ("HS", "TH", "DG"):
    sub = [r for r in need if resolve_type(r['order_type_raw'], r['principal'])[0] == code]
    print(f"  {code}: {len(sub)} 单  本金合计 {sum(r['principal'] for r in sub):,.2f}")
print()
print("=== 判定为「代挂垫本金→HS」的单 ===")
for r in rows:
    if r["order_type_raw"] in ("代挂", "蹭点") and r["principal"] > 0:
        print(f"  {r['date']}  交易{r['amount']:>9.2f}  本金{r['principal']:>9.2f}  利润{r['profit']:>8.2f}  {r['note'][:20]}")

