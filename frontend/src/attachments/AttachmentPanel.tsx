import { appMessage } from "../shared/ui/appFeedback";
/** 附件中心：按业务对象维护附件索引；文件内容由后端统一存储和鉴权。 */
import { Card, Input, Space, Typography, Upload } from "antd";
import type { UploadProps } from "antd";
import { useState } from "react";
import { attachmentsApi, type AttachmentItem } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { DataTable, ConfirmButton, ErrorBanner, PermissionButton } from "../shared/ui";
import type { ColumnsType } from "antd/es/table";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = reject; reader.readAsDataURL(file); });
}

export function AttachmentPanel() {
  const [entityType, setEntityType] = useState("order");
  const [entityId, setEntityId] = useState("");
  const [rows, setRows] = useState<AttachmentItem[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const load = async () => { if (!entityId.trim()) { appMessage.warning("请输入业务对象编号"); return; } try { setRows((await attachmentsApi.list(entityType, entityId.trim())).items); setError(null); } catch (err) { setError(normalizeError(err)); } };
  const uploadProps: UploadProps = { showUploadList: false, beforeUpload: async (file) => { try { await attachmentsApi.create({ entity_type: entityType, entity_id: entityId.trim(), file_name: file.name, content_type: file.type || "application/octet-stream", content_base64: await fileToBase64(file) }); appMessage.success("附件已上传"); await load(); } catch (err) { setError(normalizeError(err)); } return false; } };
  const download = async (row: AttachmentItem) => { try { const blob = await attachmentsApi.download(row.id); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = row.file_name; anchor.click(); URL.revokeObjectURL(url); } catch (err) { setError(normalizeError(err)); } };
  const remove = async (row: AttachmentItem) => { try { await attachmentsApi.remove(row.id); appMessage.success("附件已删除"); await load(); } catch (err) { setError(normalizeError(err)); } };
  const columns: ColumnsType<AttachmentItem> = [{ title: "附件编号", dataIndex: "attachment_no" }, { title: "文件名", dataIndex: "file_name" }, { title: "大小", render: (_v, row) => `${row.size_bytes} B` }, { title: "上传人", dataIndex: "created_by" }, { title: "操作", render: (_v, row) => <Space size={2}><PermissionButton permission="finance.read" size="small" onClick={() => void download(row)}>下载</PermissionButton><ConfirmButton permission="order.update" size="small" danger title="删除附件" description="删除后不可恢复，确定要删除该附件吗？" okText="删除" onConfirm={async () => { await remove(row); }}>删除</ConfirmButton></Space> }];
  return <section className="ui-stack"><ErrorBanner error={error} onRetry={() => void load()} /><Card className="glass" title="附件中心"><div className="ui-filter-bar"><Input value={entityType} onChange={(event) => setEntityType(event.target.value)} placeholder="对象类型" /><Input value={entityId} onChange={(event) => setEntityId(event.target.value)} placeholder="对象编号" onPressEnter={() => void load()} /><PermissionButton permission="finance.read" onClick={() => void load()}>查询</PermissionButton><Upload {...uploadProps} disabled={!entityId.trim()}><PermissionButton permission="order.update" disabled={!entityId.trim()}>上传附件</PermissionButton></Upload></div>{!entityId.trim() ? <Typography.Text type="secondary">请先填写对象编号后上传附件</Typography.Text> : null}<DataTable<AttachmentItem> columns={columns} rows={rows} page={1} pageSize={20} total={rows.length} emptyText="暂无附件" onPageChange={() => undefined}/></Card></section>;
}
