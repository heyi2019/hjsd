"""预置经营规则定义 + 默认已发布版本（系统级闭集 —— 前端「新建规则 / 新建版本」入口已移除）。

为什么需要
----------
规则编码是**闭集**：后端 `app/domain/enums.py::PolicyType` 只有 6 个固定值，
`orders/service.py::make_snapshot` 只按固定编码（REBATE / COMMISSION）取快照。
而 `policy/service.py::create_definition` **不校验编码是否属于 PolicyType**，
所以任何入口都能写出「没人消费」的脏编码定义，且**不报错、静默失效**。
因此定义收敛为系统预置，不再由页面创建；用户只管「设置配置 → 生成新版本并发布」。

版本同理：逐条「新建版本」是重复劳动，故由本脚本**直接把配置设好**——
每个定义预置 1 条已发布（ACTIVE）默认版本，`resolve_version` 立即可用，
页面只需「设置配置」即可生成新版本（保留历史可查），无需手动走新建版本流程。

幂等约定
--------
- 定义：按 `(policy_code, GLOBAL)` 判定，已存在则跳过
  （`create_definition` 对同 scope 重复编码抛「同一适用范围的规则编码已存在」）。
- 版本：定义下已有任意版本则跳过，避免重复预置。

注意：定义状态 `status` 不参与解析（`resolve_version` 只看版本 status=ACTIVE），
脚本沿用服务默认：create_version 直接创建 ACTIVE 版本（无独立审批环节）。
版本参数为占位口径，业务方在页面「设置配置」按实际调整（每次设置生成新版本并发布）。

用法（必须 cd 到 backend 目录，库地址取自 .env 的 DATABASE_URL）
---------------------------------------------------------------
    cd /Users/aries/黑金时代/backend
    /Users/aries/Applications/Python_3.13/bin/python3 scripts/seed_policy_definitions.py            # 预演，不写库
    /Users/aries/Applications/Python_3.13/bin/python3 scripts/seed_policy_definitions.py --apply    # 实际写入
    DATABASE_URL=postgresql+psycopg://erp_app@127.0.0.1:5432/heijin_erp_dev ... --apply             # 指定库
"""
from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select  # noqa: E402

from app.core.database import get_session_factory  # noqa: E402
from app.domain.enums import PolicyType  # noqa: E402
from app.domain.parties import PolicyDefinition, PolicyVersion  # noqa: E402
from app.policy import definitions as policy_definitions  # noqa: E402
from app.policy import versions as policy_versions

# (编码, 名称, 说明) —— 编码严格取自 PolicyType，不新增、不自造。
POLICY_SEEDS: list[tuple[str, str, str]] = [
    ("REBATE", "返点比例", "返点计提口径；建单时固化快照"),
    ("COMMISSION", "提成分配", "订单提成口径；利润分配四项拆分由订单详情录入"),
    ("INSTALLMENT", "分期规则", "分期期数与节奏"),
    ("WRITE_DOWN", "跌价规则", "跌价计提口径"),
    ("REFUND", "退款规则", "退款口径"),
    ("DG_MIXED", "DG 混合单默认策略", "DG 混合单默认处理策略"),
]

# 每个规则预置 1 条已发布默认版本，使配置直接就位。
# REBATE/INSTALLMENT 的默认值由库内真实业务数据反推（rebate_records.rate 区间 3~10、
# installments.periods 众数 3）。
# COMMISSION/WRITE_DOWN/REFUND 库内无对应历史流水；按「不猜值」纪律
# 「未配置提成规则显示待配置，不猜值」，config 置空（{}）表示待配置，而非填假值 0。
# 例外：COMMISSION 的分润比例是业务既定口径（买入动作 30 / 卖出动作 30 / 运营动作 0 /
# 公司 40，合计 100），不是猜值，故直接预置；且 create_version 拒绝空 config，
# 预置 {} 会在 --apply 时直接抛「规则参数不能为空」。
DEFAULT_VERSION_CONFIG: dict[str, dict[str, object]] = {
    "REBATE": {"rate": "5"},
    "COMMISSION": {"split": {"BUY": "30", "SELL": "30", "OPERATION": "0", "COMPANY": "40"}},
    "INSTALLMENT": {"periods": "3", "cycle": "monthly"},
    "WRITE_DOWN": {},
    "REFUND": {},
    "DG_MIXED": {"mode": "standard"},
}


