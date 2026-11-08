#!/usr/bin/env python3
"""变异验证执行器：确认「守门测试真的能抓住 bug」。

用法：
    python3 run_mutation.py                 # 跑全部变异
    python3 run_mutation.py M3 M7           # 只跑指定编号

为什么不用 sed 拼接命令：
1. **锚点必须匹配完整逻辑单元**。替换范围必须覆盖完整逻辑，
   （`"exact_match": A` 换掉而 `and B` 留在下一行），变异看似生效、
   实则逻辑未变 → 得出「测试是假绿灯」的错误结论。
2. **还原时序**：`cp backup target` 若与验证命令写在同一条 shell 里，
   可能先于验证执行。用 Python 单进程 try/finally 杜绝竞态。
3. **锚点未命中必须显式失败**，不能静默视为通过。
"""
import os
import shutil
import subprocess
import sys
import tempfile

BACKEND = os.path.dirname(os.path.abspath(__file__))
PY = "/Users/aries/.workbuddy/binaries/python/envs/default/bin/python"

# (编号, 描述, 相对路径, 完整锚点, 变异替换, 预期失败的用例子串)
MUTATIONS = [
    ("W1", "运营类别改错别字（利润口径回归）", "app/services.py",
     'OPERATION_COST_CATEGORIES = {"房租/日用", "办公用品", "员工薪资", "运营"}',
     'OPERATION_COST_CATEGORIES = {"房租日用", "办公用品", "员工薪资", "运营"}',
     "test_wallet"),

    ("W2", "本金支出被翻正", "app/services.py",
     "return Decimal(invest_in) + Decimal(principal_in) + Decimal(principal_out)",
     "return Decimal(invest_in) + Decimal(principal_in) - Decimal(principal_out)",
     "test_wallet"),

    ("O1", "订单删除不再级联清理流水", "app/routers/orders.py",
     'db.query(CashFlow).filter(\n        CashFlow.order_id == order_id, CashFlow.source == "order"\n    ).delete(synchronize_session=False)',
     "pass",
     "test_api"),

    ("O2", "卖出订单不再联动账号置已售", "app/routers/orders.py",
     '            acc.status = "已售"', "            pass", "test_api"),

    ("O3", "订单删除不回滚账号状态", "app/routers/orders.py",
     '                acc.status = "在库"', "                pass", "test_api"),

    ("C1", "现金流年份筛选失效", "app/routers/cashflow.py",
     'q = q.filter(func.strftime("%Y", CashFlow.date) == f"{int(year):04d}")',
     "pass", "test_api"),

    ("C2", "现金流月份筛选失效", "app/routers/cashflow.py",
     'q = q.filter(func.strftime("%m", CashFlow.date) == f"{int(month):02d}")',
     "pass", "test_api"),

    ("C3", "订单联动流水不再打来源标记", "app/routers/orders.py",
     'amount=abs(order.principal), order_id=db_order.id, source="order",',
     'amount=abs(order.principal), order_id=db_order.id, source="manual",',
     "test_api"),

    ("A1", "账号关键词搜索失效", "app/routers/accounts.py",
     "q = q.filter(Account.account_info.like(like) | Account.account_pwd.like(like)\n                     | Account.bind_phone.like(like))",
     "pass", "test_api"),

    ("R1", "库存报表不再只看在库", "app/routers/reports.py",
     'in_stock = db.query(Account).filter(Account.status == "在库").all()',
     "in_stock = db.query(Account).all()", "test_api"),

    ("L1", "关联后不置已售", "app/routers/linkage.py",
     '    if o.type == "回收":\n        acc.status = "已售"', "    pass", "test_linkage"),

    ("L2", "解除关联不回滚账号", "app/routers/linkage.py",
     "    _release_account(acc_id, order_id, db)\n    db.commit()\n"
     '    return {"order_id": order_id, "changed": True, "released_account_id": acc_id}',
     '    db.commit()\n'
     '    return {"order_id": order_id, "changed": True, "released_account_id": acc_id}',
     "test_linkage"),

    ("L3", "候选推荐不过滤本金", "app/routers/linkage.py",
     "q = q.filter(Account.principal.between(p * 0.9, p * 1.1))", "pass", "test_linkage"),

    # 注意锚点必须含整段（含跨行 and），否则只替换半边等于没变异
    ("L4", "exact_match 恒为 True（漏判近似）", "app/routers/linkage.py",
     '"exact_match": str(a.recycle_date) == str(o.date)\n'
     "             and abs(float(a.principal) - float(o.principal)) < 0.01}",
     '"exact_match": True}', "test_linkage"),

    ("L5", "改挂时不释放旧账号", "app/routers/linkage.py",
     "    if prev is not None:\n        _release_account(prev, order_id, db)",
     "    pass", "test_linkage"),
]


def run_tests(klass_filter=""):
    r = subprocess.run(
        [PY, "-m", "pytest", "tests/", "-q", "-p", "no:cacheprovider"],
        cwd=BACKEND, capture_output=True, text=True,
    )
    return r.returncode, r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""


def apply_mutation(rel, anchor, repl):
    """在子进程里施加变异并**校验锚点唯一命中**，返回是否成功。"""
    code = f'''
import sys
p = {rel!r}
s = open(p).read()
n = s.count({anchor!r})
if n != 1:
    print("ANCHOR_COUNT", n); sys.exit(9)
open(p, "w").write(s.replace({anchor!r}, {repl!r}, 1))
print("OK")
'''
    r = subprocess.run([PY, "-c", code], cwd=BACKEND,
                       capture_output=True, text=True)
    return r.returncode == 0, r.stdout.strip()


def main():
    only = set(sys.argv[1:])
    muts = [m for m in MUTATIONS if not only or m[0] in only]

    print("=" * 72)
    print("变异验证：每个用例都必须在变异态下变红，否则守门测试是假绿灯")
    print("=" * 72)
    code, summary = run_tests()
    print(f"基线（未变异）: {summary}")
    if code != 0:
        print("!! 基线就不绿，先修基线再谈变异验证")
        return 1
    print("-" * 72)

    survived, killed, failed = [], [], []
    for mid, desc, rel, anchor, repl, kfilter in muts:
        path = os.path.join(BACKEND, rel)
        backup = tempfile.mktemp(suffix=".bak")
        shutil.copy(path, backup)
        try:
            ok, out = apply_mutation(rel, anchor, repl)
            if not ok:
                failed.append((mid, desc, out))
                print(f"  [失败] {mid:<3} {desc}  ({out})")
                continue
            code, summary = run_tests()
            green = code == 0
            tag = "❌ 未捕获(假绿灯!)" if green else "✓ 已捕获"
            (survived if green else killed).append(mid)
            print(f"  {tag:<18} {mid:<3} {desc:<32} {summary}")
        finally:
            shutil.copy(backup, path)
            os.unlink(backup)

    print("-" * 72)
    code, summary = run_tests()
    print(f"还原后复测: {summary}")
    print(f"统计: 捕获 {len(killed)} / 存活 {len(survived)} / 失败 {len(failed)}")
    if survived:
        print(f"!! 存活变异（守门测试无效）: {', '.join(survived)}")
    if failed:
        print(f"失败（锚点需更新）: {', '.join(m[0] for m in failed)}")
    return 1 if (survived or failed or code != 0) else 0


if __name__ == "__main__":
    sys.exit(main())
