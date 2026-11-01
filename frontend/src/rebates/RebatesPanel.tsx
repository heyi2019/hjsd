/** 返点明细：登记即完成一条业务事实，只支持编辑和删除（REB-01 / A06）。 */
import { Card, Form, Input, Space, Typography } from "antd";
import { appMessage } from "../shared/ui/appFeedback";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  ordersApi,
  rebatesApi,
  employeesApi,
  type Order,
  type EmployeeOption,
  type Rebate,
} from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { downloadBlob } from "../shared/api/download";
import { formatDateTimeMinute, today } from "../shared/lib/format";
import { orderTypeLabel, BUSINESS_MODE_LABEL, ORDER_TYPE_LABEL } from "../shared/lib/labels";
import {
  DataTable,
  ErrorBanner,
  InlineError,
  MoneyInput,
  MoneyText,
  ConfirmButton,
  BusinessActionModal,
  BusinessForm,
  PermissionButton,
  Select,
  StatRow,
} from "../shared/ui";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { percentRules, requiredMoneyRules } from "../shared/lib/validators";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../orders/ConfigurableField";
import { ResponsibleEmployeeSelect } from "../orders/ResponsibleEmployeeSelect";
import { useListViewColumns } from "../shared/lib/listColumns";

export function RebatesPanel() {
  const [rows, setRows] = useState<Rebate[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Rebate | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [dataReady, setDataReady] = useState(false);
  // 弹窗不会同时打开，故全部写操作共用一个 pending/error 即可覆盖。
  const write = useAsyncAction();
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      downloadBlob(await rebatesApi.exportCsv(), `返点-${today()}.csv`);
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setExporting(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setDataReady(false);
    try {
      const [list, orderList, employeeList] = await Promise.all([
        rebatesApi.list(),
        ordersApi.list(),
        employeesApi.list(),
      ]);
      setRows(list);
      setOrders(orderList);
      setEmployees(employeeList);
      setError(null);
      setDataReady(true);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreate = async (values: Record<string, unknown>) => {
    await write.run(async () => {
        await rebatesApi.create({
          source_order_id: Number(values.source_order_id),
          rebate_type: values.rebate_type as "BUY" | "SELL",
          base_amount: values.base_amount as string,
          rate: (values.rate as string) ?? "0",
          collected_on: values.collected_on as string,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: values.form_extra as Record<string, unknown> | undefined,
        });
        appMessage.success("返点记录已创建");
        setCreateOpen(false);
        form.resetFields();
        await load();
    });
  };

  const submitEdit = async (values: Record<string, unknown>) => {
    if (!editTarget) return;
    await write.run(async () => {
      await rebatesApi.update(editTarget.id, {
        base_amount: values.base_amount as string,
        rate: values.rate as string,
        collected_on: values.collected_on as string,
        note: (values.note as string) || null,
        operator_user_ids: values.operator_user_ids as number[] | undefined,
        form_extra: values.form_extra as Record<string, unknown> | undefined,
      });
      appMessage.success("返点明细已更新");
      setEditTarget(null);
      editForm.resetFields();
      await load();
    });
  };

  const { arrange: arrangeColumns } = useListViewColumns("REBATE");
  const columns: ColumnsType<Rebate> = [
    { title: "返点单号", dataIndex: "rebate_no" },
    {
      title: "来源订单",
      key: "source_order",
      render: (_v, row) => orders.find((order) => order.id === row.source_order_id)?.order_no ?? "-",
    },
    {
      title: "业务",
      key: "business",
      render: (_v, row) => BUSINESS_MODE_LABEL[orders.find((order) => order.id === row.source_order_id)?.account_business_mode ?? ""] || "-",
    },
    {
      title: "类型",
      key: "order_type",
      render: (_v, row) => {
        const order = orders.find((item) => item.id === row.source_order_id);
        return order ? orderTypeLabel(order.order_type, { ...ORDER_TYPE_LABEL }) : "-";
      },
    },
    {
      title: "游戏/产品类型",
      key: "game",
      render: (_v, row) => {
        const order = orders.find((item) => item.id === row.source_order_id);
        return order ? [order.account_game_type, order.account_game_account].filter(Boolean).join(" / ") || "-" : "-";
      },
    },
    {
      title: "对方",
      key: "party",
      className: "ui-col-wrap",
      onCell: () => ({ className: "ui-col-wrap" }),
      render: (_v, row) => orders.find((order) => order.id === row.source_order_id)?.party_name || "-",
    },
    {
      title: "基数",
      dataIndex: "base_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    { title: "费率", dataIndex: "rate", align: "right", render: (v: string) => `${v}%` },
    { title: "返点时间", dataIndex: "created_at", render: (v: string | null | undefined) => formatDateTimeMinute(v) },
    {
      title: "操作",
      key: "actions",
      width: 150,
      render: (_v, row) => (
        <Space size={2}>
          <PermissionButton
            permission="order.event.post"
            size="small"
            onClick={() => {
              editForm.setFieldsValue({
                base_amount: row.base_amount,
                rate: row.rate,
                collected_on: row.collected_on,
                note: row.note ?? "",
                operator_user_ids: row.operator_user_ids ?? undefined,
              });
              setEditTarget(row);
            }}
          >
            编辑
          </PermissionButton>
          <ConfirmButton
            permission="order.event.post"
            size="small"
            danger
            title="删除返点明细"
            description="删除后该返点明细将不再保留，确定删除吗？"
            okText="删除"
            onConfirm={async () => {
              await rebatesApi.remove(row.id);
              appMessage.success("返点明细已删除");
              await load();
            }}
          >
            删除
          </ConfirmButton>
        </Space>
      ),
    },
  ];

  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />

      <StatRow
        items={[
          { label: "返点记录数", kind: "count", amount: error ? "不可用" : dataReady ? String(rows.length) : "—" },
        ]}
      />

      <Card
        className="glass"
        title="返点明细"
        extra={
          <Space>
            <PermissionButton permission="finance.read" size="small" loading={exporting} onClick={() => void exportCsv()}>导出 CSV</PermissionButton>
            <PermissionButton
              permission="order.event.post"
              type="primary"
              disabled={!dataReady || loading || Boolean(error)}
              onClick={() => {
                form.resetFields();
                setCreateOpen(true);
              }}
            >
              新增返点记录
            </PermissionButton>
          </Space>
        }
      >
        <DataTable<Rebate>
          columns={arrangeColumns(columns)}
          rows={rows}
          loading={loading}
          page={1}
          pageSize={Math.max(rows.length, 10)}
          total={rows.length}
          emptyText={error ? "返点数据不可用，请点击重新加载" : "暂无返点记录"}
          onPageChange={() => undefined}
        />
      </Card>

      <BusinessActionModal title={editTarget ? `编辑返点 · ${editTarget.rebate_no}` : "编辑返点"} open={Boolean(editTarget)} onCancel={() => setEditTarget(null)} footer={null}>
        <InlineError error={write.error} />
        <BusinessForm scope="INVREBATE" form={editForm} onFinish={submitEdit}>
          <div className="rebate-core-fields">
            <CfgItem name="base_amount" label="返点金额" rules={requiredMoneyRules("返点金额")}><MoneyInput /></CfgItem>
            <CfgItem name="rate" label="返点比例" rules={percentRules("返点比例")}><Input suffix="%" /></CfgItem>
            <CfgItem name="collected_on" label="返点日期" rules={[{ required: true }]}><Input /></CfgItem>
            <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
          </div>
          <CfgItem name="note" label="备注"><Input.TextArea rows={3} /></CfgItem>
          <CustomFieldSection testIdSuffix="rebate-edit" />
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit" loading={write.pending}>保存</PermissionButton>
        </BusinessForm>
      </BusinessActionModal>

      <BusinessActionModal title="新增返点记录" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <InlineError error={write.error} />
        <FieldConfigScope scope="REBATE" active={createOpen}>
        <BusinessForm scope="INVREBATE" form={form}
          onFinish={submitCreate}
          initialValues={{ collected_on: today(), rebate_type: "BUY" }}
        >
          <CfgItem name="source_order_id" label="来源订单" rules={[{ required: true }]}>
            <Select
              options={orders
                .filter((order) => ["ACTIVE", "INSTALLMENT", "COMPLETED"].includes(order.status))
                .map((order) => ({ value: order.id, label: order.order_no }))}
            />
          </CfgItem>
          <CfgItem name="rebate_type" label="返点类型" rules={[{ required: true }]}>
            <Select />
          </CfgItem>
          <div className="rebate-core-fields">
            <CfgItem name="base_amount" label="返点金额" rules={requiredMoneyRules("返点金额")}>
              <MoneyInput />
            </CfgItem>
            <CfgItem name="rate" label="返点比例" rules={percentRules("返点比例")}>
              <Input inputMode="decimal" suffix="%" placeholder="例如 5" />
            </CfgItem>
            <CfgItem name="collected_on" label="返点日期" rules={[{ required: true }]}>
              <Input placeholder="YYYY-MM-DD" />
            </CfgItem>
            <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
          </div>
          <CustomFieldSection testIdSuffix="rebate-create" />
          <Typography.Paragraph type="secondary">
            新返点必须关联来源订单；返点不能独立创建为订单（REB-01-02）。
          </Typography.Paragraph>
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit" loading={write.pending}>
            创建
          </PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </BusinessActionModal>
    </section>
  );
}

