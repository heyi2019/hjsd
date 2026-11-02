"""跨方言 SQL 函数：同一表达式在 SQLite / PostgreSQL 下各自渲染。

生产已切 PostgreSQL，但历史代码里仍留有 SQLite 专有函数的痕迹（`strftime`、
`json_extract`），在 PG 下会报 `UndefinedFunction`——不是慢，是直接 500。
本模块用 `@compiles` 按方言渲染，调用方只写一处、两边语义一致。

新增函数前先问一句：这个函数 PG 有吗？没有就走这里，别在业务代码里按
`dialect.name` 分支——分支会散落各处、迟早漏一处。
"""
from __future__ import annotations

from sqlalchemy import String
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.functions import FunctionElement


class YearMonth(FunctionElement):
    """把日期截断成 `YYYY-MM` 字符串，用于按月分组。

    SQLite：`strftime('%Y-%m', col)`
    PostgreSQL：`to_char(col, 'YYYY-MM')`
    """

    inherit_cache = True
    type = String()


@compiles(YearMonth, "sqlite")
def _year_month_sqlite(element, compiler, **kw):
    (column,) = list(element.clauses)
    return f"strftime('%Y-%m', {compiler.process(column, **kw)})"


@compiles(YearMonth, "postgresql")
def _year_month_postgresql(element, compiler, **kw):
    (column,) = list(element.clauses)
    return f"to_char({compiler.process(column, **kw)}, 'YYYY-MM')"


def year_month(column):
    """按月聚合的分组键：`select(year_month(Model.date).label("month"))`。"""
    return YearMonth(column)
