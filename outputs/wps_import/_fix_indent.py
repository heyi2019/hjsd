"""把导入主循环里 try 体整体移入 savepoint，并移除整批 rollback。"""
from pathlib import Path

p = Path(__file__).with_name("import_wps.py")
lines = p.read_text().split("\n")

start = next(i for i, l in enumerate(lines) if l.strip() == "acct_id = None")
end = next(
    i for i, l in enumerate(lines)
    if l.strip() == 'stat["ok"] += 1' and i > start
)
print("区间", start + 1, "->", end + 1)

for i in range(start, end + 1):
    if lines[i].strip():
        lines[i] = "    " + lines[i]

# 清理 except 分支里的整批 rollback / continue
out = []
skip_continue = False
for l in lines:
    if l.strip() == "db.rollback()" and "整批" not in l:
        # 仅删除主循环内的 rollback（外层 except 的 rollback 保留，缩进为 8）
        if l.startswith("                db.rollback()"):
            continue
    if l.strip() == "continue" and l.startswith("                continue"):
        continue
    out.append(l)

p.write_text("\n".join(out))
print("已改写入", p)
