#!/usr/bin/env python3
"""按「订单台账」表单的完整字段重排老数据。

字段来源：order_form_fields（is_active=1），按 order_type_code 分组：
  HS    22 字段（回收买入）
  TH    23 字段（提号，账号号价 + 预计收买家合一）
  DG    14 字段（代挂，无金额字段）
  SALE  13 字段（卖出事件，HS/DG 的成交额落在这里）

结构对应关系（老账一行 → 系统记录）：
  HS 行 → 1× HS 订单（recovery_price=本金） + 1× SALE 事件（amount=交易金额）
  TH 行 → 1× TH 订单（th_purchase_amount=本金，th_receive_amount=交易金额）
  DG 行 → 1× DG 订单（无金额）           + 1× SALE 事件（amount=利润/服务费）

源表只能填一部分字段：金额、资金账户、备注可填；账号段仅在账号表能关联时填；
客户段（买家/供货方/客户昵称）源表完全没有，一律留空。
"""
from __future__ import annotations

import csv
import re
import sqlite3
from decimal import Decimal
from pathlib import Path

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

OUT = Path("/Users/aries/黑金时代/outputs/legacy_import")
RAW = Path(
    "/Users/aries/Library/Containers/com.tencent.xinWeChat/Data/Documents/"
    "xwechat_files/wxid_e48tdni624cz22_698d/temp/RWTemp/2026-11/"
    "ab633051f10b18ab15049334d905b292"
)

DB = Path("/Users/aries/黑金时代/backend/data/heijin_erp_v1.db")

# 板块显示名与顺序取自前端字段管理面板的权威定义（FIELD_SECTION_OPTIONS），不自行命名。
SECTION_LABEL = {
    "ACCOUNT_PRODUCT": "账号 / 产品信息",
    "BUSINESS": "业务方案信息",
    "DELIVER": "交付信息",
    "OPERATION": "运营信息",
    "FINANCE": "费用与资金",
    "EXTRA": "其他补充信息",
    "PARTICIPANT": "客户 / 供货方信息",
}
# 顺序严格对齐前端 FIELD_SECTION_OPTIONS 的声明顺序
SECTION_ORDER = ["ACCOUNT_PRODUCT", "BUSINESS", "DELIVER", "OPERATION",
                 "FINANCE", "EXTRA", "PARTICIPANT"]
SOURCE_LABEL = "来源标识"
ORDER_TITLE = {"HS": "HS 回收", "TH": "TH 提号", "DG": "DG 代挂", "SALE": "SALE 卖出"}

# ---- 二级子组（2026-11-01 用户裁决）----
# 板块名本身是「A / B」结构的拆成两半；交付信息按买号 / 卖号阶段拆。
# 两半都建槽：某半在本表无字段时保留占位列，保证各表二级结构左右对称。
FINANCE_FEE_KEYS = frozenset({"intermediary_fee", "service_fee", "per_period_service_fee"})
EMPTY_LABEL = "（本表无字段）"
# 运营信息在订单台账里零固定字段（唯一的 platform_ids 属寄售表单），
# 硬塞一列也录不进库，故占位处直接指向⑦运营信息页，不作静默留空。
SEC_EMPTY_LABEL = {"OPERATION": "（见⑦运营信息）"}


def empty_label(sec: str) -> str:
    return SEC_EMPTY_LABEL.get(sec, EMPTY_LABEL)

SUB_SLOTS: dict[str, tuple[str, ...]] = {
    "ACCOUNT_PRODUCT": ("账号信息", "产品信息"),
    "BUSINESS": ("业务方案信息",),
    "DELIVER": ("买号交付", "卖号交付"),
    "OPERATION": ("运营信息",),
    "FINANCE": ("费用", "资金"),
    "EXTRA": ("其他补充信息",),
    "PARTICIPANT": ("客户信息", "供货方信息"),
}


def sub_of(sec: str, kind: str, field_key: str) -> str:
    """字段 → 二级子组。归属规则集中在此，供说明页同步展示。"""
    if sec == "ACCOUNT_PRODUCT":
        return "账号信息"
    if sec == "DELIVER":
        return "卖号交付" if kind == "SALE" else "买号交付"
    if sec == "FINANCE":
        return "费用" if field_key in FINANCE_FEE_KEYS else "资金"
    if sec == "PARTICIPANT":
        return "供货方信息" if kind == "TH" else "客户信息"
    return SECTION_LABEL[sec]


def load_sections() -> dict[tuple[str, str], str]:
    """(订单类型, 字段键) → 板块。以库中 order_form_fields 为准，不手写。"""
    con = sqlite3.connect(DB)
    try:
        rows = con.execute(
            "select order_type_code, field_key, section from order_form_fields where is_active=1"
        ).fetchall()
    finally:
        con.close()
    return {(t, k): (sec or "EXTRA") for t, k, sec in rows}


# 板块底色：与深蓝字段名行区分，浅底深字，一眼分得开
SECTION_FILL = {
    "ACCOUNT_PRODUCT": PatternFill("solid", fgColor="DDEBF7"),
    "BUSINESS": PatternFill("solid", fgColor="E2EFDA"),
    "DELIVER": PatternFill("solid", fgColor="FFF2CC"),
    "OPERATION": PatternFill("solid", fgColor="FCE4D6"),
    "FINANCE": PatternFill("solid", fgColor="E4DFEC"),
    "PARTICIPANT": PatternFill("solid", fgColor="D9EDF7"),
    "EXTRA": PatternFill("solid", fgColor="F2F2F2"),
}
SECTION_FONT = Font(bold=True, size=10, color="1F3864")
L1_FILL = PatternFill("solid", fgColor="1F3864")     # 一级：订单类型
L1_FONT = Font(bold=True, size=11, color="FFFFFF")
L2_FONT = Font(bold=True, size=10, color="1F3864")
EMPTY_FONT = Font(italic=True, size=9, color="808080")
EMPTY_FILL = PatternFill("solid", fgColor="FAFAFA")

