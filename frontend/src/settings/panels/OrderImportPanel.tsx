import { Alert, Card, Checkbox, Radio, Space, Typography } from "antd";
import axios from "axios";
import { useRef, useState } from "react";
import { errorMessage } from "../../shared/api/client";
import { downloadBlob } from "../../shared/api/download";
import { orderImportApi, type ExistingOrderAction, type ImportPreview, type ImportResult, type ImportRow, type ImportSection } from "../../shared/api/orderImport.api";
import { useLatestRequest } from "../../shared/hooks/useLatestRequest";
import { DataTable, PermissionButton } from "../../shared/ui";

const SECTION_OPTIONS: { label: string; value: ImportSection }[] = [
  { label: "订单详情", value: "details" },
  { label: "操作明细", value: "events" },
  { label: "资金明细", value: "cashflows" },
  { label: "返点明细", value: "rebates" },
];
const ACTION_LABEL: Record<ImportRow["action"], string> = { create: "新建", update: "更新", skip: "跳过", error: "有错误" };

function importError(error: unknown): { message: string; preview?: ImportPreview } {
  const detail = axios.isAxiosError(error) ? error.response?.data?.details : undefined;
  const location = detail && typeof detail === "object"
    ? [detail.sheet, detail.row ? `第 ${detail.row} 行` : null, detail.field, Array.isArray(detail.columns) ? detail.columns.join("、") : null].filter(Boolean).join(" · ")
    : "";
  return { message: [location, errorMessage(error)].filter(Boolean).join("："), preview: detail?.preview };
}

export function OrderImportPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"ledger" | "details">("ledger");
  const [sections, setSections] = useState<ImportSection[]>([]);
  const [existing, setExisting] = useState<ExistingOrderAction>("skip");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const busy = useRef(false);
  const request = useLatestRequest();
  const selected = mode === "details" ? sections : [];

  function invalidate() {
    request.invalidate();
    setPreview(null);
    setResult(null);
    setError("");
    setPreviewing(false);
  }

  async function download() {
    setDownloading(true);
    try {
      downloadBlob(await orderImportApi.template(selected), "订单导入模板.xlsx");
    } catch (cause) {
      setError(importError(cause).message);
    } finally {
      setDownloading(false);
    }
  }

  async function check() {
    if (!file || busy.current) return;
    const token = request.start();
    setPreview(null);
    setResult(null);
    setError("");
    setPreviewing(true);
    try {
      const data = await orderImportApi.preview(file, existing, selected);
      if (request.isCurrent(token)) setPreview(data);
    } catch (cause) {
      if (request.isCurrent(token)) setError(importError(cause).message);
    } finally {
      if (request.isCurrent(token)) setPreviewing(false);
    }
  }

  async function execute() {
    if (!file || !preview || busy.current || preview.detail_errors.length || preview.rows.some((row) => row.errors.length)) return;
    busy.current = true;
    setExecuting(true);
    setError("");
    try {
      const data = await orderImportApi.execute(file, existing, selected);
      setResult(data);
      setPreview(null);
    } catch (cause) {
      const failure = importError(cause);
      setError(failure.message);
      if (failure.preview) setPreview(failure.preview);
    } finally {
      busy.current = false;
      setExecuting(false);
    }
  }

  const blocked = !preview || preview.detail_errors.length > 0 || preview.rows.some((row) => row.errors.length > 0);
  return (
    <Card className="glass" title="订单导入">
      <div className="ui-stack">
        <Typography.Text type="secondary">支持 CSV 和 XLSX；新订单不会自动绑定库存。导入前请核对业务日期与明细来源，整批校验通过后才会写入。</Typography.Text>
        <Space wrap>
          <span>导入范围：</span>
          <Radio.Group value={mode} disabled={executing} onChange={(event) => { invalidate(); setMode(event.target.value); }}>
            <Radio value="ledger">台账展示列</Radio>
            <Radio value="details">带详情导入</Radio>
          </Radio.Group>
        </Space>
        {mode === "details" && <Checkbox.Group options={SECTION_OPTIONS} value={sections} disabled={executing} onChange={(values) => { invalidate(); setSections(values as ImportSection[]); }} />}
        <Space wrap>
          <span>已有订单：</span>
          <Radio.Group value={existing} disabled={executing} onChange={(event) => { invalidate(); setExisting(event.target.value); }}>
            <Radio value="skip">跳过已有订单</Radio>
            <Radio value="update">更新已有订单</Radio>
          </Radio.Group>
        </Space>
        <Space wrap>
          <PermissionButton permission="order.create" onClick={download} loading={downloading} disabled={executing}>下载导入模板</PermissionButton>
          <label>选择订单文件 <input aria-label="选择订单文件" type="file" accept=".csv,.xlsx" disabled={executing} onChange={(event) => { invalidate(); setFile(event.target.files?.[0] ?? null); }} /></label>
          <PermissionButton permission="order.create" onClick={check} loading={previewing} disabled={!file || executing}>预检文件</PermissionButton>
          <PermissionButton permission="order.create" type="primary" onClick={execute} loading={executing} disabled={blocked || previewing}>确认导入</PermissionButton>
        </Space>
        {error && <Alert type="error" showIcon message={error} />}
        {preview && <>
          <Alert type={blocked ? "warning" : "info"} showIcon message={blocked ? "预检发现问题，请修正文件后重新预检" : "预检完成，确认后执行导入"} description="预检后仍会在写入时校验业务状态；如果资料变化或明细来源不完整，整批不会写入。" />
          {preview.detail_errors.map((item, index) => <Alert key={`${item.sheet}-${item.row}-${index}`} type="error" message={`${item.sheet}${item.row ? ` 第 ${item.row} 行` : ""}：${item.message}`} />)}
          <DataTable<ImportRow> size="small" rowKey={(row) => `${row.sheet}-${row.row}`} rows={preview.rows} page={1} pageSize={20} total={preview.rows.length} onPageChange={() => undefined} scroll={{ x: 700 }} columns={[
            { title: "位置", render: (_, row) => `${row.sheet} 第 ${row.row} 行` },
            { title: "订单号", dataIndex: "order_no" },
            { title: "处理", render: (_, row) => ACTION_LABEL[row.action] },
            { title: "问题与提示", render: (_, row) => <Space direction="vertical" size={0}>{row.errors.map((item, i) => <Typography.Text type="danger" key={`e${i}`}>{item}</Typography.Text>)}{row.warnings.map((item, i) => <Typography.Text type="secondary" key={`w${i}`}>{item}</Typography.Text>)}</Space> },
          ]} />
        </>}
        {result && <Alert type="success" showIcon message={`导入完成：新建 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped}`} description={<span>操作新增 {result.events_created}、匹配 {result.events_matched}；资金新增 {result.cashflows_created}、匹配 {result.cashflows_matched}；返点新增 {result.rebates_created}、更新 {result.rebates_updated}。{result.cashflows_renumbered.length > 0 && <> 流水编号对应：{result.cashflows_renumbered.map((item) => `${item.source} → ${item.current}`).join("、")}。</>}</span>} />}
      </div>
    </Card>
  );
}
