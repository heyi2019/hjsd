"""订单分润配置：配置契约与整单保存服务。

真实实现按职责分模块：terms（口径）/ action_rows（表单行展开）/
person+action（写路径）/ listing（查询汇总）；service 只做编排。
"""

from .listing import list_allocations
from .service import set_allocations

__all__ = ["list_allocations", "set_allocations"]
