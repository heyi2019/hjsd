import { appMessage } from "../shared/ui/appFeedback";
import { Form, Input, Typography, Upload } from "antd";

import { importsApi } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { BusinessActionModal, BusinessForm, FormDrawer, InlineError, PermissionButton, Select } from "../shared/ui";

import { isSupportedImportFile, parseImportText, downloadImportTemplate } from "./ImportWorkbench.fragments";
import type { ImportWorkbenchController } from "./useImportWorkbenchController";

/** 导入工作台的 7 个浮层：人工指派 / 新建导入 / 标单边划转 / 跳过 / 回滚 / 驳回 / 更正。 */
export function ImportWorkbenchOverlays({ controller }: { controller: ImportWorkbenchController }) {
  const {
    act,
    acting,
    correctionTarget,
    error,
    importFile,
    importForm,
    importOpen,
    importing,
    loadBatches,
    mapTarget,
    rejectTarget,
    rollbackTarget,
    setBatchId,
    setCorrectionTarget,
    setError,
    setImportFile,
    setImportOpen,
    setImporting,
    setMapTarget,
    setRejectTarget,
    setRollbackTarget,
    setSkipTarget,
    setUnlinkedTarget,
    skipTarget,
    sourceKindOptions,
    unlinkedTarget,
  } = controller;

  return (
    <>
      <FormDrawer
        open={mapTarget !== null}
        title={`人工指派 · 第 ${mapTarget?.row_no ?? ""} 行`}
        fields={[
          { name: "basis", label: "补录依据", required: true, kind: "textarea" as const, placeholder: "如：对账单 7 月第 9 行 / 客户确认记录" },
          { name: "order_id", label: "关联订单 ID（可空）", kind: "number" as const },
          { name: "account_id", label: "关联库存编号 ID（可空）", kind: "number" as const },
        ]}
        submitText="确认指派"
        submitting={acting}
        error={error}
        onClose={() => setMapTarget(null)}
        onSubmit={(values) => {
          const target = mapTarget;
          if (!target) return;
          const basis = String(values.basis ?? "");
          const orderId = values.order_id === undefined || values.order_id === null ? null : Number(values.order_id);
          const accountId =
            values.account_id === undefined || values.account_id === null ? null : Number(values.account_id);
          void act(async () => {
            await importsApi.map(target.id, { order_id: orderId, account_id: accountId, basis });
            setMapTarget(null);
          });
        }}
      />

      <BusinessActionModal size="compact"
        open={importOpen}
        title="导入导入数据"
        okText="开始导入"
        cancelText="取消"
        confirmLoading={importing}
        destroyOnHidden
        onCancel={() => {
          setImportOpen(false);
          setImportFile(null);
          importForm.resetFields();
        }}
        onOk={() => {
          void importForm.validateFields().then(async (values) => {
            if (!importFile?.originFileObj) {
              appMessage.error("请选择 JSON 或 CSV 文件");
              return;
            }
            setImporting(true);
            try {
              const text = await importFile.originFileObj.text();
              const rows = parseImportText(text, importFile.name);
              const created = await importsApi.createBatch({
                source_name: String(values.source_name),
                source_kind: String(values.source_kind),
                rows,
                note: values.note ? String(values.note) : undefined,
              });
              setImportOpen(false);
              setImportFile(null);
              importForm.resetFields();
              await loadBatches();
              setBatchId(created.id);
              appMessage.success(`已导入 ${rows.length} 行数据`);
            } catch (err) {
              setError(normalizeError(err));
            } finally {
              setImporting(false);
            }
          }).catch(() => undefined);
        }}
      >
        <InlineError error={error} />
        <BusinessForm form={importForm}>
          <Form.Item name="source_name" label="数据名称" rules={[{ required: true, message: "请输入数据名称" }]}>
            <Input placeholder="例如：2026年10月订单导入" />
          </Form.Item>
          <Form.Item name="source_kind" label="数据类型" initialValue="STANDARD_ORDER" rules={[{ required: true }]}>
            <Select options={sourceKindOptions} />
          </Form.Item>
          <PermissionButton
            permission="import.manage"
            type="link"
            className="ui-drawer-hint"
            onClick={() => downloadImportTemplate(String(importForm.getFieldValue("source_kind") ?? "STANDARD_ORDER"))}
          >
            下载当前类型导入模板
          </PermissionButton>
          <Form.Item label="数据文件" required>
            <Upload
              accept=".json,.csv"
              maxCount={1}
              beforeUpload={(file) => {
                if (!isSupportedImportFile(file)) {
                  appMessage.error("只支持 JSON 或 CSV 文件");
                  return Upload.LIST_IGNORE;
                }
                return false;
              }}
              fileList={importFile ? [importFile] : []}
              onChange={({ fileList }) => setImportFile(fileList[0] ?? null)}
              onRemove={() => { setImportFile(null); return true; }}
            >
              <PermissionButton permission="import.manage">选择 JSON / CSV 文件</PermissionButton>
            </Upload>
            <Typography.Paragraph type="secondary" className="ui-drawer-hint">
              文件只会作为原始行保存，不会自动匹配、覆盖业务单或生成现金流。
            </Typography.Paragraph>
          </Form.Item>
          <Form.Item name="note" label="导入说明">
            <Input.TextArea rows={3} placeholder="可填写来源、日期范围或对账依据" />
          </Form.Item>
        </BusinessForm>
      </BusinessActionModal>

      <FormDrawer
        open={unlinkedTarget !== null}
        title={`标记单边划转 · 第 ${unlinkedTarget?.row_no ?? ""} 行`}
        fields={[{ name: "note", label: "说明", kind: "textarea" as const }]}
        submitText="确认标记"
        submitting={acting}
        error={error}
        onClose={() => setUnlinkedTarget(null)}
        onSubmit={(values) => {
          const target = unlinkedTarget;
          if (!target) return;
          void act(async () => {
            await importsApi.markUnlinked(target.id, values.note ? String(values.note) : undefined);
            setUnlinkedTarget(null);
          });
        }}
        extra={
          <p className="ui-drawer-hint">
            标记后系统只生成异常工单，**不会**补造任何配对流水；新系统内部划转必须成对。
          </p>
        }
      />

      <FormDrawer
        open={skipTarget !== null}
        title={`跳过 · 第 ${skipTarget?.row_no ?? ""} 行`}
        fields={[{ name: "reason", label: "跳过理由", required: true, kind: "textarea" as const }]}
        submitText="确认跳过"
        submitting={acting}
        error={error}
        onClose={() => setSkipTarget(null)}
        onSubmit={(values) => {
          const target = skipTarget;
          if (!target) return;
          void act(async () => {
            await importsApi.skip(target.id, String(values.reason ?? ""));
            setSkipTarget(null);
          });
        }}
      />

      <FormDrawer
        open={rollbackTarget !== null}
        title={`回滚批次 · ${rollbackTarget?.batch_no ?? ""}`}
        fields={[{ name: "reason", label: "回滚理由", required: true, kind: "textarea" as const }]}
        submitText="确认回滚"
        submitting={acting}
        error={error}
        onClose={() => setRollbackTarget(null)}
        onSubmit={(values) => {
          const target = rollbackTarget;
          if (!target) return;
          void act(async () => {
            await importsApi.rollback(target.id, String(values.reason ?? ""));
            setRollbackTarget(null);
          });
        }}
        extra={
          <p className="ui-drawer-hint">
            回滚是逻辑操作：原始行与审计日志全部保留，不删除任何数据。
          </p>
        }
      />

      <FormDrawer
        open={rejectTarget !== null}
        title={`驳回批次 · ${rejectTarget?.batch_no ?? ""}`}
        fields={[{ name: "reason", label: "驳回理由", required: true, kind: "textarea" as const }]}
        submitText="确认驳回"
        submitting={acting}
        error={error}
        onClose={() => setRejectTarget(null)}
        onSubmit={(values) => {
          const target = rejectTarget;
          if (!target) return;
          void act(async () => {
            await importsApi.reject(target.id, String(values.reason ?? ""));
            setRejectTarget(null);
          });
        }}
        extra={
          <p className="ui-drawer-hint">
            驳回是终态：批次不再提交，原始行与审计日志全部保留、状态不变；如需再导入请新建批次。
          </p>
        }
      />

      <FormDrawer
        open={correctionTarget !== null}
        title={`更正批次 · ${correctionTarget?.batch_no ?? ""}`}
        fields={[
          {
            name: "rows",
            label: "更正内容（JSON 行数组）",
            required: true,
            kind: "textarea" as const,
            placeholder: '[{"row_no": 3, "amount": "123.45"}, {"row_no": 7, "note": "补充说明"}]',
          },
          { name: "reason", label: "更正理由", required: true, kind: "textarea" as const },
        ]}
        submitText="提交更正批次"
        submitting={acting}
        error={error}
        onClose={() => setCorrectionTarget(null)}
        onSubmit={(values) => {
          const target = correctionTarget;
          if (!target) return;
          let rows: Record<string, unknown>[];
          try {
            rows = JSON.parse(String(values.rows ?? "[]"));
            if (!Array.isArray(rows) || rows.length === 0) {
              appMessage.error("更正内容必须是非空 JSON 数组");
              return;
            }
          } catch {
            appMessage.error("更正内容不是合法 JSON，请检查格式");
            return;
          }
          void act(async () => {
            await importsApi.createCorrection(target.id, {
              rows: rows as Record<string, unknown>[],
              reason: String(values.reason ?? ""),
            });
            setCorrectionTarget(null);
          });
        }}
        extra={
          <p className="ui-drawer-hint">
            已确认批次的原批次与原始行一律只读；更正以新批次分层保存，通过 corrects_batch_no 指回原批次，形成可追溯更正链。
          </p>
        }
      />
    </>
  );
}
