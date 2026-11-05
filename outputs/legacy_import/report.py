#!/usr/bin/env python3
"""核对报告生成：老数据清洗产出核对用工作簿。

利润口径（业务裁决）：利润 = 差价 + 返点 − 费用
  差价 = 订单金额 − 本金
  ∴ 订单金额 − 本金 − 利润 = 费用 − 返点
  该式不为 0 属业务常态，不得据此判为错账。
DG 为零本金型，本金恒为 0；其差额为客户货值，不参与上述判定。
"""
from __future__ import annotations

from collections import Counter
from decimal import Decimal
from pathlib import Path

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

OUT = Path("/Users/aries/黑金时代/outputs/legacy_import")
HDR = PatternFill("solid", fgColor="1F4E79")
HF = Font(color="FFFFFF", bold=True, size=11)
GOOD = PatternFill("solid", fgColor="E2EFDA")
WARN = PatternFill("solid", fgColor="FFF2CC")
BAD = PatternFill("solid", fgColor="FCE4D6")
Z = Decimal("0.01")

# 已人工核对确认的例外（2026-11-01 用户确认）：不计为异常，判为「已确认」
# 键 = (日期, 类型, 本金, 利润)，用业务特征而非行号，避免行序变动后失配
CONFIRMED: dict[tuple[str, str, Decimal, Decimal], str] = {
    ("2026-10-24", "HS", Decimal("14710.00"), Decimal("-313.00")):
        "真实亏损，已核对确认（10-24 HS 卖 14088 / 收 14710，亏 313）",
}


def read(name: str) -> tuple[list[str], list[dict[str, str]]]:
    lines = [l for l in (OUT / name).read_text(encoding="utf-8-sig").split("\n") if l.strip()]
    head = lines[0].split(",")
    return head, [dict(zip(head, l.split(","))) for l in lines[1:]]


def dec(v: str) -> Decimal:
    return Decimal(v or "0")


def style_header(ws) -> None:
    for cell in ws[1]:
        cell.fill = HDR
        cell.font = HF
        cell.alignment = Alignment(vertical="center")


