#!/usr/bin/env python3
"""老数据清洗：三份业务 Excel -> 系统导入工作台标准模板 CSV。

目标通道 = 前端「导入工作台」内置模板（STANDARD_ORDER / STANDARD_ACCOUNT / STANDARD_CASHFLOW）。
该通道只登记原始行（不覆盖业务单、不自动匹配、不做字段推断），因此清洗只做
「列对齐 + 可解析性 + 枚举归一」，不改写业务金额，异常一律透出到清单而非静默修正。

利润口径（业务裁决）：利润 = 差价 + 返点，差价 = 订单金额 − 本金。
故「订单金额 = 本金 + 利润」不是校验等式，该式不成立不得判为错账。

关键约束：前端 parseImportText 用简单 split(",") 解析，不支持引号转义，
因此任何单元格内不得出现半角逗号或换行。
"""
from __future__ import annotations

import csv
import re
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import openpyxl

SRC = Path(
    "/Users/aries/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/"
    "wxid_e48tdni624cz22_698d/temp/RWTemp/2026-11/ab633051f10b18ab15049334d905b292"
)
OUT = Path("/Users/aries/黑金时代/outputs/legacy_import")
OUT.mkdir(parents=True, exist_ok=True)

F_ORDER = SRC / "(订单登记及利润)成单登记账号 (5).xlsx"
F_CASH = SRC / "(个人记账明细)收支明细表 (5).xlsx"
F_ACCT = SRC / "(回收账号登记)账号登记表.xlsx"

# 订单类型：系统 order_type_defs 仅 HS(回收) / TH(提号) / DG(代挂) 三类生效
ORDER_TYPE_MAP = {
    "回收": "HS",
    "氪金联盟提号": "TH",
    "代挂": "DG",
    "蹭点": "DG",  # 业务裁决：蹭点归入代挂
}
NON_ORDER = {"返点", "打赏"}

# 源表填报笔误修正（均经用户逐行核对确认）。
# 形式：(日期, 订单类型, 原订单金额, 原本金) -> 该行金额与本金对调
SWAPS: set[tuple[str, str, str, str]] = {
    ("2026-10-10", "HS", "2925.00", "3588.00"),
}

issues: list[str] = []


def clean(value: object, *, limit: int | None = None) -> str:
    """去掉半角逗号/换行，压空白；保证单格可被 split(',') 安全解析。"""
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        return money(value, raw=True)
    text = str(value)
    text = text.replace("\r", " ").replace("\n", " ")
    text = text.replace(",", "/").replace("\u3001", "/")
    text = re.sub(r"\s+", " ", text).strip()
    if limit and len(text) > limit:
        text = text[: limit - 1] + "…"
    return text


def money(value: object, *, raw: bool = False) -> str:
    if value is None or value == "":
        return "0.00"
    try:
        return f"{Decimal(str(value)):.2f}"
    except Exception:
        if not raw:
            issues.append(f"金额无法解析: {value!r}")
        return "0.00"


def to_date(value: object) -> str:
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value.strip()):
        return value.strip()
    return ""


def load(path: Path) -> list[dict[str, object]]:
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    header = [str(c).strip() if c is not None else "" for c in rows[0]]
    out = []
    for idx, row in enumerate(rows[1:], start=2):
        if all(v is None or v == "" for v in row):
            continue
        rec = dict(zip(header, row))
        rec["__row__"] = idx
        out.append(rec)
    return out


