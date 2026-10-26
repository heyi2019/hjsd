/** 返点记录：分次到账与来源订单追踪（REB-01 / A06）。 */
import { Card, Form, Input, Modal, Select, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  ordersApi,
  poolsApi,
  rebatesApi,
  type Order,
  type Pool,
  type Rebate,
  type Settlement,
} from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { orderTypeLabel } from "../shared/lib/labels";
import {
  DataTable,
  ErrorBanner,
  InlineError,
  MoneyInput,
  MoneyText,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { percentRules, requiredMoneyRules } from "../shared/lib/validators";
import { CfgItem, FieldConfigScope } from "../orders/ConfigurableField";

const BUSINESS_MODE_LABEL: Record<string, string> = {
  SELF: "自营",
  DISTRIBUTION: "分销",
};

const ORDER_TYPE_LABEL: Record<string, string> = {
  HS: "回收",
  TH: "提号",
  DG: "代挂",
  DFQ: "代分期",
};

export function RebatesPanel() {
  const [rows, setRows] = useState<Rebate[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [settleTarget, setSettleTarget] = useState<Rebate | null>(null);
  const [reverseTarget, setReverseTarget] = useState<{ rebate: Rebate; settlement: Settlement } | null>(null);
  const [settlements, setSettlements] = useState<Record<number, Settlement[]>>({});
  const [overdueDays, setOverdueDays] = useState<Record<number, number>>({});
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  // 弹窗不会同时打开，故全部写操作共用一个 pending/error 即可覆盖。
  const write = useAsyncAction();
  const [form] = Form.useForm();
  const [settleForm] = Form.useForm();
  const [reverseForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, orderList, poolList] = await Promise.all([
        rebatesApi.list(),
        ordersApi.list(),
        poolsApi.list(),
      ]);
      setRows(list);
      setOrders(orderList);
      setPools(poolList);
      // 结算明细与逾期天数分开取：两者失败都不应阻断主列表渲染。
      const [settlementEntries, overdueList] = await Promise.all([
        Promise.all(
          list.map(async (item) => [item.id, await rebatesApi.settlements(item.id)] as const),
        ),
        rebatesApi.overdue().catch(() => []),
      ]);
      setSettlements(Object.fromEntries(settlementEntries));
      setOverdueDays(
        Object.fromEntries(overdueList.map((item) => [item.id, item.overdue_days])),
      );
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

  const submitCreate = async (values: Record<string, unknown>) => {
    await write.run(async () => {
        await rebatesApi.create({
          source_order_id: Number(values.source_order_id),
          rebate_type: values.rebate_type as "BUY" | "SELL",
          base_amount: values.base_amount as string,
          rate: (values.rate as string) ?? "0",
          collected_on: values.collected_on as string,
        });
        message.success("返点记录已创建");
        setCreateOpen(false);
        form.resetFields();
        await load();
    });
  };

  const submitSettle = async (values: Record<string, unknown>) => {
    if (!settleTarget) return;
    await write.run(async () => {
        await rebatesApi.settle(settleTarget.id, {
          gross_amount: values.gross_amount as string,
          platform_fee: (values.platform_fee as string) ?? "0",
          settled_on: values.settled_on as string,
          pool_id: Number(values.pool_id),
        });
        message.success("返点结算已登记");
        setSettleTarget(null);
        settleForm.resetFields();
        await load();
    });
  };

  const submitReverse = async (values: Record<string, unknown>) => {
    if (!reverseTarget) return;
    await write.run(async () => {
        await rebatesApi.reverseSettlement(reverseTarget.rebate.id, reverseTarget.settlement.id, {
          reversed_on: values.reversed_on as string,
          reason: values.reason as string,
        });
        message.success("结算已冲销，已生成反向流水");
        setReverseTarget(null);
        reverseForm.resetFields();
        await load();
    });
  };

  const pending = rows.filter((row) => row.status !== "SETTLED").length;

  const columns: ColumnsType<Rebate> = [
    { title: "返点单号", dataIndex: "rebate_no" },
    {
      title: "来源订单",
      render: (_v, row) => orders.find((order) => order.id === row.source_order_id)?.order_no ?? "-",
    },
    {
      title: "业务",
      render: (_v, row) => BUSINESS_MODE_LABEL[orders.find((order) => order.id === row.source_order_id)?.account_business_mode ?? ""] || "-",
    },
    {
      title: "类型",
      render: (_v, row) => {
        const order = orders.find((item) => item.id === row.source_order_id);
        return order ? orderTypeLabel(order.order_type, { ...ORDER_TYPE_LABEL }) : "-";
      },
    },
    {
      title: "产品",
      render: (_v, row) => {
        const order = orders.find((item) => item.id === row.source_order_id);
        return order ? [order.account_game_type, order.account_game_account].filter(Boolean).join(" / ") || "-" : "-";
      },
    },
    {
      title: "对方",
      render: (_v, row) => orders.find((order) => order.id === row.source_order_id)?.party_name || "-",
    },
    {
      title: "基数",
      dataIndex: "base_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    { title: "费率", dataIndex: "rate", align: "right", render: (v: string) => `${v}%` },
    {
      title: "预计到账",
      dataIndex: "expected_on",
      render: (v: string | null | undefined, row) => {
        const days = overdueDays[row.id];
        if (!v) return "-";
        if (days != null) {
          return (
            <Typography.Text type="danger">
              {v}（逾期 {days} 天）
            </Typography.Text>
          );
        }
        return v;
      },
    },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    {
      title: "操作",
      render: (_v, row) => (
        <PermissionButton
          permission="order.event.post"
          size="small"
          disabled={row.status === "SETTLED"}
          onClick={() => {
            settleForm.resetFields();
            setSettleTarget(row);
            settleForm.setFieldsValue({ settled_on: today() });
          }}
        >
          登记结算
        </PermissionButton>
      ),
    },
  ];

  /** 结算明细：分次到账可逐笔冲销，已冲销的结算不可重复冲销（后端强校验）。 */
  const settlementColumns = (rebate: Rebate): ColumnsType<Settlement> => [
    { title: "结算单号", dataIndex: "settlement_no" },
    { title: "到账日", dataIndex: "settled_on" },
    {
      title: "到账金额",
      dataIndex: "gross_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "手续费",
      dataIndex: "platform_fee",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "净额",
      dataIndex: "net_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "状态",
      render: (_v, settlement) =>
        settlement.reversal_of_id ? (
          <StatusTag status="VOID" label="已冲销" />
        ) : (
          <StatusTag status="SETTLED" label="已结算" />
        ),
    },
    {
      title: "操作",
      render: (_v, settlement) =>
        settlement.reversal_of_id ? null : (
          <PermissionButton
            permission="order.event.post"
            size="small"
            danger
            onClick={() => {
              reverseForm.resetFields();
              setReverseTarget({ rebate, settlement });
              reverseForm.setFieldsValue({ reversed_on: today() });
            }}
          >
            冲销
          </PermissionButton>
        ),
    },
  ];

  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />

      <StatRow
        items={[
          { label: "返点记录数", kind: "count", amount: String(rows.length) },
          { label: "待结算", kind: "count", amount: String(pending), tone: pending ? "warn" : "plain" },
          {
            label: "到账逾期",
            kind: "count",
            amount: String(Object.keys(overdueDays).length),
            tone: Object.keys(overdueDays).length ? "warn" : "plain",
          },
        ]}
      />

      <Card
        className="glass"
        title="返点记录"
        extra={
          <PermissionButton
            permission="order.event.post"
            type="primary"
            onClick={() => {
              form.resetFields();
              setCreateOpen(true);
            }}
          >
            新增返点记录
          </PermissionButton>
        }
      >
        <DataTable<Rebate>
          columns={columns}
          rows={rows}
          loading={loading}
          page={1}
          pageSize={Math.max(rows.length, 10)}
          total={rows.length}
          scroll={{ x: "max-content" }}
          emptyText="暂无返点记录"
          onPageChange={() => undefined}
          expandable={{
            expandedRowRender: (row) => (
              <DataTable<Settlement>
                rows={settlements[row.id] ?? []}
                page={1}
                pageSize={20}
                total={(settlements[row.id] ?? []).length}
                onPageChange={() => undefined}
                emptyText="暂无结算明细"
                columns={settlementColumns(row)}
              />
            ),
          }}
        />
      </Card>

      <Modal title="新增返点记录" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <InlineError error={write.error} />
        <FieldConfigScope scope="REBATE" active={createOpen}>
        <Form form={form} layout="vertical"
          onFinish={submitCreate}
          initialValues={{ collected_on: today(), rebate_type: "BUY" }}
        >
          <CfgItem name="source_order_id" label="来源订单" rules={[{ required: true }]}>
            <Select
              options={orders
                .filter((order) => ["ACTIVE", "COMPLETED"].includes(order.status))
                .map((order) => ({ value: order.id, label: order.order_no }))}
            />
          </CfgItem>
          <CfgItem name="rebate_type" label="返点类型" rules={[{ required: true }]}>
            <Select />
          </CfgItem>
          <CfgItem name="base_amount" label="返点金额" rules={requiredMoneyRules("返点金额")}>
            <MoneyInput />
          </CfgItem>
          <CfgItem name="rate" label="返点比例" rules={percentRules("返点比例")}>
            <Input inputMode="decimal" suffix="%" placeholder="例如 5" />
          </CfgItem>
          <CfgItem name="collected_on" label="返点日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <Typography.Paragraph type="secondary">
            新返点必须关联来源订单；返点不能独立创建为订单（REB-01-02）。
          </Typography.Paragraph>
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit" loading={write.pending}>
            创建
          </PermissionButton>
        </Form>
        </FieldConfigScope>
      </Modal>

      <Modal
        title={settleTarget ? `返点到账 · ${settleTarget.rebate_no}` : "返点到账"}
        open={Boolean(settleTarget)}
        onCancel={() => setSettleTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="REBSETTLE" active={Boolean(settleTarget)}>
        <Form form={settleForm} layout="vertical" onFinish={submitSettle}>
          <CfgItem name="gross_amount" label="到账金额" rules={requiredMoneyRules("到账金额")}>
            <MoneyInput />
          </CfgItem>
          <CfgItem name="platform_fee" label="平台手续费（自动生成费用流水）" rules={requiredMoneyRules("平台手续费").slice(1)}>
            <MoneyInput />
          </CfgItem>
          <CfgItem name="pool_id" label="回款池" rules={[{ required: true }]}>
            <Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} />
          </CfgItem>
          <CfgItem name="settled_on" label="到账日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit" loading={write.pending}>
            确认结算
          </PermissionButton>
        </Form>
        </FieldConfigScope>
      </Modal>

      <Modal
        title={reverseTarget ? `冲销结算 · ${reverseTarget.settlement.settlement_no}` : "冲销结算"}
        open={Boolean(reverseTarget)}
        onCancel={() => setReverseTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="REBREVERSE" active={Boolean(reverseTarget)}>
        <Form form={reverseForm} layout="vertical" onFinish={submitReverse}>
          <Typography.Paragraph type="secondary">
            冲销会生成反向结算与反向流水，原结算标记为已冲销；冲销不可撤销、不可重复。
          </Typography.Paragraph>
          <CfgItem name="reversed_on" label="冲销日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="reason" label="冲销原因" rules={[{ required: true, message: "请填写冲销原因" }]}>
            <Input.TextArea rows={3} />
          </CfgItem>
          <PermissionButton
            permission="order.event.post"
            type="primary"
            danger
            htmlType="submit"
            loading={write.pending}
          >
            确认冲销
          </PermissionButton>
        </Form>
        </FieldConfigScope>
      </Modal>
    </section>
  );
}