HDR = PatternFill("solid", fgColor="1F4E79")
HF = Font(color="FFFFFF", bold=True, size=11)
MISS = PatternFill("solid", fgColor="FCE4D6")   # 必填但缺
PART = PatternFill("solid", fgColor="FFF2CC")   # 选填缺 / 部分缺
OK = PatternFill("solid", fgColor="E2EFDA")

# ---------------------------------------------------------------- 表单字段
# (field_key, 中文标签, 必填, 源表来源说明)
FORM: dict[str, list[tuple[str, str, bool, str]]] = {
    "HS": [
        ("game_type", "游戏类型", True, "推断：账号文案英雄名/皮肤术语"),
        ("game_account", "游戏账号", True, "账号表「账号密码」(9~10位QQ号)"),
        ("game_password", "账号密码", True, "账号表「密码」"),
        ("channel_region", "渠道／区服", True, "推断：仅认账号文案 aq/iq/aw/iw（营地列是数字ID非区服）"),
        ("has_secondary", "有无二次", True, "账号表「是否有二次」"),
        ("game_account_note", "账号备注", False, "账号表「账号信息」描述原文+营地ID+图片线索"),
        ("bound_phone", "换绑手机号", False, "账号表「绑定手机号」（买号交付阶段）"),
        ("bound_phone_owner", "手机号绑定人", False, "无"),
        ("intermediary_platform", "交易平台", False, "账号表「已推广渠道」"),
        ("intermediary_type", "中介类型", False, "无（可从账号备注推断）"),
        ("compensation_type", "包赔类型", False, "无（可从账号备注推断）"),
        ("recovery_price", "账号号价", True, "成单表「本金」"),
        ("intermediary_fee", "中介费", False, "无（可由 金额-本金-利润 推算）"),
        ("payment_pool_id", "资金账户", True, "成单表「回款账户」"),
        ("payment_note", "资金流水备注", False, "成单表「备注」"),
        ("customer_nickname", "客户昵称", False, "无"),
        ("customer_source", "客户来源", False, "无"),
        ("customer_contact_name", "姓名", False, "无"),
        ("customer_phone", "手机号", False, "无"),
        ("customer_wechat", "微信号", False, "无"),
        ("customer_qq", "QQ", False, "无"),
        ("note", "客户备注", False, "无"),
    ],
    "TH": [
        ("game_type", "游戏类型", True, "推断：账号文案英雄名/皮肤术语"),
        ("game_account", "游戏账号", True, "账号表「账号密码」(9~10位QQ号)"),
        ("game_password", "账号密码", True, "账号表「密码」"),
        ("channel_region", "渠道／区服", True, "推断：仅认账号文案 aq/iq/aw/iw（营地列是数字ID非区服）"),
        ("has_secondary", "有无二次", False, "账号表「是否有二次」"),
        ("game_account_note", "账号备注", False, "账号表「账号信息」描述原文+营地ID+图片线索"),
        ("bound_phone", "换绑手机号", False, "账号表「绑定手机号」（买号交付阶段）"),
        ("intermediary_platform", "交易平台", False, "账号表「已推广渠道」"),
        ("intermediary_type", "中介类型", False, "无"),
        ("compensation_type", "包赔类型", False, "无"),
        ("th_purchase_amount", "账号号价", True, "成单表「本金」"),
        ("th_receive_amount", "预计收买家", True, "成单表「交易金额」"),
        ("intermediary_fee", "中介费", False, "无"),
        ("payment_pool_id", "资金账户", True, "成单表「回款账户」"),
        ("payment_note", "资金流水备注", False, "成单表「备注」"),
        ("supplier_nickname", "供货方昵称", True, "成单表「回收员」（待确认）"),
        ("supplier_source", "供货方来源", True, "无"),
        ("supplier_source_other", "其他来源", False, "无"),
        ("supplier_contact_name", "公司名", False, "无"),
        ("supplier_phone", "手机号", False, "无"),
        ("supplier_wechat", "微信号", False, "无"),
        ("supplier_qq", "QQ", False, "无"),
        ("supplier_note", "供货方备注", False, "无"),
    ],
    "DG": [
        ("game_type", "游戏类型", True, "无"),
        ("game_account", "游戏账号", True, "无"),
        ("game_password", "账号密码", True, "无"),
        ("channel_region", "渠道／区服", True, "无"),
        ("has_secondary", "有无二次", False, "无"),
        ("game_account_note", "账号备注", False, "无"),
        ("bound_phone", "换绑手机号", False, "无（卖号交付换绑号源表未记录）"),
        ("dg_customer_nickname", "客户昵称", True, "无"),
        ("dg_customer_source", "客户来源", False, "无"),
        ("dg_customer_contact", "姓名", False, "无"),
        ("dg_customer_phone", "手机号", False, "无"),
        ("dg_customer_wechat", "微信号", False, "无"),
        ("dg_customer_qq", "QQ", False, "无"),
        ("dg_note", "代挂备注", False, "成单表「备注」"),
    ],
    "SALE": [
        ("bound_phone", "换绑手机号", False, "账号表「绑定手机号」（买号交付阶段）"),
        ("bound_phone_owner", "手机号绑定人", False, "无"),
        ("amount", "售出金额", True, "成单表「交易金额」（DG 取利润）"),
        ("payment_method", "付款方式", False, "无（默认全款）"),
        ("pool_id", "资金账户", True, "成单表「回款账户」"),
        ("down_payment", "首付金额", False, "无"),
        ("service_fee", "分期服务费总额", False, "无"),
        ("periods", "分期期数", False, "无"),
        ("per_period_service_fee", "每期服务费", False, "无"),
        ("per_period", "每期金额", True, "全款时 = 售出金额"),
        ("first_due_on", "首期日期", True, "全款时 = 成交日期"),
        ("customer_id", "买家", True, "无"),
        ("note", "备注", False, "成单表「备注」"),
    ],
}

