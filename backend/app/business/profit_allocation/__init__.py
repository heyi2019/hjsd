"""订单分润配置域。

唯一编排主体是 :mod:`app.business.profit_allocation.service`（整单保存与两种录入口径分流），
其余模块为被它调动的职责单元：terms（口径换算）/ action_rows（表单行展开）/
action + person（写路径）/ listing（查询汇总）/ schemas（契约）/ router（HTTP 接口）。

本包不提供符号重导出；调用方直连上述真实模块。
"""
