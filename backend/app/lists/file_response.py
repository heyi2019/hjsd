"""lists.file_response：导出下载的 HTTP 响应构造（CSV / xlsx 共用）。

中文文件名走 RFC 5987 `filename*`：HTTP 头只允许 latin-1，直接塞中文会在
Starlette 编码 header 时抛 UnicodeEncodeError。此前 CSV 与 xlsx 各写了一份
逐字相同的实现，这里统一为唯一入口。
"""
from __future__ import annotations

from urllib.parse import quote

from fastapi import Response

CSV_MEDIA_TYPE = "text/csv"
XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def file_response(content: str | bytes, filename: str, media_type: str) -> Response:
    """统一的导出文件下载响应；media_type 由调用方按导出格式传入。"""
    if filename.isascii():
        disposition = f'attachment; filename="{filename}"'
    else:
        disposition = f"attachment; filename*=UTF-8''{quote(filename)}"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": disposition},
    )