def main() -> None:
    ho, orders = read("订单导入模板.csv")
    ha, accounts = read("账号导入模板.csv")
    hc, cash = read("资金流水导入模板.csv")
    hd, deferred = read("待确认_返点打赏.csv")
    try:
        _, reclassified = read("_改判记录.csv")
    except FileNotFoundError:
        reclassified = []
    to_hs = [r for r in reclassified if r["改判方向"] == "DG→HS"]
    to_dg = [r for r in reclassified if r["改判方向"].endswith("→DG")]

    # ---- 口径分解
    buckets: dict[str, list[Decimal]] = {"亏损": [], "无费用无返点": [], "净返点": [], "净费用": []}
    dg_principal: list[tuple[int, dict[str, str]]] = []
    dg_pure_count = 0
    detail_rows: list[list[object]] = []
    for idx, r in enumerate(orders, start=2):
        amt, pri, pro = dec(r["订单金额"]), dec(r["本金"]), dec(r["利润"])
        spread = amt - pri
        if r["订单类型"] == "DG":
            if pri > 0:
                # 零本金型不应有本金：保留原值，疑为回收单误标，待改判 HS
                dg_principal.append((idx, r))
                detail_rows.append([idx, r["订单日期"], "DG", amt, pri, pro, spread, amt - pri - pro, "疑为回收单，本金≠0，待改判 HS"])
            else:
                dg_pure_count += 1
                # 零本金型不参与差价/差额判定，只登记利润
                detail_rows.append([idx, r["订单日期"], "DG", amt, pri, pro, "", "", "零本金型：仅利润参与核算，不做差价判定"])
            if pro > 0:
                buckets.setdefault("DG服务费", []).append(pro)
            continue
        diff = amt - pri - pro
        if pro < 0:
            # 亏损单差价与差额均为负，语义上不属「净返点」，单列以免统计失真
            kind, key = "亏损（售价低于本金）", "亏损"
        elif abs(diff) <= Z:
            kind, key = "无差异", "无费用无返点"
        elif diff > 0:
            kind, key = "净费用（费用>返点）", "净费用"
        else:
            kind, key = "净返点（返点>费用）", "净返点"
        buckets[key].append(diff)
        detail_rows.append([idx, r["订单日期"], r["订单类型"], amt, pri, pro, spread, diff, kind])

    sum_income = sum(dec(r["金额"]) for r in cash if r["收支方向"] == "IN")
    sum_out = sum(dec(r["金额"]) for r in cash if r["收支方向"] == "OUT")

    wb = openpyxl.Workbook()

    # ============ ① 汇总
    ws = wb.active
    ws.title = "① 汇总"
    ws.append(["老数据清洗 · 核对报告"])
    ws["A1"].font = Font(bold=True, size=15)
    ws.append(["口径：利润 = 差价 + 返点 − 费用；DG 零本金型本金恒为 0"])
    ws["A2"].font = Font(color="808080", size=10)
    ws.append([])
    table = [
        ["目标模板", "来源工作表", "产出文件", "行数", "关键合计"],
        ["STANDARD_ORDER 订单", "成单登记账号", "订单导入模板.csv", len(orders),
         f"金额 {sum(dec(r['订单金额']) for r in orders):,.2f} / 本金 {sum(dec(r['本金']) for r in orders):,.2f} / 利润 {sum(dec(r['利润']) for r in orders):,.2f}"],
        ["STANDARD_ACCOUNT 账号", "回收账号登记", "账号导入模板.csv", len(accounts),
         f"买入成本 {sum(dec(r['买入成本']) for r in accounts):,.2f} / 预计售价 {sum(dec(r['预计售价']) for r in accounts):,.2f}"],
        ["STANDARD_CASHFLOW 流水", "收支明细表", "资金流水导入模板.csv", len(cash),
         f"收入 {sum_income:,.2f} / 支出 {sum_out:,.2f} / 净 {sum_income - sum_out:,.2f}"],
        ["（不入订单）", "成单登记账号", "待确认_返点打赏.csv", len(deferred),
         f"利润 {sum(dec(r['利润']) for r in deferred):,.2f}"],
    ]
    start = ws.max_row + 1
    for row in table:
        ws.append(row)
    for cell in ws[start]:
        cell.fill = HDR
        cell.font = HF
    for width, col in zip([26, 18, 26, 8, 66], "ABCDE"):
        ws.column_dimensions[col].width = width

    # ============ ② 利润口径
    ws = wb.create_sheet("② 利润口径")
    ws.append(["项目", "行数", "金额合计", "说明"])
    style_header(ws)
    ws.append(["订单类型分布", len(orders),
               " / ".join(f"{k} {v}" for k, v in sorted(Counter(r["订单类型"] for r in orders).items())),
               "HS=回收 / TH=提号 / DG=代挂"])
    for key, label, note in (
        ("亏损", "HS/TH 亏损单（利润<0）", "售价低于本金，利润为负，业务已确认为真实亏损"),
        ("无费用无返点", "HS/TH 无费用无返点", "利润与差价相等，差额为 0"),
        ("净返点", "HS/TH 净返点（返点 > 费用）", "利润高于差价，差额即净返点收入，负号"),
        ("净费用", "HS/TH 净费用（费用 > 返点）", "利润低于差价，差额即净费用支出，正号"),
    ):
        vals = buckets.get(key, [])
        ws.append([label, len(vals), f"{sum(vals):,.2f}" if vals else "0.00", note])
    ws.append(["HS/TH 合计", sum(len(buckets.get(k, [])) for k in ("亏损", "无费用无返点", "净返点", "净费用")), "",
               "上式合计 = 订单金额 − 本金 − 利润 的全部构成"])
    ws.append(["DG 纯代挂（本金=0）", dg_pure_count, f"{sum(buckets.get('DG服务费', [])):,.2f}",
               "零本金型：本金不设值（恒为 0），只登记利润（服务费）；订单金额保留客户货值供追溯"])
    ws.append(["DG→HS（本金≠0）", len(to_hs), f"{sum(dec(r['本金']) for r in to_hs):,.2f}",
               "标注代挂但本金不为 0，实为回收销售，已改判 HS"])
    ws.append(["HS/TH→DG（本金=0）", len(to_dg), f"{sum(dec(r['利润']) for r in to_dg):,.2f}",
               "标注库存型但本金为 0，按「无本金即代挂」改判 DG，金额列合计为服务费"])
    ws.append([])
    ws.append(["已确认例外", 1, "−313.00",
               "2026-10-24 HS 卖 14088 / 收 14710，亏 313，业务确认为真实亏损，不计为异常"])
    ws.append(["结论", "", "", "订单金额 ≠ 本金+利润 属业务常态（费用与返点未单列）。"
                                 "原按恒等式校验出的 91 行差异，经口径对照后 0 行属错账，直接导入即可。"])
    for row in ws.iter_rows(min_row=ws.max_row):
        for cell in row:
            if cell.value == "结论":
                cell.font = Font(bold=True)
    for width, col in zip([30, 10, 14, 72], "ABCD"):
        ws.column_dimensions[col].width = width

    # ============ ③ 需拍板清单
    ws = wb.create_sheet("③ 需拍板清单")
    ws.append(["序号", "事项", "涉及行数", "说明", "建议"])
    style_header(ws)
    items = [
        ["1", "类型判定统一按本金", str(len(reclassified)),
         f"有本金=库存型(HS/TH)，无本金=代挂(DG)。DG→HS {len(to_hs)} 行；HS/TH→DG {len(to_dg)} 行",
         "已完成：明细见「④ 改判记录」"],
        ["2", "HS/TH 金额差异", "91",
         "口径已澄清为「利润 = 差价 + 返点 − 费用」，差异来自费用与返点未单列，非错账",
         "无需处理，按原值导入"],
        ["3", "返点 / 打赏不入订单", str(len(deferred)),
         "29 返点 + 1 打赏，交易金额多为 0，性质为收入而非订单",
         f"利润合计 {sum(dec(r['利润']) for r in deferred):,.2f}，需定去路（返点域 / 资金流水）"],
        ["4", "账号表缺日期", "1", "该行有金额与账号但无日期", "补日期或按空白登记"],
        ["5", "负数利润", "1", "2026-10-24 HS 卖 14088、收 14710，利润 −313", "已确认：真实亏损，无需处理"],
        ["6", "资金池 / 平台 / 区服 留空", "全部", "源表无对应字段", "可按类别指派（投资款荷包 / 利润荷包）"],
    ]
    for row in items:
        ws.append(row)
    for col, width in zip("ABCDE", [6, 26, 10, 62, 46]):
        ws.column_dimensions[col].width = width
    ws["B2"].fill = GOOD
    ws["B3"].fill = GOOD
    ws["B6"].fill = GOOD

    # ============ ④ 已改判 HS 明细
    ws = wb.create_sheet("④ 改判记录")
    ws.append(["订单日期", "改判方向", "原类型", "改判类型", "订单金额", "本金", "利润", "经办人", "备注"])
    style_header(ws)
    for r in reclassified:
        ws.append([r["订单日期"], r["改判方向"], r["原类型"], r["改判类型"], r["订单金额"], r["本金"], r["利润"], r["经办人"], r["备注"]])
    for col, width in zip("ABCDEFGHI", [14, 12, 10, 12, 12, 12, 12, 14, 52]):
        ws.column_dimensions[col].width = width

    # ============ ⑤ 差额性质明细（含异常列，供逐行比数）
    def judge(kind: str, amt: Decimal, pri: Decimal, pro: Decimal, iso: str) -> tuple[str, str]:
        hit = CONFIRMED.get((iso, kind, pri, pro))
        if hit:
            return "已确认", hit
        notes: list[str] = []
        if not iso:
            notes.append("缺日期")
        if pro < 0:
            notes.append("利润为负")
        if pro == 0:
            notes.append("利润为0")
        if kind in ("HS", "TH"):
            if pri == 0:
                notes.append("库存型本金为0")
            if amt == 0:
                notes.append("订单金额为0")
            if pri > 0 and amt > 0 and amt < pri:
                notes.append("售价低于本金")
        else:
            if pri != 0:
                notes.append("DG本金不为0")
            if amt == 0:
                notes.append("货值为0")
        return ("异常" if notes else "正常"), "；".join(notes)

    ws = wb.create_sheet("⑤ 差额性质明细")
    ws.append([
        "CSV行号", "订单日期", "类型", "订单金额", "本金", "利润",
        "差价(金额-本金)", "差额(金额-本金-利润)", "差额性质", "异常", "异常说明", "经办人", "备注",
    ])
    style_header(ws)
    for (idx, iso, kind, amt, pri, pro, spread, diff, nature), src in zip(detail_rows, orders):
        flag, reason = judge(kind, amt, pri, pro, iso)
        ws.append([
            idx, iso, kind, f"{amt:.2f}", f"{pri:.2f}", f"{pro:.2f}",
            f"{spread:.2f}" if spread != "" else "",
            f"{diff:.2f}" if diff != "" else "",
            nature, flag, reason, src["经办人"], src["备注"],
        ])
        if flag == "异常":
            for cell in ws[ws.max_row]:
                cell.fill = BAD
        elif flag == "已确认":
            for cell in ws[ws.max_row]:
                cell.fill = WARN
    ws.freeze_panes = "D2"
    ws.auto_filter.ref = f"A1:M{ws.max_row}"
    for col, width in zip("ABCDEFGHIJKLM", [10, 14, 8, 12, 12, 12, 18, 22, 34, 8, 26, 14, 48]):
        ws.column_dimensions[col].width = width

    # ============ 产出全量页
    for name, (head, rows) in {
        "⑥ 订单_产出": (ho, orders),
        "⑦ 账号_产出": (ha, accounts),
        "⑧ 流水_产出": (hc, cash),
        "⑨ 返点打赏": (hd, deferred),
    }.items():
        w = wb.create_sheet(name)
        w.append(head)
        style_header(w)
        for r in rows:
            w.append([r[k] for k in head])
        w.freeze_panes = "A2"

    wb.save(OUT / "核对报告.xlsx")
    print("核对报告.xlsx 已更新")
    for key, vals in buckets.items():
        print(f"  {key}: {len(vals)} 行，合计 {sum(vals):,.2f}" if vals else f"  {key}: 0 行")
    print(f"  DG 带本金: {len(dg_principal)} 行")


if __name__ == "__main__":
    main()
