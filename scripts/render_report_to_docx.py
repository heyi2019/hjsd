from pathlib import Path
import re

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Inches, Pt, RGBColor


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "ERP_功能需求报告_v1.0.md"
OUTPUT = ROOT / "docs" / "ERP_功能需求报告_v1.0.docx"


def set_cell_shading(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_border(cell, color="D9D9D9", size="4"):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    borders = tc_pr.first_child_found_in("w:tcBorders")
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        tc_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = "w:" + edge
        element = borders.find(qn(tag))
        if element is None:
            element = OxmlElement(tag)
            borders.append(element)
        element.set(qn("w:val"), "single")
        element.set(qn("w:sz"), size)
        element.set(qn("w:space"), "0")
        element.set(qn("w:color"), color)


def set_cell_margins(cell, top=80, start=100, bottom=80, end=100):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for side, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn("w:" + side))
        if node is None:
            node = OxmlElement("w:" + side)
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_repeat_table_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def set_run_font(run, size=9.5, bold=False, color="000000"):
    run.font.name = "STSong"
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), "STSong")
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), "Arial")
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), "Arial")
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = RGBColor.from_string(color)


def add_inline(paragraph, text, size=9.5, bold=False):
    text = text.replace("<br>", "\n")
    # Keep Markdown emphasis readable while removing syntax markers.
    pattern = re.compile(r"(\*\*.*?\*\*|`.*?`|\[.*?\]\(.*?\))")
    pos = 0
    for match in pattern.finditer(text):
        if match.start() > pos:
            run = paragraph.add_run(text[pos:match.start()])
            set_run_font(run, size=size, bold=bold)
        token = match.group(0)
        if token.startswith("**"):
            run = paragraph.add_run(token[2:-2])
            set_run_font(run, size=size, bold=True)
        elif token.startswith("`"):
            run = paragraph.add_run(token[1:-1])
            set_run_font(run, size=size, bold=bold)
        else:
            label = token[token.find("[") + 1 : token.find("]")]
            run = paragraph.add_run(label)
            set_run_font(run, size=size, bold=bold)
        pos = match.end()
    if pos < len(text):
        run = paragraph.add_run(text[pos:])
        set_run_font(run, size=size, bold=bold)


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


def add_table(doc, rows):
    if len(rows) < 2:
        return
    cols = max(len(row) for row in rows)
    rows = [row + [""] * (cols - len(row)) for row in rows]
    table = doc.add_table(rows=len(rows), cols=cols)
    table.autofit = False
    table.allow_autofit = False

    max_lengths = []
    for col in range(cols):
        max_lengths.append(max(4, min(38, max(len(row[col].replace("<br>", "\n")) for row in rows))))
    total = sum(max_lengths)
    available = 10.3
    widths = [available * value / total for value in max_lengths]

    for r_idx, row_data in enumerate(rows):
        row = table.rows[r_idx]
        if r_idx == 0:
            set_repeat_table_header(row)
        for c_idx, value in enumerate(row_data):
            cell = row.cells[c_idx]
            cell.width = Inches(widths[c_idx])
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            set_cell_border(cell)
            set_cell_margins(cell)
            set_cell_shading(cell, "D9EAF7" if r_idx == 0 else ("F7F9FB" if r_idx % 2 == 0 else "FFFFFF"))
            paragraph = cell.paragraphs[0]
            paragraph.paragraph_format.space_after = Pt(0)
            paragraph.paragraph_format.line_spacing = 1.05
            add_inline(paragraph, value, size=8.2 if cols >= 6 else 8.7, bold=(r_idx == 0))
    doc.add_paragraph().paragraph_format.space_after = Pt(1)


def add_heading(doc, text, level):
    p = doc.add_paragraph(style=f"Heading {min(level, 3)}")
    p.paragraph_format.keep_with_next = True
    add_inline(p, text, size={1: 14, 2: 11.5, 3: 10.5}.get(level, 10), bold=True)


def build():
    lines = SOURCE.read_text(encoding="utf-8").splitlines()
    doc = Document()
    section = doc.sections[0]
    section.orientation = WD_ORIENT.LANDSCAPE
    section.page_width = Cm(29.7)
    section.page_height = Cm(21.0)
    section.top_margin = Cm(1.35)
    section.bottom_margin = Cm(1.25)
    section.left_margin = Cm(1.35)
    section.right_margin = Cm(1.35)

    normal = doc.styles["Normal"]
    normal.font.name = "STSong"
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "STSong")
    normal.font.size = Pt(9.5)
    normal.paragraph_format.space_after = Pt(4)
    normal.paragraph_format.line_spacing = 1.15
    for name, size in (("Heading 1", 14), ("Heading 2", 11.5), ("Heading 3", 10.5)):
        style = doc.styles[name]
        style.font.name = "STSong"
        style._element.rPr.rFonts.set(qn("w:eastAsia"), "STSong")
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.paragraph_format.space_before = Pt(8)
        style.paragraph_format.space_after = Pt(4)

    title = True
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
            add_table(doc, [split_row(x) for x in table_lines])
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            level = len(heading.group(1))
            text = heading.group(2).strip()
            if title:
                p = doc.add_paragraph(style="Title")
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                p.paragraph_format.space_after = Pt(10)
                add_inline(p, text, size=20, bold=True)
                title = False
            else:
                add_heading(doc, text, level)
            i += 1
            continue
        if line.startswith(">"):
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.5)
            add_inline(p, line[1:].strip(), size=9.2)
        elif line.startswith("- ") or re.match(r"^\d+\.\s", line):
            text = re.sub(r"^(?:- |\d+\.\s)", "", line)
            p = doc.add_paragraph(style="List Bullet")
            add_inline(p, text, size=9.2)
        else:
            p = doc.add_paragraph()
            add_inline(p, line, size=9.2)
        i += 1

    doc.core_properties.title = "宜游轩 ERP 功能需求报告 v1.0"
    doc.core_properties.subject = "ERP 功能需求、功能数量、闭环状态与验收口径"
    doc.core_properties.author = "宜游轩"
    doc.save(OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    build()
