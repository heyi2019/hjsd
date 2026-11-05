#!/usr/bin/env python3
"""产出两张表：7 列订单清单 + 缺口工单。

纯表格，不碰库、不写任何落库步骤。
  订单导入_7列.csv   7 列严格对齐系统标准订单模板，备注末尾带「（源表第N行）」便于回查
  缺口工单.xlsx      按 order_form_fields.required 口径，逐条列出每条待建记录还缺哪些字段
"""
from __future__ import annotations

import csv

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from build_form_aligned import FORM, OUT

# 与前端 IMPORT_TEMPLATES.STANDARD_ORDER 完全一致，列名与顺序不可改
SYS_ORDER_COLS = ["订单日期", "订单类型", "订单金额", "本金", "利润", "经办人", "备注"]

HDR = PatternFill("solid", fgColor="1F4E79")
HF = Font(color="FFFFFF", bold=True, size=11)
MISS = PatternFill("solid", fgColor="FCE4D6")
WARN = PatternFill("solid", fgColor="FFF2CC")
OK = PatternFill("solid", fgColor="E2EFDA")
BAND = PatternFill("solid", fgColor="F2F2F2")
NOTE_FONT = Font(color="808080", size=10)

TITLE = {"HS": "HS 回收单", "TH": "TH 提号单", "DG": "DG 代挂单", "SALE": "SALE 卖出事件"}


# 账号段字段：这些字段缺，多半是「回收金额」对不上账号表、没关联上，而不是源表没这列。
# 两者必须分开，否则工单会让人白翻源表。
ACCOUNT_KEYS = frozenset({
    "game_type", "game_account", "game_password", "channel_region",
    "has_secondary", "game_account_note", "bound_phone", "intermediary_platform",
})


def fix_hint(field_key: str, src: str, row: dict[str, str]) -> str:
    """按缺失的真实原因给补法，不看字段说明里怎么写。"""
    s = (src or "").strip()
    if s.startswith("无"):
        return "源表无此列"
    if field_key in ACCOUNT_KEYS and not (row.get("账号备注") or "").strip():
        return "账号表未关联"
    return "源表空值"


def hint_field(field_key: str, src: str) -> str:
    """字段级补法（汇总页用，无具体行可看）。"""
    s = (src or "").strip()
    if s.startswith("无"):
        return "源表无此列"
    if field_key in ACCOUNT_KEYS:
        return "账号表未关联"
    return "源表空值"


def read_table(key: str) -> list[dict[str, str]]:
    with (OUT / f"台账_{key}.csv").open(encoding="utf-8-sig") as fp:
        return list(csv.DictReader(fp))


# 金额三列只在 7 列清单里（台账表是表单字段视图，没有订单金额/本金/利润）。
# 台账「源行号」= 本清单行号（含表头行 1 计）——110 行实测全匹配，可据此取金额。
TPL = list(csv.DictReader((OUT / "订单导入模板.csv").open(encoding="utf-8-sig")))


def tpl_of(row_no: str) -> dict[str, str]:
    return TPL[int(row_no) - 2]


def build_order_csv() -> int:
    """7 列清单：保持原表日期序，备注追加源行号便于回查。"""
    rows: list[list[str]] = []
    for i, t in enumerate(TPL):
        note = (t.get("备注") or "").strip()
        rows.append([
            t["订单日期"], t["订单类型"], t["订单金额"], t["本金"], t["利润"], t["经办人"],
            f"{note}（源行号{i + 2}）".strip(),
        ])
    with (OUT / "订单导入_7列.csv").open("w", newline="", encoding="utf-8-sig") as fp:
        w = csv.writer(fp)
        w.writerow(SYS_ORDER_COLS)
        w.writerows(rows)
    return len(rows)


def collect() -> dict[str, list[dict]]:
    """逐条算出必填缺口，缺得少的排前面（先建能建的）。"""
    out: dict[str, list[dict]] = {}
    for key, fields in FORM.items():
        req = [(fk, lab, src) for fk, lab, r, src in fields if r]
        items = []
        for r in read_table(key):
            t = tpl_of(r["源行号"])
            gaps = [(lab, fix_hint(fk, src, r)) for fk, lab, src in req
                    if not (r.get(lab) or "").strip()]
            items.append({
                "row": r["源行号"], "date": r["日期"], "amount": t["订单金额"],
                "principal": t["本金"], "profit": t["利润"], "handler": r["经办人"],
                "req": len(req), "gaps": gaps,
            })
        items.sort(key=lambda x: (len(x["gaps"]), int(x["row"])))
        out[key] = items
    return out


