import { appMessage } from "../shared/ui/appFeedback";
/** 全局搜索：仅展示后端按权限过滤后的可跳转摘要（SYS-01-02）。 */
import { Card, Form, Input } from "antd";
import { useState } from "react";
import type { ColumnsType } from "antd/es/table";
import { searchApi, type SearchResult } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { DataTable, ErrorBanner } from "../shared/ui";

export function SearchPanel() {
  const [rows, setRows] = useState<SearchResult[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const runSearch = async (values: Record<string, unknown>) => {
    const text = String(values.q ?? "").trim();
    if (!text) { appMessage.warning("请输入搜索关键词"); return; }
    setLoading(true); setQuery(text);
    try { const result = await searchApi.query(text); setRows(result.items); setError(null); }
    catch (err) { setError(normalizeError(err)); }
    finally { setLoading(false); }
  };
  const columns: ColumnsType<SearchResult> = [
    { title: "类型", dataIndex: "type" },
    { title: "编号", dataIndex: "code" },
    { title: "标题", dataIndex: "title" },
    { title: "说明", dataIndex: "subtitle", render: (v: string | null) => v || "-" },
    { title: "入口", dataIndex: "route" },
  ];
  return <section className="ui-stack">
    <Card className="glass" title="全局搜索">
      <Form layout="inline" onFinish={runSearch} className="ui-filter-bar"><Form.Item name="q" rules={[{ required: true }]}><Input placeholder="订单号 / 库存号 / 客户 / 合作方 / 返点号" /></Form.Item><button type="submit" className="ui-button ui-button--primary">搜索</button></Form>
      <ErrorBanner error={error} onRetry={() => query && void runSearch({ q: query })} />
      <DataTable<SearchResult> columns={columns} rows={rows} loading={loading} page={1} pageSize={20} total={rows.length} emptyText={query ? "没有匹配结果" : "输入关键词开始搜索"} onPageChange={() => undefined}/>
    </Card>
  </section>;
}
