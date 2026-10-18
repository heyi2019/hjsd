from html import escape
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "ERP_功能需求报告_v1.0.md"
OUTPUT = ROOT / "docs" / "ERP_功能需求报告_v1.0.html"


def split_row(line):
    raw = line.strip()
    if raw.startswith("|"):
        raw = raw[1:]
    if raw.endswith("|"):
        raw = raw[:-1]
    return [cell.strip() for cell in raw.split("|")]


def is_separator(line):
    cells = split_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", c.replace(" ", "")) for c in cells)


def inline(text):
    text = escape(text, quote=False).replace("&lt;br&gt;", "<br>")
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"`(.+?)`", r"<code>\1</code>", text)
    text = re.sub(r"\[(.+?)\]\((.+?)\)", r'<a href="\2">\1</a>', text)
    return text


def render_table(rows):
    if len(rows) < 2:
        return ""
    cols = max(len(row) for row in rows)
    normalized = [row + [""] * (cols - len(row)) for row in rows]
    out = ["<div class=\"table-wrap\"><table>", "<thead><tr>"]
    out.extend(f"<th>{inline(cell)}</th>" for cell in normalized[0])
    out.append("</tr></thead><tbody>")
    for row in normalized[1:]:
        out.append("<tr>")
        out.extend(f"<td>{inline(cell)}</td>" for cell in row)
        out.append("</tr>")
    out.extend(["</tbody></table></div>"])
    return "".join(out)


def render():
    lines = SOURCE.read_text(encoding="utf-8").splitlines()
    body = []
    title = "宜游轩 ERP 功能需求报告 v1.0"
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith("|") and i + 1 < len(lines) and is_separator(lines[i + 1]):
            table_lines = [line]
            i += 1
            while i < len(lines) and lines[i].startswith("|"):
                if not is_separator(lines[i]):
                    table_lines.append(lines[i])
                i += 1
            body.append(render_table([split_row(x) for x in table_lines]))
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            level = min(len(heading.group(1)), 4)
            text = heading.group(2).strip()
            if level == 1:
                title = text
            else:
                body.append(f"<h{level}>{inline(text)}</h{level}>")
            i += 1
            continue
        if line.startswith(">"):
            body.append(f"<blockquote>{inline(line[1:].strip())}</blockquote>")
        elif line.startswith("- "):
            body.append(f"<p class=\"list-item\">{inline(line[2:])}</p>")
        else:
            body.append(f"<p>{inline(line)}</p>")
        i += 1

    html = f'''<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(title)}</title>
  <style>
    :root {{ color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }}
    body {{ margin: 0; color: #1f2937; background: #f5f7fa; line-height: 1.6; }}
    main {{ max-width: 1500px; margin: 0 auto; padding: 36px 42px 64px; background: #fff; min-height: 100vh; box-sizing: border-box; }}
    h1 {{ font-size: 30px; margin: 0 0 28px; color: #111827; border-bottom: 2px solid #2563eb; padding-bottom: 14px; }}
    h2 {{ font-size: 22px; margin: 34px 0 12px; color: #111827; }}
    h3 {{ font-size: 18px; margin: 26px 0 10px; color: #1f2937; }}
    h4 {{ font-size: 16px; margin: 20px 0 8px; color: #374151; }}
    p {{ margin: 7px 0; }}
    .list-item {{ padding-left: 18px; }}
    blockquote {{ margin: 14px 0; padding: 8px 14px; border-left: 4px solid #93c5fd; background: #eff6ff; }}
    .table-wrap {{ overflow-x: auto; margin: 12px 0 20px; }}
    table {{ width: 100%; border-collapse: collapse; table-layout: auto; font-size: 14px; background: #fff; }}
    th, td {{ border: 1px solid #d9d9d9; padding: 8px 10px; vertical-align: middle; text-align: left; word-break: break-word; }}
    th {{ background: #d9eaf7; color: #111827; font-weight: 700; white-space: nowrap; }}
    tbody tr:nth-child(even) {{ background: #f7f9fb; }}
    code {{ background: #f3f4f6; border-radius: 3px; padding: 1px 4px; font-size: .92em; }}
    a {{ color: #1d4ed8; }}
    @media print {{ body {{ background: #fff; }} main {{ max-width: none; padding: 0; }} .table-wrap {{ overflow: visible; }} table {{ font-size: 9px; }} }}
  </style>
</head>
<body><main>
<h1>{inline(title)}</h1>
{''.join(body)}
</main></body>
</html>
'''
    OUTPUT.write_text(html, encoding="utf-8")
    print(OUTPUT)


if __name__ == "__main__":
    render()