def write_header(ws, row: int, cols: list[str]) -> None:
    for j, v in enumerate(cols, start=1):
        c = ws.cell(row, j, v)
        c.fill = HDR
        c.font = HF
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def build_workbook(data: dict[str, list[dict]]) -> None:
    wb = openpyxl.Workbook()

    # ---------- ① 缺口总览 ----------
    ws = wb.active
    ws.title = "① 缺口总览"
    ws.append(["老数据待建记录 · 必填缺口总览"])
    ws["A1"].font = Font(bold=True, size=15)
    ws.append(["必填口径取自 order_form_fields.required（表单不填提交不了）；缺口按「缺得少」排序，先建能建的。"
               "底色：绿=必填全齐可直接建，黄=有缺口，红=全部必填都缺"])
    ws["A2"].font = NOTE_FONT
    ws.append([])

    hrow = 4
    write_header(ws, hrow, ["记录类型", "记录数", "每张必填", "缺口格数", "全齐的条数",
                            "一条都建不了的", "最缺的字段（缺口行数）"])
    row = hrow + 1
    tot_n = tot_gap = tot_full = tot_block = 0
    for key in ("HS", "TH", "DG", "SALE"):
        items = data[key]
        gap_cells = sum(len(i["gaps"]) for i in items)
        full = sum(1 for i in items if not i["gaps"])
        blocked = sum(1 for i in items if i["req"] and len(i["gaps"]) == i["req"])
        tot_n += len(items); tot_gap += gap_cells; tot_full += full; tot_block += blocked
        cnt: dict[str, int] = {}
        for i in items:
            for lab, _ in i["gaps"]:
                cnt[lab] = cnt.get(lab, 0) + 1
        worst = "、".join(f"{k}({v})" for k, v in sorted(cnt.items(), key=lambda x: -x[1])[:3])
        vals = [TITLE[key], len(items), items[0]["req"] if items else 0,
                gap_cells, full, blocked, worst]
        for j, v in enumerate(vals, start=1):
            c = ws.cell(row, j, v)
            if 2 <= j <= 6:
                c.alignment = Alignment(horizontal="center", vertical="center")
        ws.cell(row, 5).fill = OK if full else WARN
        ws.cell(row, 6).fill = MISS if blocked else OK
        row += 1

    # 合计行
    for j, v in enumerate(["合计", tot_n, "—", tot_gap, tot_full, tot_block,
                           f"{tot_n} 条记录里只有 {tot_full} 条必填全齐"], start=1):
        c = ws.cell(row, j, v)
        c.font = Font(bold=True)
        c.fill = BAND
        if 2 <= j <= 6:
            c.alignment = Alignment(horizontal="center", vertical="center")

    for col, width in zip("ABCDEFG", [16, 9, 10, 10, 11, 17, 52]):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = ws.cell(hrow + 1, 1)

    # ---------- ②~⑤ 逐条工单 ----------
    for key in ("HS", "TH", "DG", "SALE"):
        items = data[key]
        w = wb.create_sheet(f"{'②③④⑤'[('HS','TH','DG','SALE').index(key)]} {TITLE[key]}")
        w.append([f"{TITLE[key]} · 逐条缺口（{len(items)} 条）"])
        w["A1"].font = Font(bold=True, size=14)
        w.append(["缺失字段格式：字段名(缺因)。缺因三档：源表无此列 / 账号表未关联 / 源表空值；排序按缺口数升序"])
        w["A2"].font = NOTE_FONT

        head = ["源行号", "日期", "订单金额", "本金", "利润", "经办人",
                "必填数", "缺口数", "缺失字段（含缺因）", "源表无此列数"]
        hr = 4
        write_header(w, hr, head)
        r = hr + 1
        for it in items:
            manual = sum(1 for _, h in it["gaps"] if h == "源表无此列")
            gaps_txt = "、".join(f"{lab}({h})" for lab, h in it["gaps"]) or "—"
            vals = [it["row"], it["date"], it["amount"], it["principal"], it["profit"],
                    it["handler"], it["req"], len(it["gaps"]), gaps_txt, manual]
            for j, v in enumerate(vals, start=1):
                w.cell(r, j, v)
            fill = OK if not it["gaps"] else (MISS if len(it["gaps"]) == it["req"] else WARN)
            w.cell(r, 8).fill = fill
            r += 1

        for col, width in zip("ABCDEFGHIJ", [8, 11, 11, 10, 10, 10, 7, 8, 62, 15]):
            w.column_dimensions[col].width = width
        w.freeze_panes = w.cell(hr + 1, 1)
        w.auto_filter.ref = f"A{hr}:J{r - 1}"
        for row_cells in w.iter_rows(min_row=hr + 1, max_row=r - 1):
            for c in row_cells:
                c.alignment = Alignment(vertical="top", wrap_text=(c.column == 9))

    # ---------- ⑥ 字段级汇总 ----------
    w = wb.create_sheet("⑥ 字段缺口汇总")
    w.append(["必填字段级缺口 · 按缺口行数降序"])
    w["A1"].font = Font(bold=True, size=14)
    w.append(["同一字段在多条记录上缺，说明源头就没有这一列，不是漏填"])
    w["A2"].font = NOTE_FONT

    hr = 4
    write_header(w, hr, ["记录类型", "必填字段", "补法", "缺口行数", "总行数", "缺口率"])
    rows = []
    for key, fields in FORM.items():
        req = [(fk, lab, src) for fk, lab, r, src in fields if r]
        items = data[key]
        total = len(items)
        for fk, lab, src in req:
            miss = sum(1 for i in items for g, _ in i["gaps"] if g == lab)
            rows.append([TITLE[key], lab, hint_field(fk, src), miss, total,
                         f"{miss / total:.0%}" if total else "0%"])
    rows.sort(key=lambda x: (-x[3], x[0]))
    r = hr + 1
    for vals in rows:
        for j, v in enumerate(vals, start=1):
            w.cell(r, j, v)
        w.cell(r, 4).fill = MISS if vals[3] == vals[4] else (WARN if vals[3] else OK)
        r += 1
    for col, width in zip("ABCDEF", [16, 16, 14, 10, 9, 9]):
        w.column_dimensions[col].width = width
    w.freeze_panes = w.cell(hr + 1, 1)
    w.auto_filter.ref = f"A{hr}:F{r - 1}"

    wb.save(OUT / "缺口工单.xlsx")


def main() -> None:
    n = build_order_csv()
    data = collect()
    build_workbook(data)
    print(f"订单导入_7列.csv：{n} 行")
    print("缺口工单.xlsx 已生成")
    for key in ("HS", "TH", "DG", "SALE"):
        items = data[key]
        gap = sum(len(i["gaps"]) for i in items)
        full = sum(1 for i in items if not i["gaps"])
        print(f"  {TITLE[key]:12} {len(items):3} 条 | 缺口 {gap:4} 格 | 全齐 {full:2} 条")


if __name__ == "__main__":
    main()
