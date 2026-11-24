import { Alert, Button, Space, Spin, Typography } from "antd";
import { useLayoutEffect, useRef, useState } from "react";
import { normalizeError } from "../../../shared/api/client";
import { downloadBlob } from "../../../shared/api/download";
import { attachmentsApi } from "../../../shared/api/misc.api";
import type { AttachmentItem } from "../../../shared/api/types/common";
import { useLatestRequest, useRequestSession } from "../../../shared/hooks/useLatestRequest";
import { useSession } from "../../../shared/state/session";
import { appMessage } from "../../../shared/ui/appFeedback";
import { PermissionButton } from "../../../shared/ui/PermissionButton";

type UploadPayload = { entity_type: "order"; entity_id: string; file_name: string; content_type: string; content_base64: string };

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("附件读取失败"));
    reader.onabort = () => reject(new Error("附件读取中断"));
    reader.readAsDataURL(file);
  });
}

/** 附件单独保存，不依赖订单详情编辑草稿。 */
export function OrderAttachments({ orderNo }: { orderNo: string }) {
  const { can } = useSession();
  const mayUpload = can("order.update") || can("order.event.post");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [duplicate, setDuplicate] = useState<UploadPayload | null>(null);
  const busy = useRef(false);
  const session = useRequestSession(orderNo);
  const listRequest = useLatestRequest();

  useLayoutEffect(() => {
    listRequest.invalidate();
    busy.current = false;
    setOpen(false);
    setItems([]);
    setError(null);
    setLoading(false);
    setUploading(false);
    setDuplicate(null);
  }, [orderNo, listRequest]);

  const reload = async () => {
    const token = session.current();
    const request = listRequest.start();
    setLoading(true);
    try {
      const result = await attachmentsApi.list("order", orderNo);
      if (!session.isCurrent(token) || !listRequest.isCurrent(request)) return;
      setItems(result.items);
      setError(null);
    } catch (cause) {
      if (session.isCurrent(token) && listRequest.isCurrent(request)) setError(normalizeError(cause).message);
    } finally {
      if (session.isCurrent(token) && listRequest.isCurrent(request)) setLoading(false);
    }
  };

  const upload = async (fileOrPayload: File | UploadPayload, allowDuplicate: boolean) => {
    if (busy.current) return;
    const token = session.current();
    busy.current = true;
    setUploading(true);
    try {
      let payload: UploadPayload;
      if (fileOrPayload instanceof File) {
        if (!fileOrPayload.size || fileOrPayload.size > 20 * 1024 * 1024) throw new Error("附件不能为空且不能超过 20MB");
        payload = { entity_type: "order", entity_id: orderNo, file_name: fileOrPayload.name,
          content_type: fileOrPayload.type || "application/octet-stream", content_base64: await readFile(fileOrPayload) };
      } else payload = fileOrPayload;
      if (!session.isCurrent(token)) return;
      try {
        await attachmentsApi.create({ ...payload, allow_duplicate: allowDuplicate });
      } catch (cause) {
        if (session.isCurrent(token) && normalizeError(cause).code === "DUPLICATE_ATTACHMENT") {
          setDuplicate(payload);
          return;
        }
        throw cause;
      }
      if (!session.isCurrent(token)) return;
      setDuplicate(null);
      appMessage.success("附件已上传");
      await reload();
    } catch (cause) {
      if (session.isCurrent(token)) appMessage.error(normalizeError(cause).message);
    } finally {
      if (session.isCurrent(token)) {
        busy.current = false;
        setUploading(false);
      }
    }
  };

  const download = async (item: AttachmentItem) => {
    const token = session.current();
    try {
      const blob = await attachmentsApi.download(item.id);
      if (session.isCurrent(token)) downloadBlob(blob, item.file_name);
    } catch (cause) {
      if (session.isCurrent(token)) appMessage.error(normalizeError(cause).message);
    }
  };

  return <section className="order-detail__attachments">
    <Button type="link" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void reload(); }}>
      {open ? "收起订单附件" : "查看订单附件"}
    </Button>
    {open ? <div>
      {error ? <Alert type="error" showIcon message={`附件加载失败：${error}`} action={<Button type="link" onClick={() => void reload()}>重新加载</Button>} /> : null}
      {loading ? <Spin size="small" /> : !items.length && !error ? <Typography.Text type="secondary">暂无附件</Typography.Text> : null}
      {items.map((item) => <div key={item.id}><Space><Typography.Text>{item.file_name}</Typography.Text><Button type="link" onClick={() => void download(item)}>下载</Button></Space></div>)}
      {mayUpload ? <label>上传附件<input className="order-detail__attachment-input" type="file" aria-label="上传订单附件" disabled={uploading}
        onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void upload(file, false); }} /></label> : null}
      {duplicate && mayUpload ? <Alert type="warning" showIcon message="可见范围内已有相同内容的附件，是否继续上传？" action={<Space>
        <Button disabled={uploading} onClick={() => setDuplicate(null)}>取消</Button>
        <PermissionButton permission={can("order.update") ? "order.update" : "order.event.post"} type="primary" loading={uploading} onClick={() => void upload(duplicate, true)}>继续上传</PermissionButton>
      </Space>} /> : null}
    </div> : null}
  </section>;
}
