"""SQL LIKE 关键字转义：防止用户输入里的 `%` / `_` 被当成通配符。

背景：SQL 的 LIKE/ILIKE 中 `%` 匹配任意长度、`_` 匹配**单个字符**。游戏账号、
微信号、客户昵称常含下划线，若把用户输入直接拼进 `%{keyword}%`，搜索
`abc_123` 会误匹配 `abcX123`，搜索 `%` 会命中全表——既是正确性缺陷，也可被
用来探测全量数据。本模块统一转义这三个元字符（反斜杠自身也要先转义）。

`finance/cashflows._like_pattern` 是最早落地的等价实现（资金核心已验收，
保持独立不合并）；其余搜索入口统一用本函数，返回 (pattern, escape)，
调用方须把 escape 透传给 like()/ilike()。
"""
from __future__ import annotations


def like_contains(keyword: str) -> tuple[str, str]:
    """把用户输入转成 LIKE「包含」模式并转义元字符，返回 (pattern, escape)。

    用法：
        pattern, escape = like_contains(keyword)
        stmt.where(Model.field.ilike(pattern, escape=escape))
    """
    escaped = (
        keyword.strip()
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )
    return f"%{escaped}%", "\\"


__all__ = ["like_contains"]