POOL = {
    "投资款荷包": "HJ_INVEST",
    "利润荷包": "HJ_PROFIT",
    "经营资金池": "HJ_RUN",
}
PLATFORMS = ("千寻", "盼之", "白情", "螃蟹", "私下")

# 游戏/区服推断：源表无该列，只能从「账号信息」营销文案反推。
# 王者荣耀英雄名 + 皮肤术语（典藏/无双/珍传/天幕）是其商品文案的固定特征。
KING_HEROES = (
    "小乔", "貂蝉", "露娜", "西施", "甄姬", "公孙离", "海诺", "夏洛特", "戈雅", "不知火舞",
    "瑶", "大乔", "安琪拉", "妲己", "李白", "韩信", "花木兰", "上官婉儿", "蔡文姬", "庄周",
    "鲁班", "后羿", "孙悟空", "武则天", "嫦娥", "杨玉环", "镜", "澜", "云缨", "阿古朵",
    "海月", "蒙犽", "伽罗", "黄忠", "张飞", "鬼谷子", "太乙", "芈月", "姜子牙", "女娲",
    "沈梦溪", "曜", "阿轲", "司马懿", "亚瑟", "廉颇",
)
KING_TERMS = ("典藏", "无双", "珍传", "传说", "天幕", "金标", "银标", "国标", "万战", "荣耀")


def infer_game(text: str) -> str:
    if not text:
        return ""
    if any(h in text for h in KING_HEROES):
        return "王者荣耀"
    if any(t in text for t in KING_TERMS):
        return "王者荣耀"
    return ""


def infer_region(text: str) -> str:
    """aq / iq / aw / iw 是账号文案里的平台+区服缩写。"""
    if not text:
        return ""
    low = text.lower()
    for token, label in (("aq", "安卓QQ"), ("iq", "iOS QQ"), ("aw", "安卓微信"), ("iw", "iOS微信")):
        if token in low:
            return label
    if "安卓" in text:
        return "安卓"
    if "苹果" in text or "ios" in low:
        return "iOS"
    return ""


# ---------------------------------------------------------------- 运营信息
# 账号表「账号信息」是**销售文案**，混装了三类信息：
#   ① 账号资产（皮肤/英雄/段位/营地ID）→ 属账号属性，留在「账号备注」
#   ② 运营信息（挂牌价、降价动作、售后承诺、营销卖点标签）→ 属运营，单独抽列
#   ③ 话术尾巴（喜欢dd）→ 噪音，直接丢弃
# 原文里的 🈵/🈶/🈚/1️⃣ 承载语义（满皮肤、有二次、序号），**不得做符号擦除**，
# 否则 "🈵貂蝉" 会退化成 " 貂蝉"、把"满"这层含义抹掉。故备注只删价格与话术。
OPS_QUOTE = re.compile(r"宜?\s*[💰🥰]\s*([0-9]{3,6})")
OPS_CUT = re.compile(r"降价[❗!️]*\s*([0-9]{3,6})")
OPS_SERVICE = re.compile(
    r"包脸|包赔|免费补[全]?皮|[\u4e00-\u9fa5]{1,6}已补"
)
# 营销话术 vs 账号属性必须分开：
#   小漂亮/精品/精氪/带妹/在榜… 是销售话术，从备注剥离，进「营销标签」列；
#   无丑/全女/女用/小女号 描述的是皮肤构成（女性皮肤为主、无丑皮），是账号属性，
#   留在备注，不得当话术删掉。
OPS_TAG_WORDS = ("小漂亮", "小美丽", "大漂亮", "精品", "极品", "带妹",
                 "在榜", "高质量", "精氪", "大全套", "米米", "皮肤号")
OPS_TAG = re.compile("|".join(OPS_TAG_WORDS))
# 删除时把「小漂亮号」的词尾「号」一并吃掉，否则会残留一个孤零零的「号」
NOTE_TAG_DROP = re.compile(
    r"(?:小漂亮|小美丽|大漂亮)号?|"
    + "|".join(w for w in OPS_TAG_WORDS if w not in ("小漂亮", "小美丽", "大漂亮"))
)
ASSET_TAG = re.compile(r"无丑|全女|女用|小女号")
OPS_HONOR = re.compile(
    r"[0-9]+\s*段[\u4e00-\u9fa5]{0,3}|[0-9]+\s*级精英收藏家|巅峰[0-9]{3,4}\+?"
    r"|小国[（(]?[\u4e00-\u9fa5]{0,4}[)）]?|国标|金标|银标|万战"
)
NOTE_DROP = (
    re.compile(r"[［\[][^］\]]{0,20}免费补[全]?皮[^］\]]{0,3}[］\]]"),   # 括号内整段承诺
    re.compile(r"免费补[全]?皮[❗!️]*"),
    re.compile(r"[\u4e00-\u9fa5]{1,6}已补[❗!️]*"),
    re.compile(r"包脸|包赔"),
    re.compile(r"宜?\s*[💰🥰]\s*[0-9]{3,6}"),      # 挂牌价
    re.compile(r"降价[❗!️]*\s*[0-9]{3,6}"),        # 降价前标价
    re.compile(r"喜欢\s*d+", re.I),                # 话术尾巴
    NOTE_TAG_DROP,                                 # 营销话术
)


def extract_ops(text: str) -> dict[str, str]:
    """从销售文案里抽运营侧字段。原文不动，抽取只为单独成列。"""
    t = str(text or "")
    quote = OPS_QUOTE.search(t)
    before = OPS_CUT.search(t)
    tags = OPS_TAG.findall(t) + ASSET_TAG.findall(t)
    return {
        "quote": quote.group(1) if quote else "",
        "quote_before": before.group(1) if before else "",
        "price_cut": "是" if before else "",
        "service": "/".join(dict.fromkeys(OPS_SERVICE.findall(t))),
        "tags": "/".join(dict.fromkeys(tags)),
        "honor": "/".join(dict.fromkeys(OPS_HONOR.findall(t))),
    }


