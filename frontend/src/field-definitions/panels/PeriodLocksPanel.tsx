/** 月结账期锁（设置页入口）：锁定后该账期不允许再登记/修改现金流。
 *
 * 为什么单独写一份、不复用资金中心那段：
 * 资金中心 FundsPage 的「月结锁定」与 1000+ 行页面状态深度耦合，抽共享组件要改共用大文件及其 deep 测试，
 * 风险大于收益；因此这里按同一端点（/period-locks）另写一份设置页视角的面板，两端数据同源。
 * 表单标签走与资金中心**同一个作用域 FUNDLOCK**：一处改标签/必填，两边同时生效，不会分叉。
 */
import { Form, Input, Modal, Typography, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { periodLocksApi, type PeriodLock } from "../../shared/api/catalog";
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
import { normalizeError } from "../../shared/api/client";
import { CfgItem, FieldConfigScope } from "../../orders/ConfigurableField";
import { DataTable, ErrorBanner, InlineError, PermissionButton } from "../../shared/ui";

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function formatAt(value: string | undefined): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 16);
}

export function PeriodLocksPanel() {
  const [rows, setRows] = useState<PeriodLock[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const write = useAsyncAction();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await periodLocksApi.list());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (values: Record<string, unknown>) => {
    await write.run(async () => {
      await periodLocksApi.create({
        period: values.period as string,
        note: values.note as string | undefined,
      });
      message.success("账期已锁定");
      setOpen(false);
      form.resetFields();
      await load();
    });
  };

  return (
    <section className="ui-stack">
      <Typography.Paragraph type="secondary" className="ui-text-flush">
        锁定某个会计账期后，该账期内不再允许登记或修改现金流；用于月结封账。
      </Typography.Paragraph>

      <ErrorBanner error={error} onRetry={() => void load()} retrying={loading} />

      <PermissionButton
        permission="finance.period.lock"
        type="primary"
        onClick={() => {
          form.setFieldsValue({ period: currentPeriod() });
          setOpen(true);
        }}
      >
        锁定账期
      </PermissionButton>

      <DataTable<PeriodLock>
        columns={[
          { title: "账期", dataIndex: "period" },
          { title: "锁定时间", dataIndex: "locked_at", render: (v: string | undefined) => formatAt(v) },
          { title: "锁定人", dataIndex: "locked_by" },
          { title: "说明", dataIndex: "note", render: (v: string | null | undefined) => v || "—", className: "ui-col-md-up", onCell: () => ({ className: "ui-col-md-up" }) },
        ]}
        rows={rows}
        rowKey="period"
        loading={loading}
        page={1}
        pageSize={Math.max(rows.length, 5)}
        total={rows.length}
        emptyText="暂无锁定的账期"
        onPageChange={() => undefined}
     />

      <Modal title="锁定账期" open={open} onCancel={() => setOpen(false)} footer={null}>
        <InlineError error={write.error} />
        <FieldConfigScope scope="FUNDLOCK" active={open}>
          <Form form={form} layout="vertical" onFinish={submit}>
            <CfgItem
              name="period"
              label="会计账期"
              rules={[{ required: true }, { pattern: /^\d{4}-\d{2}$/, message: "请输入 YYYY-MM" }]}
            >
              <Input placeholder="YYYY-MM" />
            </CfgItem>
            <CfgItem name="note" label="说明">
              <Input.TextArea rows={3} />
            </CfgItem>
            <PermissionButton
              permission="finance.period.lock"
              type="primary"
              htmlType="submit"
              loading={write.pending}
            >
              确认锁定
            </PermissionButton>
          </Form>
        </FieldConfigScope>
      </Modal>
    </section>
  );
}