def _assert_codes_match_policy_type() -> None:
    """守卫：脚本里的编码必须全部属于后端 PolicyType，防止预置出脏编码。"""
    allowed = {member.value for member in PolicyType}
    bad = [code for code, _name, _desc in POLICY_SEEDS if code not in allowed]
    if bad:
        raise SystemExit(f"预置编码不属于 PolicyType：{bad}；可选：{sorted(allowed)}")


def main() -> int:
    parser = argparse.ArgumentParser(description="预置经营规则定义与默认版本（幂等）")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="实际写入数据库；不加则为预演（dry-run），不写库",
    )
    args = parser.parse_args()

    _assert_codes_match_policy_type()

    session = get_session_factory()()
    db_url = session.get_bind().url.render_as_string(hide_password=True)
    created_defs: list[str] = []
    skipped_defs: list[str] = []
    created_versions: list[str] = []
    updated_versions: list[str] = []
    skipped_versions: list[str] = []
    try:
        for code, name, description in POLICY_SEEDS:
            # 1) 定义：幂等
            definition_id = session.scalar(
                select(PolicyDefinition.id)
                .where(PolicyDefinition.policy_code == code)
                .where(PolicyDefinition.scope_type == "GLOBAL")
                .where(PolicyDefinition.scope_id.is_(None))
            )
            if definition_id is None:
                created_defs.append(code)
                if args.apply:
                    definition = policy_definitions.create_definition(
                        session,
                        policy_code=code,
                        name=name,
                        scope_type="GLOBAL",
                        description=description,
                        actor="system:seed_policy_definitions",
                    )
                    definition_id = definition["id"]
            else:
                skipped_defs.append(f"{code}(id={definition_id})")

            # 2) 版本：每个定义预置 1 条已发布版本；已发布版本不改写（只报告差异）。
            if definition_id is not None:
                latest = session.scalar(
                    select(PolicyVersion)
                    .where(PolicyVersion.policy_definition_id == definition_id)
                    .order_by(PolicyVersion.version.desc())
                )
                target_config = DEFAULT_VERSION_CONFIG.get(code, {"placeholder": True})
                if not target_config:
                    # 待配置规则（WRITE_DOWN / REFUND）：create_version 拒绝空 config，
                    # 这里跳过而不是塞假值（不猜值纪律）。
                    skipped_versions.append(f"{code}(待配置，不预置版本)")
                elif latest is None:
                    created_versions.append(code)
                    if args.apply:
                        policy_versions.create_version(
                            session,
                            definition_id,
                            effective_from=date.today(),
                            config=target_config,
                            note="系统预置默认版本",
                            actor="system:seed_policy_definitions",
                        )
                elif latest.config != target_config:
                    # 已发布版本不可改写（只能新建版本）；脚本不越权覆盖线上口径。
                    skipped_versions.append(
                        f"{code}(v{latest.version} 已发布且 config 不同：{latest.config})"
                    )
                else:
                    skipped_versions.append(f"{code}(v{latest.version} config 一致)")
        if args.apply:
            session.commit()
    finally:
        session.close()

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] 目标库：{db_url}")
    print(f"[{mode}] 定义 将创建/已创建 {len(created_defs)} 条：{created_defs or '（无）'}")
    print(f"[{mode}] 定义 已存在跳过 {len(skipped_defs)} 条：{skipped_defs or '（无）'}")
    print(f"[{mode}] 版本 将创建/已创建 {len(created_versions)} 条：{created_versions or '（无）'}")
    print(f"[{mode}] 版本 将更新/已更新 {len(updated_versions)} 条：{updated_versions or '（无）'}")
    print(f"[{mode}] 版本 已存在跳过 {len(skipped_versions)} 条：{skipped_versions or '（无）'}")
    if not args.apply:
        print("[DRY-RUN] 未写入任何数据；确认无误后加 --apply 执行。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