def write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as fp:
        writer = csv.writer(fp, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


# ---------------------------------------------------------------- 1. 订单
def build_orders() -> tuple[list[list[str]], list[list[str]]]:
    records = load(F_ORDER)
    header = ["订单日期", "订单类型", "订单金额", "本金", "利润", "经办人", "备注"]
    rows: list[list[str]] = []
    deferred: list[list[str]] = []
    reclassified: list[list[str]] = []

    for rec in records:
        raw_type = clean(rec.get("订单类型"))
        row_no = rec["__row__"]
        if not raw_type and not rec.get("交易金额"):
            issues.append(f"订单表第{row_no}行为空模板行，已剔除")
            continue

        # 回收员/售卖员可能各含多人（源表用逗号分隔），拆分后统一去重
        handler_names: list[str] = []
        for key in ("回收员", "售卖员"):
            raw = clean(rec.get(key))
            for part in raw.split("/"):
                part = part.strip()
                if part and part not in handler_names:
                    handler_names.append(part)
        handler = "/".join(handler_names)

        note_parts = []
        if clean(rec.get("备注")):
            note_parts.append(clean(rec.get("备注")))
        if clean(rec.get("回款账户（本金/利润）")):
            note_parts.append("回款=" + clean(rec.get("回款账户（本金/利润）")).replace("/", "+"))
        note = " | ".join(note_parts)
        month = clean(rec.get("月份"))

        if raw_type in NON_ORDER:
            deferred.append(
                [
                    to_date(rec.get("日期")),
                    raw_type,
                    money(rec.get("交易金额")),
                    money(rec.get("本金")),
                    money(rec.get("利润")),
                    handler,
                    note,
                    month,
                ]
            )
            continue

        code = ORDER_TYPE_MAP.get(raw_type)
        if code is None:
            issues.append(f"订单表第{row_no}行订单类型无法归一({raw_type!r})，已跳过")
            continue

        iso = to_date(rec.get("日期"))
        if not iso:
            issues.append(f"订单表第{row_no}行缺日期，按空值登记")

        amount = money(rec.get("交易金额"))
        principal = money(rec.get("本金"))
        profit = money(rec.get("利润"))

        # 用户核对确认的填报笔误：金额与本金对调
        if (iso, code, amount, principal) in SWAPS:
            amount, principal = principal, amount
            issues.append(f"订单表第{row_no}行 金额/本金 对调修正（用户核对确认）")

        # DG 为零本金型：利润仅为服务费，不含货值差价；但订单金额须保留客户货值，供追溯。
        # 判定以本金为准（业务裁决 2026-11-01）：有本金=库存型（HS/TH），无本金=代挂（DG）。
        # 标注 DG 却带本金的行，按回收(HS)计；标注 HS/TH 却无本金的行，按代挂(DG)计。
        if code == "DG" and Decimal(principal) != 0:
            reclassified.append([to_date(rec.get("日期")), "DG→HS", "DG", "HS", amount, principal, profit, handler, note])
            issues.append(f"订单表第{row_no}行标注 DG 但本金={principal}，已按业务裁决改判回收(HS)")
            code = "HS"
        elif code in ("HS", "TH") and Decimal(principal) == 0:
            reclassified.append(
                [to_date(rec.get("日期")), f"{code}→DG", code, "DG", amount, principal, profit, handler, note]
            )
            issues.append(f"订单表第{row_no}行标注 {code} 但本金=0，已按业务裁决改判代挂(DG)")
            code = "DG"

        rows.append(
            [
                iso,
                code,
                amount,
                principal,
                profit,
                handler,
                note,
            ]
        )

    write_csv(OUT / "订单导入模板.csv", header, rows)
    write_csv(
        OUT / "_改判记录.csv",
        ["订单日期", "改判方向", "原类型", "改判类型", "订单金额", "本金", "利润", "经办人", "备注"],
        reclassified,
    )
    write_csv(
        OUT / "待确认_返点打赏.csv",
        ["日期", "原类型", "交易金额", "本金", "利润", "经办人", "备注", "月份"],
        deferred,
    )
    return rows, deferred


# ---------------------------------------------------------------- 2. 账号库存
def build_accounts() -> list[list[str]]:
    records = load(F_ACCT)
    header = ["库存编号", "平台", "区服", "状态", "买入日期", "买入成本", "预计售价", "备注"]
    rows: list[list[str]] = []

    for rec in records:
        row_no = rec["__row__"]
        # 仅剩「售卖情况」而无日期/金额/账号的空壳行，属源表残留，剔除
        if not rec.get("日期") and not rec.get("回收金额") and not rec.get("账号密码"):
            issues.append(f"账号表第{row_no}行为空壳行（无日期/金额/账号），已剔除")
            continue
        buy = money(rec.get("回收金额"))
        sell = money(rec.get("售卖金额"))
        sold = clean(rec.get("售卖情况"))
        iso = to_date(rec.get("日期"))
        if not iso:
            issues.append(f"账号表第{row_no}行缺日期")

        if sold == "是":
            status = "OUT_OF_STOCK"
        elif sold == "否":
            status = "IN_STOCK"
        else:
            status = "IN_STOCK"
            issues.append(f"账号表第{row_no}行售卖情况为空，状态按在库登记")

        # 平台/区服源表未提供；营地与渠道归入备注，保留可追溯性
        platform = ""
        region = ""
        note_parts = []
        account_no = clean(rec.get("账号密码"))
        if account_no:
            note_parts.append("账号=" + account_no)
        if clean(rec.get("已推广渠道")):
            note_parts.append("渠道=" + clean(rec.get("已推广渠道")))
        if clean(rec.get("营地")):
            note_parts.append("营地=" + clean(rec.get("营地")))
        if clean(rec.get("钱包实名情况")):
            note_parts.append("实名=" + clean(rec.get("钱包实名情况")))
        if clean(rec.get("是否有二次")):
            note_parts.append("二次=" + clean(rec.get("是否有二次")))
        if clean(rec.get("回收人员")):
            note_parts.append("回收人=" + clean(rec.get("回收人员")))
        if clean(rec.get("备注")):
            note_parts.append(clean(rec.get("备注")))
        info = clean(rec.get("账号信息"), limit=60)
        if info:
            note_parts.append("信息=" + info)

        rows.append(
            [
                "",
                platform,
                region,
                status,
                iso,
                buy,
                sell,
                " | ".join(note_parts),
            ]
        )

    write_csv(OUT / "账号导入模板.csv", header, rows)
    return rows


# ---------------------------------------------------------------- 3. 资金流水
def build_cashflow() -> list[list[str]]:
    records = load(F_CASH)
    header = ["发生日期", "金额", "收支方向", "资金池", "业务类型", "订单号", "说明"]
    rows: list[list[str]] = []

    for rec in records:
        row_no = rec["__row__"]
        direction_raw = clean(rec.get("收支"))
        if direction_raw == "收入":
            direction = "IN"
        elif direction_raw == "支出":
            direction = "OUT"
        else:
            issues.append(f"流水表第{row_no}行收支方向异常({direction_raw!r})，已跳过")
            continue

        iso = to_date(rec.get("日期"))
        if not iso:
            issues.append(f"流水表第{row_no}行缺日期")

        detail = clean(rec.get("明细"))
        category = clean(rec.get("类别"))
        # 类别本身含 '/'（如「房租/日用」），与明细之间改用 ' | ' 分隔以免歧义
        note = f"{category} | {detail}" if detail else category

        rows.append([iso, money(rec.get("金额")), direction, "", "", "", note])

    write_csv(OUT / "资金流水导入模板.csv", header, rows)
    return rows


def verify(path: Path, expect_header: list[str]) -> tuple[int, int]:
    """按前端 parseImportText 的解析方式回读，校验列数与逗号污染。"""
    text = path.read_text(encoding="utf-8-sig")
    lines = [ln for ln in text.split("\n") if ln.strip()]
    header = lines[0].split(",")
    assert header == expect_header, f"{path.name} 表头不匹配: {header}"
    bad = 0
    for i, line in enumerate(lines[1:], start=2):
        if len(line.split(",")) != len(expect_header):
            bad += 1
            issues.append(f"{path.name} 第{i}行列数={len(line.split(','))}，应为{len(expect_header)}")
    return len(lines) - 1, bad


def main() -> None:
    orders, deferred = build_orders()
    accounts = build_accounts()
    cash = build_cashflow()

    report = []
    for name, header in (
        ("订单导入模板.csv", ["订单日期", "订单类型", "订单金额", "本金", "利润", "经办人", "备注"]),
        ("账号导入模板.csv", ["库存编号", "平台", "区服", "状态", "买入日期", "买入成本", "预计售价", "备注"]),
        ("资金流水导入模板.csv", ["发生日期", "金额", "收支方向", "资金池", "业务类型", "订单号", "说明"]),
    ):
        n, bad = verify(OUT / name, header)
        report.append(f"{name}: {n} 行，列数异常 {bad} 行")

    print("\n".join(report))
    print(f"待确认_返点打赏.csv: {len(deferred)} 行")
    print(f"\n共 {len(issues)} 条提示：")
    for item in issues:
        print("  -", item)

    (OUT / "清洗提示.txt").write_text("\n".join(issues), encoding="utf-8")


if __name__ == "__main__":
    main()