def clean_note(text: str) -> str:
    """账号备注：摘掉价格、售后承诺、营销话术与话术尾巴；资产与 emoji 原样保留。"""
    s = str(text or "")
    for p in NOTE_DROP:
        s = p.sub(" ", s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s).strip(" ，、。|/")
    return s


def money(v) -> Decimal:
    try:
        return Decimal(str(v)).quantize(Decimal("0.01"))
    except Exception:
        return Decimal("0.00")


def cell(v) -> str:
    """任何单元格不得含半角逗号/换行：导入解析是裸 split(',')。"""
    s = "" if v is None else str(v).strip()
    s = s.replace(",", "/").replace("\r", " ").replace("\n", " ")
    return re.sub(r"\s+", " ", s).strip()


def read_csv(name: str) -> tuple[list[str], list[dict[str, str]]]:
    lines = [l for l in (OUT / name).read_text(encoding="utf-8-sig").split("\n") if l.strip()]
    head = lines[0].split(",")
    return head, [dict(zip(head, l.split(","))) for l in lines[1:]]


def load_accounts() -> list[dict[str, str]]:
    wb = openpyxl.load_workbook(RAW / "(回收账号登记)账号登记表.xlsx", data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    head = [str(c).strip() if c is not None else "" for c in rows[0]]
    out = []
    for i, r in enumerate(rows[1:], start=2):
        if not any(v not in (None, "") for v in r):
            continue
        d = {k: r[i2] for i2, k in enumerate(head)}
        if not d.get("账号密码") and not d.get("回收金额"):
            continue
        d["_row"] = i                       # 源表行号，⑦页回查用
        out.append(d)
    return out


def pool_of(text: str) -> str:
    """回款账户原文 → 主资金账户。

    双荷包（本金回投资款、利润回利润）在系统里是两条流水，不是两列；
    故取利润荷包为主账户，原始两荷包信息保留在备注。
    """
    if "利润荷包" in text:
        return "利润荷包"
    if "投资款荷包" in text:
        return "投资款荷包"
    return ""


def platform_of(text: str) -> str:
    """已推广渠道多选时无法判定实际成交平台，仅单一平台时填。"""
    hits = [p for p in PLATFORMS if p in text]
    return hits[0] if len(hits) == 1 else ""


def build() -> None:
    _, orders = read_csv("订单导入模板.csv")
    accounts = load_accounts()
    SEC = load_sections()

    # 每条账号先算好运营侧字段与剥离后的备注，供数据页与⑦运营信息页共用
    for a in accounts:
        raw = str(a.get("账号信息") or "")
        a["_ops"] = extract_ops(raw)
        a["_note_clean"] = clean_note(raw)

    # 账号表按回收金额建索引；仅唯一时可关联，避免张冠李戴
    idx: dict[Decimal, list[dict[str, str]]] = {}
    for a in accounts:
        idx.setdefault(money(a.get("回收金额")), []).append(a)

    def acct_for(principal: Decimal) -> dict[str, str] | None:
        hits = idx.get(principal, [])
        return hits[0] if len(hits) == 1 else None

    rows: dict[str, list[list[str]]] = {k: [] for k in ("HS", "TH", "DG", "SALE")}
    meta: dict[str, list[list[str]]] = {k: [] for k in ("HS", "TH", "DG", "SALE")}

    for n, o in enumerate(orders, start=2):
        kind = o["订单类型"]
        iso = o["订单日期"]
        amt = money(o["订单金额"])
        pri = money(o["本金"])
        pro = money(o["利润"])
        handler = o["经办人"]
        note = o["备注"]
        pool_txt = note.split("|")[0] if "回款=" in note else ""
        pool = pool_of(note)
        acct = acct_for(pri) if kind in ("HS", "TH") and pri > 0 else None

        # 源表三列的语义务必分清（易混）：
        #   账号密码 → 真实游戏账号（9~10 位 QQ 号）
        #   密码     → 真实密码
        #   账号信息 → 商品描述长文本（皮数/英雄/皮肤名，几十到两百字），属描述而非账号
        acct_text = str(acct.get("账号信息") or "") if acct else ""
        camp_id = cell(acct.get("营地")) if acct else ""
        img_cnt = 0
        if acct:
            img_cnt = sum(1 for c in ("图片和附件_1", "图片和附件_2") if acct.get(c))

        # 描述落「账号备注」：只留账号资产描述（挂牌价/降价/话术尾巴已剥离，
        # 见⑦运营信息页），营地 ID 与图片为补充线索一并附上
        note_parts: list[str] = []
        if acct:
            kept = acct["_note_clean"]
            if kept:
                note_parts.append(cell(kept))
        if camp_id:
            note_parts.append(f"营地ID={camp_id}")
        if img_cnt:
            note_parts.append(f"源表有图{img_cnt}张(未导出)")

        common_acct = {
            "game_type": infer_game(acct_text),
            "game_account": cell(acct.get("账号密码")) if acct else "",
            "game_password": cell(acct.get("密码")) if acct else "",
            # 区服只认文案里的 aq/iq/aw/iw 缩写；营地列是 7~10 位数字 ID，不是区服
            "channel_region": infer_region(acct_text),
            "has_secondary": ("有" if str(acct.get("是否有二次")).strip() == "是" else "无")
            if acct and acct.get("是否有二次") else "",
            "game_account_note": " | ".join(note_parts),
            "bound_phone": cell(acct.get("绑定手机号")) if acct else "",
            "intermediary_platform": platform_of(str(acct.get("已推广渠道") or "")) if acct else "",
            "intermediary_type": "",
            "compensation_type": "",
            "payment_pool_id": pool,
            "payment_note": note,
        }

        if kind == "HS":
            vals = {
                **common_acct,
                "bound_phone_owner": "",
                "recovery_price": f"{pri:.2f}",
                "intermediary_fee": "",
                "customer_nickname": "", "customer_source": "", "customer_contact_name": "",
                "customer_phone": "", "customer_wechat": "", "customer_qq": "", "note": "",
            }
            rows["HS"].append([vals[k] for k, _, _, _ in FORM["HS"]])
            meta["HS"].append([str(n), iso, kind, handler])

        elif kind == "TH":
            vals = {
                **common_acct,
                "th_purchase_amount": f"{pri:.2f}",
                "th_receive_amount": f"{amt:.2f}",
                "intermediary_fee": "",
                "supplier_nickname": handler,
                "supplier_source": "", "supplier_source_other": "", "supplier_contact_name": "",
                "supplier_phone": "", "supplier_wechat": "", "supplier_qq": "", "supplier_note": "",
            }
            rows["TH"].append([vals[k] for k, _, _, _ in FORM["TH"]])
            meta["TH"].append([str(n), iso, kind, handler])

        elif kind == "DG":
            vals = {
                "game_type": "", "game_account": "", "game_password": "", "channel_region": "",
                "has_secondary": "", "game_account_note": "", "bound_phone": "",
                "dg_customer_nickname": "", "dg_customer_source": "", "dg_customer_contact": "",
                "dg_customer_phone": "", "dg_customer_wechat": "", "dg_customer_qq": "",
                "dg_note": note,
            }
            rows["DG"].append([vals[k] for k, _, _, _ in FORM["DG"]])
            meta["DG"].append([str(n), iso, kind, handler])

        # SALE：HS 记成交额；DG 记利润（服务费）
        if kind in ("HS", "DG"):
            sale_amt = amt if kind == "HS" else pro
            sv = {
                # 交付分两阶段，不可混用：
                #   买号交付（订单 DELIVER 段）→ 收号时的换绑号，源表「绑定手机号」可填
                #   卖号交付（本 SALE 的 DELIVER 段）→ 交给买家时换绑的号，源表从未记录，必须留空
                "bound_phone": "",
                "bound_phone_owner": "",
                "amount": f"{sale_amt:.2f}",
                "payment_method": "FULL",
                "pool_id": pool,
                "down_payment": "", "service_fee": "", "periods": "",
                "per_period_service_fee": "",
                "per_period": f"{sale_amt:.2f}",
                "first_due_on": iso,
                "customer_id": "",
                "note": note,
            }
            rows["SALE"].append([sv[k] for k, _, _, _ in FORM["SALE"]])
            meta["SALE"].append([str(n), iso, kind, handler])

    # ---------------- CSV 产出
    for key, table in rows.items():
        head = ["源行号", "日期", "类型", "经办人"] + [lab for _, lab, _, _ in FORM[key]]
        with (OUT / f"台账_{key}.csv").open("w", newline="", encoding="utf-8-sig") as fp:
            w = csv.writer(fp)
            w.writerow(head)
            for m, r in zip(meta[key], table):
                w.writerow(m + r)

    # ---------------- xlsx
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "① 字段覆盖"
    ws.append(["订单台账表单 · 字段覆盖核对"])
    ws["A1"].font = Font(bold=True, size=15)
    ws.append(["字段定义取自 order_form_fields（is_active=1）；「能填」= 源表存在对应列且已赋值"])
    ws["A2"].font = Font(color="808080", size=10)
    ws.append([])

    start = ws.max_row + 1
    ws.append(["表单", "板块", "子组", "字段", "必填", "源表来源", "能填行数", "总行数", "覆盖率", "状态"])
    for c in ws[start]:
        c.fill = HDR
        c.font = HF

    for key, fields in FORM.items():
        total = len(rows[key])
        for i, (fk, lab, req, src) in enumerate(fields):
            filled = sum(1 for r in rows[key] if r[i].strip())
            rate = filled / total if total else 0
            if filled == total and total:
                state, fill = "完整", OK
            elif filled == 0:
                state, fill = ("必填缺口" if req else "源表无数据"), (MISS if req else PART)
            else:
                state, fill = "部分覆盖", PART
            code = SEC.get((key, fk), "EXTRA")
            sec = SECTION_LABEL.get(code, SECTION_LABEL["EXTRA"])
            ws.append([key, sec, sub_of(code, key, fk), lab, "必填" if req else "选填",
                       src, filled, total, f"{rate:.0%}", state])
            ws.cell(ws.max_row, 10).fill = fill

    for col, width in zip("ABCDEFGHIJ", [8, 20, 14, 16, 6, 34, 10, 8, 9, 12]):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = f"A{start + 1}"
    ws.auto_filter.ref = f"A{start}:I{ws.max_row}"

    # 数据页
    sheets = {"HS": "② HS 回收", "TH": "③ TH 提号", "DG": "④ DG 代挂", "SALE": "⑤ SALE 卖出"}
    for key, title in sheets.items():
        w = wb.create_sheet(title)

        # 列计划：(板块, 子组, 字段序号|None, 字段名, 必填)
        plan: list[tuple[str, str, int | None, str, bool]] = []
        for sec in SECTION_ORDER:
            slots = SUB_SLOTS[sec]
            idxs = [i for i, (fk, _, _, _) in enumerate(FORM[key])
                    if SEC.get((key, fk), "EXTRA") == sec]
            if not idxs:                      # 整块无字段：每个子组槽各占一列
                plan.extend((sec, slot, None, empty_label(sec), False) for slot in slots)
                continue
            for slot in slots:
                members = [i for i in idxs if sub_of(sec, key, FORM[key][i][0]) == slot]
                if members:
                    plan.extend((sec, slot, i, FORM[key][i][1], FORM[key][i][2]) for i in members)
                else:                          # 该半无字段：保留占位，保持左右对称
                    plan.append((sec, slot, None, empty_label(sec), False))
        covered = {p[2] for p in plan if p[2] is not None}
        for i, (fk, lab, req, _) in enumerate(FORM[key]):
            if i not in covered:               # 兜底：不属 7 板块的 section 也不丢字段
                sec = SEC.get((key, fk), "EXTRA")
                plan.append((sec, SECTION_LABEL[sec], i, lab, req))

        ncol = 4 + len(plan)
        lv1 = [SOURCE_LABEL] * 4 + [SECTION_LABEL[p[0]] for p in plan]
        lv2 = ["源表原始列"] * 4 + [p[1] for p in plan]
        lv3 = ["源行号", "日期", "类型", "经办人"] + [p[3] for p in plan]

        # ---- 一级与二级同名 → 纵向合并成 ONE 格 ----
        # 业务方案信息 / 运营信息 / 其他补充信息 的板块名就是子组名，上下重复显示没意义。
        # 只有「整段一级板块 run 全部同名」才纵并：部分同名时纵并与横并范围会互相重叠，
        # openpyxl 会写出损坏的合并区，故保守不合并。
        runs: list[tuple[int, int]] = []          # 0-based 列区间
        i = 0
        while i < ncol:
            j = i
            while j + 1 < ncol and lv1[j + 1] == lv1[i]:
                j += 1
            runs.append((i, j))
            i = j + 1

        vert: list[tuple[int, int]] = []
        for s, e in runs:
            if s >= 4 and all(lv2[k] == lv1[k] for k in range(s, e + 1)):
                vert.append((s, e))
                for k in range(s, e + 1):
                    lv2[k] = ""                    # 已并入一级格，二级不再重复显示
        vert_cols = {k for s, e in vert for k in range(s, e + 1)}

        # ---------- 三级表头：一级板块 / 二级子组 / 三级字段名 ----------
        for j, v in enumerate(lv1, start=1):
            w.cell(1, j, v)
        for j, v in enumerate(lv2, start=1):
            w.cell(2, j, v)
        for j, v in enumerate(lv3, start=1):
            w.cell(3, j, v)

        for j in range(1, ncol + 1):
            c = w.cell(1, j)
            c.fill = L1_FILL
            c.font = L1_FONT
            c.alignment = Alignment(horizontal="center", vertical="center")
            c2 = w.cell(3, j)
            c2.fill = HDR
            c2.font = HF
            c2.alignment = Alignment(horizontal="center", vertical="center")

        # 二级配色：按所属板块取色；占位槽浅灰斜体
        for j, p in enumerate(plan, start=5):
            c = w.cell(2, j)
            c.fill = SECTION_FILL.get(p[0], SECTION_FILL["EXTRA"])
            c.font = L2_FONT
            c.alignment = Alignment(horizontal="center", vertical="center")
            if p[2] is None:
                c.font = EMPTY_FONT
        for j in range(1, 5):
            c = w.cell(2, j)
            c.fill = SECTION_FILL["EXTRA"]
            c.font = L2_FONT
            c.alignment = Alignment(horizontal="center", vertical="center")

        # 横向合并：第 1 行同类合并，第 2 行合并至板块边界内（None = 该格不参与横并）
        def merge_runs(row: int, keys: list[object]) -> None:
            i = 0
            while i < len(keys):
                if keys[i] is None:
                    i += 1
                    continue
                j = i
                while j + 1 < len(keys) and keys[j + 1] == keys[i]:
                    j += 1
                if j > i:
                    w.merge_cells(start_row=row, start_column=i + 1, end_row=row, end_column=j + 1)
                i = j + 1

        # 第 1 行：整段板块 run 合并；纵向合并段跳过（它自己跨两行）
        merge_runs(1, [None if k in vert_cols else lv1[k] for k in range(ncol)])
        # 第 2 行：按 (板块, 子组) 组合判定，避免跨板块误并
        merge_runs(2, [None if k in vert_cols else f"{lv1[k]}|{lv2[k]}" for k in range(ncol)])
        # 纵向合并：一级格向下吃掉二级那一行
        for s, e in vert:
            w.merge_cells(start_row=1, start_column=s + 1, end_row=2, end_column=e + 1)
        w.row_dimensions[1].height = 24
        w.row_dimensions[2].height = 22
        w.row_dimensions[3].height = 22

        # 数据行：占位列留空；必填为空标红
        for m, r in zip(meta[key], rows[key]):
            w.append(m + [(r[p[2]] if p[2] is not None else "") for p in plan])
            for j, p in enumerate(plan, start=5):
                if p[4] and p[2] is not None and not r[p[2]]:
                    w.cell(w.max_row, j).fill = MISS
        w.freeze_panes = "E4"
        w.auto_filter.ref = f"A3:{get_column_letter(ncol)}{w.max_row}"
        for i in range(1, ncol + 1):
            w.column_dimensions[get_column_letter(i)].width = 12 if i <= 4 else 18

    # ---------------- ⑦ 运营信息（账号口径）
    # 运营信息是**账号级**（随库存档案走），订单台账里的 OPERATION 板块零固定字段，
    # 唯一的 platform_ids 属寄售表单（CONSIGN）。故单独成页，不进订单表：
    # 硬加列到台账只会变成录不进库的占位。
    w = wb.create_sheet("⑦ 运营信息")
    w.append(["账号运营信息 · 从「账号信息」销售文案中抽出"])
    w["A1"].font = Font(bold=True, size=15)
    w.append([
        "运营信息属账号（库存）口径，不属订单。订单台账 OPERATION 板块零固定字段"
        "（仅寄售表单有 platform_ids），故此页独立；如需落库，须在字段管理为 HS/TH/DG "
        "建 OPERATION 活字段（form_extra），字段清单见⑥结构说明末段"
    ])
    w["A2"].font = Font(color="808080", size=10)
    w.append([])

    ops_head = ["源行号", "日期", "回收金额", "售卖金额", "售卖情况",
                "挂牌价", "挂牌-成交价差", "降价前标价", "降价", "售后承诺",
                "营销标签", "段位荣誉", "已推广渠道", "游戏账号", "渠道／区服",
                "账号备注（剥离运营后）", "文案原文（留档）"]
    # 表头行写死第 4 行（A1 标题 / A2 说明 / A3 空行）。
    # 不用 append 定位：空行不落单元格时 w.max_row 不前进，append 会与表头抢行。
    hrow = 4
    for j, v in enumerate(ops_head, start=1):
        c = w.cell(hrow, j, v)
        c.fill = HDR
        c.font = HF
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    row = hrow + 1
    for a in accounts:
        ops = a["_ops"]
        raw = str(a.get("账号信息") or "")
        sale = a.get("售卖金额")
        quote = ops["quote"]
        gap = ""
        if quote and isinstance(sale, (int, float)):
            gap = f"{Decimal(str(sale)) - Decimal(quote):.2f}"
        vals = [
            str(a["_row"]),
            cell(a.get("日期")),
            f"{money(a.get('回收金额')):.2f}" if a.get("回收金额") not in (None, "") else "",
            f"{Decimal(str(sale)):.2f}" if isinstance(sale, (int, float)) else cell(sale),
            cell(a.get("售卖情况")),
            quote, gap, ops["quote_before"], ops["price_cut"],
            cell(ops["service"]), cell(ops["tags"]), cell(ops["honor"]),
            cell(a.get("已推广渠道")),
            cell(a.get("账号密码")),
            infer_region(raw),
            cell(a["_note_clean"]).replace("\n", " "),
            cell(raw).replace("\n", " "),
        ]
        for j, v in enumerate(vals, start=1):
            w.cell(row, j, v)
        row += 1
    last = row - 1

    for col, width in zip("ABCDEFGHIJKLMNOPQ",
                          [7, 11, 10, 10, 8, 9, 12, 11, 6, 22, 26, 26, 18, 14, 12, 52, 60]):
        w.column_dimensions[col].width = width
    w.freeze_panes = w.cell(hrow + 1, 3)
    w.auto_filter.ref = f"A{hrow}:Q{last}"
    for r in w.iter_rows(min_row=hrow + 1, max_row=last):
        for c in r:
            # 备注与原文两列是长文本，必须换行；其余列保持单行以免行高被撑乱
            c.alignment = Alignment(vertical="top", wrap_text=c.column >= 16)
    # 成交价低于挂牌价（价差为负）标出来：那条让价空间，是定价动作留下的痕迹
    for r in w.iter_rows(min_row=hrow + 1, max_row=last, min_col=7, max_col=7):
        for c in r:
            v = str(c.value or "")
            if re.fullmatch(r"-?\d+(\.\d+)?", v) and Decimal(v) < 0:
                c.fill = PART

    # 说明页
    w = wb.create_sheet("⑥ 结构说明")
    w.append(["项", "说明"])
    for c in w[1]:
        c.fill = HDR
        c.font = HF
    for row in [
        ["老账一行 = 系统几张单", "HS：1 张 HS 回收单 + 1 条 SALE 卖出事件；TH：1 张 TH 单（号价与收买家合一）；DG：1 张 DG 单 + 1 条 SALE 事件（记服务费）"],
        ["HS 没有「售出金额」字段", "HS 表单只有 recovery_price（账号号价，即买入成本）；卖出金额属 SALE 事件，故单独出表"],
        ["DG 没有金额字段", "DG 表单 14 个字段全是账号与客户信息，服务费只能通过 SALE 事件登记"],
        ["资金账户双荷包", "源表「回款账户」多为「投资款荷包（本金）,利润荷包（利润）」双选；系统 payment_pool_id 单选，故取利润荷包为主账户，本金归位另记流水"],
        ["客户段全缺", "源表从未记录买家 / 供货方 / 客户昵称，HS 7 个客户字段、TH 6 个供货方字段、DG 6 个客户字段无源可填"],
        ["账号表三列语义（易混）", "「账号密码」=真实游戏账号（9~10 位 QQ 号）；「密码」=真实密码；「账号信息」=商品描述长文本（皮数/英雄/皮肤名，22 行超 50 字、最长 209 字），是描述不是账号。长描述完整落入「账号备注」，不塞进账号列"],
        ["营地区别于区服", "账号表「营地」列是王者营地 ID（7~10 位纯数字），不是渠道区服；已并入账号备注单独标注「营地ID=」，渠道／区服只认文案里的 aq/iq/aw/iw"],
        ["源表图片未导出", "「图片和附件_1/2」是 WPS 嵌入图公式 DISPIMG(ID_xxx)，无法随表格导出为图片文件；已在账号备注标注「源表有图N张」留痕"],
        ["账号备注只留账号属性",
         "「账号信息」原文是销售文案，混装三类：账号资产（皮肤/英雄/段位/营地ID）、运营信息（挂牌价、降价动作、售后承诺、营销话术）、话术尾巴（喜欢dd）。"
         "备注列已剥离价格、售后承诺与营销话术，保留资产事实与段位荣誉；emoji 与序号（🈵=满皮、🈶=有二次、1️⃣）原样保留——"
         "符号擦除会把「🈵貂蝉」退化成「 貂蝉」，把「满」这层含义抹掉，属信息损失，故不做"],
        ["运营信息去哪了（⑦页）",
         "运营信息是账号（库存）口径，不属订单。订单台账 OPERATION 板块零固定字段（唯一 platform_ids 属寄售表单 CONSIGN），"
         "硬加列也录不进库，故按账号口径独立成⑦页：挂牌价、降价前标价、降价标记、挂牌-成交价差、售后承诺、营销标签、段位荣誉、推广渠道、售卖情况，末列保留文案原文留档"],
        ["营销话术 vs 账号属性",
         "小漂亮 / 小美丽 / 大漂亮 / 精品 / 极品 / 精氪 / 带妹 / 在榜 / 高质量 / 大全套 / 皮肤号 是销售话术，已从备注剥离；"
         "无丑 / 全女 / 女用 / 小女号 描述皮肤构成（女用皮为主、无丑皮），属账号属性，留在备注不删。两者混为一谈会把属性当话术删光"],
        ["若要落库：需建的活字段",
         "在字段管理为 HS/TH/DG 各建 OPERATION 活字段（写入 form_extra）：sale_quote 挂牌价(NUMBER)、"
         "quote_before_cut 降价前标价(NUMBER)、price_cut_flag 是否降价(SELECT 是/否)、"
         "service_commit 售后承诺(TEXT)、marketing_tags 营销标签(TEXT)、honor 段位荣誉(TEXT)。"
         "注意：参与核算的价格字段不宜长期放活字段，定价口径定稿后应升格为固定字段"],
        ["挂牌价 ≠ 售卖金额",
         "账号表「售卖金额」是实际成交价；文案里的 💰/🥰 数字是当初挂牌价。26 条文案里 17 条带挂牌价："
         "9 条挂牌高于成交（⑦页价差为负、标黄）、5 条持平、3 条成交高于挂牌；另 9 条无挂牌价。"
         "另有 1 条只留降价标记（12500 → 成交 10888）。两者不可互替"],
        ["账号段半缺", "账号信息只在账号登记表里，且仅当「回收金额」唯一等于订单本金时才能关联，覆盖为部分"],
        ["游戏类型/区服靠推断", "源表无这两列。game_type 由账号文案的英雄名与皮肤术语（典藏/无双/珍传/天幕）判定为王者荣耀；channel_region 由 aq/iq/aw/iw 缩写判定安卓QQ / iOS QQ / 安卓微信 / iOS微信。属推断值，需人工抽检"],
        ["交付分两阶段（不可混用）",
         "买号交付：订单 DELIVER 段（换绑手机号/绑定人/交易平台/中介类型/包赔类型），源表「绑定手机号」可填；"
         "卖号交付：SALE 事件 DELIVER 段（换绑手机号/绑定人），源表从未记录买家换绑号，故全空。"
         "同一号码不得同时填入两阶段"],
        ["系统 DELIVER 事件限分期",
         "独立 DELIVER 事件要求分期合约已结清（SETTLED）方可登记，且必须带 delivery_mode（PLATFORM_OPERATOR 平台代操作 / CUSTOMER_SELF 客户自操作）与交付凭证说明。"
         "非分期单的买号交付落在 BUY 事件的账号快照（bound_phone 进库存档案），卖号交付落在 SELL 事件（写回订单快照与库存档案）"],
        ["表头三级（Excel 页）",
         "一级 = 7 个板块（按 order_form_fields.section 聚合，板块名与顺序取前端字段管理面板 FIELD_SECTION_OPTIONS）；"
         "二级 = 板块内子组；三级 = 字段名。数据自第 4 行起，冻结 E4，筛选取 A3 至末列。"
         "CSV 保持单行字段名，因导入解析以首个非空行为表头，多出的板块/子组行会被当成列名"],
        ["二级子组怎么拆",
         "板块名本身是「A / B」结构的拆两半：账号 / 产品信息 → 账号信息·产品信息；客户 / 供货方信息 → 客户信息·供货方信息；费用与资金 → 费用·资金。"
         "交付信息按阶段拆：HS/TH/DG 为买号交付，SALE 为卖号交付。业务方案信息、运营信息、其他补充信息不分，子组名同板块名"],
        ["一级二级同名则纵向合并",
         "业务方案信息 / 运营信息 / 其他补充信息 三个板块的二级子组名与一级板块名完全相同，"
         "故第 1、2 行纵向合并为一格，不再上下重复写同一个名字；其余板块一级二级名不同，仍保持两行。"
         "判定按整段板块 run 做，避免纵向合并与横向合并范围重叠"],
        ["二级归属规则（可核）",
         "账号 / 产品信息 → 现有字段全归「账号信息」，「产品信息」在本批老数据里无字段；"
         "费用与资金 → 中介费、分期服务费总额、每期服务费归「费用」，其余金额与账户类归「资金」；"
         "客户 / 供货方信息 → TH 全部归「供货方信息」，HS/DG/SALE 全部归「客户信息」"],
        ["7 板块 × 子组全部展开",
         "两个板块在台账无字段、板块内某一半也无字段时，均保留占位列（三级显示「（本表无字段）」、浅灰斜体），不做省略。"
         "HS 32 列、TH 33 列、DG 25 列、SALE 23 列"],
        ["红色单元格", "该字段必填但此行为空，录入前必须补"],
    ]:
        w.append(row)
    for col, width in zip("AB", [28, 110]):
        w.column_dimensions[col].width = width

    # 页签顺序：调度表 → 数据页 → 结构说明 → 运营信息（⑦ 先建后移，保证 ⑥ 在前）
    wb.move_sheet(wb["⑦ 运营信息"], offset=1)
    wb.save(OUT / "台账字段对齐.xlsx")

    print("台账字段对齐.xlsx 已生成")
    for key in ("HS", "TH", "DG", "SALE"):
        total = len(rows[key])
        reqs = [(lab, sum(1 for r in rows[key] if r[i].strip())) for i, (_, lab, req, _) in enumerate(FORM[key]) if req]
        gap = [(lab, c) for lab, c in reqs if c < total]
        print(f"  {key}: {total} 行，必填 {len(reqs)} 个，其中缺口 {len(gap)} 个 -> {gap}")


if __name__ == "__main__":
    build()
