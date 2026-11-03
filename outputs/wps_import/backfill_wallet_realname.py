"""按 WPS「回收账号登记」回填库存账号的钱包实名情况。

数据源：https://www.kdocs.cn/l/cu5ycu8S5Pqs 的「回收账号登记」表（49 条，
2026-11-02 00:40 拉取，落盘于同目录 wallet_realname_source.json）。

匹配键：stocks.game_account == 记录.账号密码（两端统一 strip，源表里有 `2762328846\n`、
`2498882476 ` 这类脏值）。

不匹配的账号一律不动：
  - 49 个 `WPS-{日期}-{序号}` 占位账号 → 源表本来就没有它们（订单表无账号明细时造的占位）
  - 真实号但在源表 49 条里查不到 → 留空，等源表补登

默认 dry-run，--apply 才提交；提交前写备份，逐条记审计（ACCOUNT_UPDATE）。
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import select  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
import app.domain.trade  # noqa: E402,F401  # 聚合注册全部交易模型
from app.domain.trade_models.account import Account  # noqa: E402

BASE = Path(__file__).parent
SOURCE = BASE / "wallet_realname_source.json"
BACKUP = BASE / f"bak_wallet_realname_{datetime.now():%Y%m%d-%H%M}.json"
ACTOR = "wps-import"
VALID = {"已注销", "未注销"}


def norm(v: str | None) -> str:
    return (v or "").strip()


def load_source() -> dict[str, dict]:
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    out: dict[str, dict] = {}
    for r in data["records"]:
        acct = norm(r.get("account"))
        rn = norm(r.get("realname"))
        if not acct or rn not in VALID:
            continue
        # 同账号多条时以最后一条为准（源表按登记时间顺序返回）
        out[acct] = {"realname": rn, "rid": r["rid"], "date": r.get("date", "")}
    return out


def main() -> None:
    apply = "--apply" in sys.argv
    src = load_source()
    print(f"源表有效记录（有账号 + 有实名）: {len(src)} 条")

    s = get_session_factory()()
    rows = s.scalars(select(Account).order_by(Account.stock_no)).all()
    print(f"库存账号: {len(rows)} 个\n")

    todo, already, no_source, placeholder = [], [], [], []
    for a in rows:
        acct = norm(a.game_account)
        if acct.startswith("WPS-"):
            placeholder.append(a)
            continue
        hit = src.get(acct)
        if hit is None:
            no_source.append(a)
        elif a.wallet_realname == hit["realname"]:
            already.append(a)
        else:
            todo.append((a, hit))

    print(f"待回填        : {len(todo)}")
    print(f"已是目标值    : {len(already)}")
    print(f"真实号但源表无: {len(no_source)}")
    print(f"WPS 占位号    : {len(placeholder)}\n")

    dist: dict[str, int] = {}
    for a, hit in todo:
        dist[hit["realname"]] = dist.get(hit["realname"], 0) + 1
    print("待回填分布:", dist)

    if todo:
        print("\n明细（前 15 条）:")
        for a, hit in todo[:15]:
            print(f"  {a.stock_no}  {norm(a.game_account):<14} → {hit['realname']}"
                  f"   (源 {hit['rid']} / {hit['date']})")

    if no_source:
        print(f"\n源表查不到的真实号（{len(no_source)} 个，保持空值）:")
        for a in no_source:
            print(f"  {a.stock_no}  {norm(a.game_account)}")

    if not apply:
        print("\n[dry-run] 未提交。加 --apply 执行。")
        s.close()
        return

    if not todo:
        print("\n无可回填项，退出。")
        s.close()
        return

    BACKUP.write_text(json.dumps(
        [{"id": a.id, "stock_no": a.stock_no, "game_account": norm(a.game_account),
          "wallet_realname": a.wallet_realname} for a, _ in todo],
        ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n备份写入: {BACKUP.name}")

    from app.core.audit import record_audit  # noqa: PLC0415
    from app.domain.enums import AuditAction  # noqa: PLC0415

    for a, hit in todo:
        record_audit(
            s,
            action=AuditAction.ACCOUNT_UPDATE,
            entity_type="stock",
            entity_id=a.stock_no,
            actor=ACTOR,
            before={"wallet_realname": a.wallet_realname},
            after={"wallet_realname": hit["realname"]},
            reason=f"按 WPS 回收账号登记回填钱包实名（记录 {hit['rid']} / {hit['date']}）",
        )
        a.wallet_realname = hit["realname"]
        a.updated_by = ACTOR

    s.commit()
    filled = s.scalars(select(Account).where(Account.wallet_realname.is_not(None))).all()
    print(f"\n已提交：{len(todo)} 个账号写入钱包实名")
    print(f"当前库内已填实名账号: {len(filled)} / {len(rows)}")
    s.close()


if __name__ == "__main__":
    main()
