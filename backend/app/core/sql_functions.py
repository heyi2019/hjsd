"""PostgreSQL 专用 SQL 函数。

生产与测试统一 PostgreSQL；新增函数前先确认目标数据库原生支持，避免把
方言分支散落到业务代码里。
"""
from __future__ import annotations

from sqlalchemy import String
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.functions import FunctionElement


class YearMonth(FunctionElement):
    """把日期截断成 `YYYY-MM` 字符串，用于按月分组。

    PostgreSQL：`to_char(col, 'YYYY-MM')`
    """

    inherit_cache = True
    type = String()


@compiles(YearMonth, "postgresql")
def _year_month_postgresql(element, compiler, **kw):
    (column,) = list(element.clauses)
    return f"to_char({compiler.process(column, **kw)}, 'YYYY-MM')"


def year_month(column):
    """按月聚合的分组键：`select(year_month(Model.date).label("month"))`。"""
    return YearMonth(column)
