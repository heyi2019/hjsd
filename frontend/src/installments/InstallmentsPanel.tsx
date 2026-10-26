/** 分期：按业务合约类型分列，支持 HS / DFQ / TH / DG 的收款与风险处理。
 * 收款必须选择首付或期次；未结清不可换绑交付。 */
import { Button, Card, Form, Input, Modal, Select, Space, Tabs, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  installmentsApi,
  ordersApi,
  type Installment,
  type InstallmentDisposition,
  type Order,
  type Schedule,
} from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import { INSTALLMENT_STATUS_LABEL, money, today } from "../shared/lib/format";
import { orderTypeLabel } from "../shared/lib/labels";
import { configurableLabel } from "../shared/lib/optionSets";
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
import { requiredMoneyRules } from "../shared/lib/validators";
import { useSession } from "../shared/state/session";
import { CfgItem, FieldConfigScope } from "../orders/ConfigurableField";

/** 期次状态与合约状态取值不同（PENDING/PARTIAL/PAID/OVERDUE/WAIVED），单独映射，避免复用合约标签出现裸英文。 */
const SCHEDULE_STATUS_LABEL: Record<string, string> = {
  PENDING: "待收",
  PARTIAL: "部分收款",
  PAID: "已收",
  OVERDUE: "逾期",
  WAIVED: "已减免",
};

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

function ContractTable({
  contractType,
  reloadKey,
}: {
  contractType: string;
  reloadKey: number;
}) {
  const [rows, setRows] = useState<Installment[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const { can } = useSession();
  // 提前结清：后端接受 order.event.post 或 finance.order.event.post 任一，取当前用户实际持有的码做门控。
  const settlePermission = can("order.event.post") ? "order.event.post" : "finance.order.event.post";
  const [schedules, setSchedules] = useState<Record<number, Schedule[]>>({});
  const [dispositions, setDispositions] = useState<Record<number, InstallmentDisposition[]>>({});
  const [payTarget, setPayTarget] = useState<Installment | null>(null);
  const [deliverTarget, setDeliverTarget] = useState<Installment | null>(null);
  const [recoverTarget, setRecoverTarget] = useState<Installment | null>(null);
  const [resaleTarget, setResaleTarget] = useState<Installment | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Installment | null>(null);
  const [settleTarget, setSettleTarget] = useState<Installment | null>(null);
  const [defaultTarget, setDefaultTarget] = useState<Installment | null>(null);
  const [waiveTarget, setWaiveTarget] = useState<Schedule | null>(null);
  const [extendTarget, setExtendTarget] = useState<Schedule | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  // 弹窗不会同时打开，故全部写操作共用一个 pending/error 即可覆盖。
  const write = useAsyncAction();
  const [payForm] = Form.useForm();
  const [deliverForm] = Form.useForm();
  const [recoverForm] = Form.useForm();
  const [resaleForm] = Form.useForm();
  const [cancelForm] = Form.useForm();
  const [settleForm] = Form.useForm();
  const [defaultForm] = Form.useForm();
  const [waiveForm] = Form.useForm();
  const [extendForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, orderList] = await Promise.all([installmentsApi.list(), ordersApi.list()]);
      const filtered = list.filter((item) => item.contract_type === contractType);
      setRows(filtered);
      setOrders(orderList);
      const entries = await Promise.all(
        filtered.map(async (item) => {
          const [scheduleRows, dispositionRows] = await Promise.all([
            installmentsApi.schedules(item.id),
            installmentsApi.dispositions(item.id),
          ]);
          return [item.id, scheduleRows, dispositionRows] as const;
        }),
      );
      setSchedules(Object.fromEntries(entries.map(([id, scheduleRows]) => [id, scheduleRows])));
      setDispositions(Object.fromEntries(entries.map(([id, _scheduleRows, dispositionRows]) => [id, dispositionRows])));
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [contractType]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const submitPay = async (values: Record<string, unknown>) => {
    if (!payTarget) return;
    await write.run(async () => {
        await installmentsApi.pay(payTarget.id, {
          amount: values.amount as string,
          paid_on: values.paid_on as string,
          period_no: values.period_no === undefined ? undefined : Number(values.period_no),
        });
        message.success("收款已登记");
        setPayTarget(null);
        payForm.resetFields();
        await load();
    });
  };

  const submitDeliver = async (values: Record<string, unknown>) => {
    if (!deliverTarget) return;
    await write.run(async () => {
        await installmentsApi.deliver(deliverTarget.id, {
          delivery_mode: values.delivery_mode as string,
          delivered_on: values.delivered_on as string,
          note: values.note as string,
        });
        message.success("已完成交付，不新增现金流");
        setDeliverTarget(null);
        deliverForm.resetFields();
        await load();
    });
  };

  const submitRecover = async (values: Record<string, unknown>) => {
    if (!recoverTarget) return;
    await write.run(async () => {
        await installmentsApi.recover(recoverTarget.id, {
          occurred_on: values.occurred_on as string,
          note: values.note as string,
        });
        message.success("逾期账号已登记回收");
        setRecoverTarget(null);
        recoverForm.resetFields();
        await load();
    });
  };

  const submitResale = async (values: Record<string, unknown>) => {
    if (!resaleTarget) return;
    await write.run(async () => {
        await installmentsApi.resale(resaleTarget.id, {
          resale_order_id: Number(values.resale_order_id),
          occurred_on: values.occurred_on as string,
          note: values.note as string,
        });
        message.success("已登记出售，原分期与出售订单的利润关联保留");
        setResaleTarget(null);
        resaleForm.resetFields();
        await load();
    });
  };

  const submitCancel = async (values: Record<string, unknown>) => {
    if (!cancelTarget) return;
    await write.run(async () => {
        const result = await installmentsApi.cancel(cancelTarget.id, {
          cancelled_on: values.cancelled_on as string,
          reason: values.reason as string,
        });
        const refundSummary = `退款已登记：¥${money(result.refund_amount)}`;
        message.success(
          cancelTarget.contract_type === "PICKUP_SALE"
            ? `${refundSummary}，提号账号已结束`
            : `${refundSummary}，账号已回到库存`,
        );
        setCancelTarget(null);
        cancelForm.resetFields();
        await load();
    });
  };

  const submitSettleEarly = async (values: Record<string, unknown>) => {
    if (!settleTarget) return;
    await write.run(async () => {
        await installmentsApi.settleEarly(settleTarget.id, {
          paid_on: values.paid_on as string,
          pool_id: values.pool_id === undefined ? undefined : Number(values.pool_id),
          note: values.note as string | undefined,
        });
        message.success("已提前结清，剩余应收一次性收清");
        setSettleTarget(null);
        settleForm.resetFields();
        await load();
    });
  };

  const submitDefault = async (values: Record<string, unknown>) => {
    if (!defaultTarget) return;
    await write.run(async () => {
        await installmentsApi.markDefault(defaultTarget.id, { reason: values.reason as string });
        message.success("已登记违约，合约进入 DEFAULTED");
        setDefaultTarget(null);
        defaultForm.resetFields();
        await load();
    });
  };

  const submitWaive = async (values: Record<string, unknown>) => {
    if (!waiveTarget) return;
    await write.run(async () => {
        await installmentsApi.waiveSchedule(waiveTarget.installment_id, waiveTarget.period_no, {
          amount: values.amount as string,
          waived_on: values.waived_on as string,
          reason: values.reason as string,
        });
        message.success("期次减免已登记");
        setWaiveTarget(null);
        waiveForm.resetFields();
        await load();
    });
  };

  const submitExtend = async (values: Record<string, unknown>) => {
    if (!extendTarget) return;
    await write.run(async () => {
        await installmentsApi.extendSchedule(extendTarget.installment_id, extendTarget.period_no, {
          new_due_on: values.new_due_on as string,
          reason: values.reason as string,
        });
        message.success("期次展期已登记");
        setExtendTarget(null);
        extendForm.resetFields();
        await load();
    });
  };


  // 总应收以后端下发的 total_receivable 为准（口径唯一来源）：
  // 首付 + 每期 × 期数 + 末期调整 − 减免。旧接口无该字段时回落本地计算。
  const receivable = (row: Installment) =>
    row.total_receivable != null
      ? Number(row.total_receivable)
      : Number(row.down_payment) + Number(row.per_period) * row.periods + Number(row.final_period_adjustment ?? 0) - Number(row.waived_amount ?? 0);

  const totalReceivable = rows.reduce((sum, row) => sum + receivable(row), 0).toFixed(2);
  const totalPaid = rows.reduce((sum, row) => sum + Number(row.paid_amount), 0).toFixed(2);

  const columns: ColumnsType<Installment> = [
    { title: "合约号", dataIndex: "inst_no" },
    {
      title: "订单",
      render: (_v, row) => orders.find((order) => order.id === row.order_id)?.order_no ?? row.order_id,
    },
    {
      title: "业务",
      render: (_v, row) => BUSINESS_MODE_LABEL[orders.find((order) => order.id === row.order_id)?.account_business_mode ?? ""] || "-",
    },
    {
      title: "类型",
      render: (_v, row) => {
        const order = orders.find((item) => item.id === row.order_id);
        return order ? orderTypeLabel(order.order_type, { ...ORDER_TYPE_LABEL }) : "-";
      },
    },
    {
      title: "产品",
      render: (_v, row) => {
        const order = orders.find((item) => item.id === row.order_id);
        return order ? [order.account_game_type, order.account_game_account].filter(Boolean).join(" / ") || "-" : "-";
      },
    },
    {
      title: "对方",
      render: (_v, row) => orders.find((order) => order.id === row.order_id)?.party_name || "-",
    },
    {
      title: "总应收",
      align: "right",
      render: (_v, row) => <MoneyText value={receivable(row).toFixed(2)} />,
    },
    {
      title: "服务费",
      dataIndex: "service_fee",
      align: "right",
      render: (v: string) => <MoneyText value={v ?? "0"} />,
    },
    {
      title: "每期服务费",
      dataIndex: "per_period_service_fee",
      align: "right",
      render: (v: string) => <MoneyText value={v ?? "0"} />,
    },
    {
      title: "已收",
      dataIndex: "paid_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "坏账",
      dataIndex: "bad_debt_amount",
      align: "right",
      render: (v: string | undefined) => <MoneyText value={v ?? "0"} />,
    },
    {
      title: "剩余",
      align: "right",
      render: (_v, row) => (
        <MoneyText
          value={(
            receivable(row) - Number(row.paid_amount) - Number(row.bad_debt_amount ?? 0)
          ).toFixed(2)}
        />
      ),
    },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={configurableLabel("INSTALLMENT_STATUS", v, INSTALLMENT_STATUS_LABEL)} /> },
    {
      title: "操作",
      render: (_v, row) => (
        <Space size={2}>
          <PermissionButton
            permission="order.event.post"
            size="small"
            disabled={["DELIVERED", "CLOSED", "CANCELLED"].includes(row.status)}
            onClick={() => {
              payForm.resetFields();
              setPayTarget(row);
              payForm.setFieldsValue({ paid_on: today() });
            }}
          >
            登记收款
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            size="small"
            type="primary"
            disabled={row.status !== "SETTLED"}
            onClick={() => {
              deliverForm.resetFields();
              setDeliverTarget(row);
              deliverForm.setFieldsValue({ delivered_on: today() });
            }}
          >
            换绑交付
          </PermissionButton>
          <PermissionButton
            permission="order.exception.approve"
            size="small"
            disabled={
              !(["CLOSED", "OVERDUE", "DEFAULTED"].includes(row.status))
              || (dispositions[row.id] ?? []).some((item) => item.action === "RECOVER")
            }
            onClick={() => {
              recoverForm.resetFields();
              setRecoverTarget(row);
              recoverForm.setFieldsValue({ occurred_on: today() });
            }}
          >
            登记回收
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            size="small"
            danger
            disabled={!(["PENDING", "ACTIVE", "OVERDUE", "SETTLED"].includes(row.status))}
            onClick={() => {
              cancelForm.resetFields();
              setCancelTarget(row);
              cancelForm.setFieldsValue({ cancelled_on: today() });
            }}
          >
            终止分期并退款
          </PermissionButton>
          {/* 后端 settle-early 允许 order.event.post 或 finance.order.event.post（任一）；
              PermissionButton 只接受单个权限码，故按当前用户实际持有的那个码门控。 */}
          <PermissionButton
            permission={settlePermission}
            size="small"
            disabled={!(["PENDING", "ACTIVE", "OVERDUE"].includes(row.status))}
            onClick={() => {
              settleForm.resetFields();
              setSettleTarget(row);
              settleForm.setFieldsValue({ paid_on: today() });
            }}
          >
            提前结清
          </PermissionButton>
          <PermissionButton
            permission="order.exception.approve"
            size="small"
            danger
            disabled={!(["ACTIVE", "OVERDUE"].includes(row.status))}
            onClick={() => {
              defaultForm.resetFields();
              setDefaultTarget(row);
            }}
          >
            登记违约
          </PermissionButton>
      {["CLOSED", "OVERDUE", "DEFAULTED"].includes(row.status)
        && (dispositions[row.id] ?? []).some((item) => item.action === "RECOVER")
        && !(dispositions[row.id] ?? []).some((item) => item.action === "RESELL") ? (
          <PermissionButton
            permission="order.exception.approve"
            size="small"
            onClick={() => {
              resaleForm.resetFields();
              setResaleTarget(row);
              resaleForm.setFieldsValue({ occurred_on: today() });
            }}
          >
            登记出售
          </PermissionButton>
        ) : null}
        </Space>
      ),
    },
  ];

  const scheduleColumns: ColumnsType<Schedule> = [
    { title: "期次", render: (_v, s) => (s.period_no === 0 ? "首付" : `第 ${s.period_no} 期`) },
    { title: "到期日", dataIndex: "due_on" },
    {
      title: "应收",
      dataIndex: "due_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "已收",
      dataIndex: "received_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "已减免",
      dataIndex: "waived_amount",
      align: "right",
      render: (v: string | undefined) => <MoneyText value={v ?? "0"} />,
    },
    {
      title: "服务费率",
      dataIndex: "service_fee_rate",
      align: "right",
      render: (v: string | undefined) => (v == null || v === "" ? "—" : `${v}%`),
    },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={configurableLabel("SCHEDULE_STATUS", v, SCHEDULE_STATUS_LABEL)} /> },
    {
      title: "操作",
      render: (_v, schedule) => (
        <Space size={2}>
          <PermissionButton
            permission="order.exception.approve"
            size="small"
            disabled={["PAID", "WAIVED"].includes(schedule.status)}
            onClick={() => {
              waiveForm.resetFields();
              setWaiveTarget(schedule);
              waiveForm.setFieldsValue({ waived_on: today() });
            }}
          >
            减免
          </PermissionButton>
          <PermissionButton
            permission="order.exception.approve"
            size="small"
            disabled={["PAID", "WAIVED"].includes(schedule.status)}
            onClick={() => {
              extendForm.resetFields();
              setExtendTarget(schedule);
            }}
          >
            展期
          </PermissionButton>
        </Space>
      ),
    },
  ];

  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />

      <StatRow
        items={[
          { label: "合约数", kind: "count", amount: String(rows.length) },
          { label: "总应收", amount: totalReceivable },
          { label: "已收合计", amount: totalPaid },
          {
            label: "逾期合约",
            kind: "count",
            amount: String(rows.filter((r) => r.status === "OVERDUE").length),
            tone: rows.some((r) => r.status === "OVERDUE") ? "warn" : "plain",
          },
        ]}
      />

      <Card className="glass">
        <DataTable<Installment>
          columns={columns}
          rows={rows}
          loading={loading}
          page={1}
          pageSize={Math.max(rows.length, 10)}
          total={rows.length}
          scroll={{ x: "max-content" }}
          emptyText="暂无分期合约"
          onPageChange={() => undefined}
          expandable={{
            expandedRowRender: (row) => (
              <Space direction="vertical" size="middle" className="installment-detail-stack">
                <DataTable<Schedule>
                  rows={schedules[row.id] ?? []}
                  page={1}
                  pageSize={20}
                  total={(schedules[row.id] ?? []).length}
                  onPageChange={() => undefined}
                  emptyText="暂无期次"
                  columns={scheduleColumns}
                />
                {(dispositions[row.id] ?? []).length > 0 && (
                  <Typography.Paragraph>
                    处置记录：{(dispositions[row.id] ?? []).map((item) =>
                      `${item.action === "RECOVER" ? "回收" : "出售"}（${item.occurred_on}）`,
                    ).join("、")}
                  </Typography.Paragraph>
                )}
              </Space>
            ),
          }}
        />
      </Card>

      <Modal
        title={payTarget ? `分期收款 · ${payTarget.inst_no}` : "分期收款"}
        open={Boolean(payTarget)}
        onCancel={() => setPayTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTPAY" active={Boolean(payTarget)}>
          <Form form={payForm} layout="vertical" onFinish={submitPay}>
          <CfgItem name="period_no" label="期次（0=首付，留空按到期顺序）">
            <Select
              allowClear
              options={(schedules[payTarget?.id ?? 0] ?? []).map((schedule) => ({
                value: schedule.period_no,
                label: schedule.period_no === 0 ? "首付" : `第 ${schedule.period_no} 期`,
              }))}
            />
          </CfgItem>
          <CfgItem name="amount" label="本次实收" rules={requiredMoneyRules("本次实收")}>
            <MoneyInput />
          </CfgItem>
          <CfgItem name="paid_on" label="收款日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit" loading={write.pending}>
            确认收款
          </PermissionButton>
        </Form>
        </FieldConfigScope>
      </Modal>

      <Modal
        title={recoverTarget ? `逾期回收 · ${recoverTarget.inst_no}` : "逾期回收"}
        open={Boolean(recoverTarget)}
        onCancel={() => setRecoverTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTRECOVER" active={Boolean(recoverTarget)}>
          <Form form={recoverForm} layout="vertical" onFinish={submitRecover}>
          <CfgItem name="occurred_on" label="回收日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="note" label="回收说明" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </CfgItem>
          <PermissionButton permission="order.exception.approve" type="primary" htmlType="submit" loading={write.pending}>
            确认回收
          </PermissionButton>
        </Form>
        </FieldConfigScope>
      </Modal>

      <Modal
        title={resaleTarget ? `登记出售 · ${resaleTarget.inst_no}` : "登记出售"}
        open={Boolean(resaleTarget)}
        onCancel={() => setResaleTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTRESALE" active={Boolean(resaleTarget)}>
          <Form form={resaleForm} layout="vertical" onFinish={submitResale}>
          <Typography.Paragraph type="secondary">
            回收账号转售登记：请先在库存中心售出该账号生成售出订单，再在此关联。
            出售订单必须已登记 SELL 事件且关联同一账号，每个合约只能登记一次。
          </Typography.Paragraph>
          <CfgItem name="resale_order_id" label="出售订单" rules={[{ required: true, message: "请选择出售订单" }]}>
            <Select
              showSearch
              placeholder="请选择售出订单"
              optionFilterProp="label"
              options={orders
                .filter((item) => item.id !== resaleTarget?.order_id)
                .map((item) => ({
                  value: item.id,
                  label: `${item.order_no}${item.party_name ? ` · ${item.party_name}` : ""}`,
                }))}
            />
          </CfgItem>
          <CfgItem name="occurred_on" label="出售日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="note" label="出售说明" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </CfgItem>
          <PermissionButton permission="order.exception.approve" type="primary" htmlType="submit" loading={write.pending}>
            确认登记
          </PermissionButton>
        </Form>
        </FieldConfigScope>
      </Modal>

      <Modal
        title={deliverTarget ? `换绑交付 · ${deliverTarget.inst_no}` : "换绑交付"}
        open={Boolean(deliverTarget)}
        onCancel={() => setDeliverTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTDELIVER" active={Boolean(deliverTarget)}>
          <Form form={deliverForm} layout="vertical" onFinish={submitDeliver}>
          <CfgItem name="delivery_mode" label="交付方式" rules={[{ required: true }]}>
            <Select />
          </CfgItem>
          <CfgItem name="delivered_on" label="换绑日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="note" label="换绑凭证" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </CfgItem>
          <Typography.Paragraph type="secondary">
            仅已结清合约可交付；DELIVER 无金额、不生成现金流，不再确认收入。
          </Typography.Paragraph>
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit" loading={write.pending}>
            确认交付
          </PermissionButton>
        </Form>
        </FieldConfigScope>
      </Modal>

      <Modal
        title={cancelTarget ? `退款登记 · ${cancelTarget.inst_no}` : "退款登记"}
        open={Boolean(cancelTarget)}
        onCancel={() => setCancelTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTCANCEL" active={Boolean(cancelTarget)}>
          <Form form={cancelForm} layout="vertical" onFinish={submitCancel}>
          <Typography.Paragraph type="secondary">
            {cancelTarget?.contract_type === "PICKUP_SALE"
              ? "按已收款原资金池退款，提号取消后账号直接结束。"
              : "按已收款原资金池退款，取消后账号回到库存。"}
          </Typography.Paragraph>
          <CfgItem name="cancelled_on" label="取消日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="reason" label="取消原因" rules={[{ required: true }]}>
            <Input.TextArea rows={3} placeholder="请输入退款及取消原因" />
          </CfgItem>
          <PermissionButton permission="order.event.post" type="primary" danger htmlType="submit" loading={write.pending}>
            确认退款并终止分期
          </PermissionButton>
        </Form>
        </FieldConfigScope>
      </Modal>

      <Modal
        title={settleTarget ? `提前结清 · ${settleTarget.inst_no}` : "提前结清"}
        open={Boolean(settleTarget)}
        onCancel={() => setSettleTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTSETTLE" active={Boolean(settleTarget)}>
        <Form form={settleForm} layout="vertical" onFinish={submitSettleEarly}>
          <Typography.Paragraph type="secondary">
            一次性收清全部剩余应收，逐期生成收款并关闭未来期次；不指定资金池时按原收款资金池入账。
          </Typography.Paragraph>
          <CfgItem name="paid_on" label="结清日期" rules={[{ required: true, message: "请选择结清日期" }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="note" label="备注">
            <Input.TextArea rows={2} placeholder="可选" />
          </CfgItem>
          <PermissionButton permission={settlePermission} type="primary" htmlType="submit" loading={write.pending}>
            确认提前结清
          </PermissionButton>
        </Form>
        </FieldConfigScope>
      </Modal>

      <Modal
        title={defaultTarget ? `登记违约 · ${defaultTarget.inst_no}` : "登记违约"}
        open={Boolean(defaultTarget)}
        onCancel={() => setDefaultTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTDEFAULT" active={Boolean(defaultTarget)}>
        <Form form={defaultForm} layout="vertical" onFinish={submitDefault}>
          <Typography.Paragraph type="secondary">
            登记后合约进入 DEFAULTED，仅可继续收款或关闭，不可再交付。
          </Typography.Paragraph>
          <CfgItem name="reason" label="违约原因" rules={[{ required: true, message: "请填写违约原因" }]}>
            <Input.TextArea rows={3} />
          </CfgItem>
          <PermissionButton permission="order.exception.approve" type="primary" danger htmlType="submit" loading={write.pending}>
            确认登记违约
          </PermissionButton>
        </Form>
        </FieldConfigScope>
      </Modal>

      <Modal
        title={waiveTarget ? `期次减免 · 第 ${waiveTarget.period_no} 期` : "期次减免"}
        open={Boolean(waiveTarget)}
        onCancel={() => setWaiveTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTWAIVE" active={Boolean(waiveTarget)}>
        <Form form={waiveForm} layout="vertical" onFinish={submitWaive}>
          <Typography.Paragraph type="secondary">
            已收款部分不可减免，减免额不得超过该期未收金额；减免后该期不再计入催收。
          </Typography.Paragraph>
          <CfgItem name="amount" label="减免金额" rules={requiredMoneyRules("减免金额")}>
            <MoneyInput />
          </CfgItem>
          <CfgItem name="waived_on" label="减免日期" rules={[{ required: true, message: "请选择减免日期" }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="reason" label="减免原因" rules={[{ required: true, message: "请填写减免原因" }]}>
            <Input.TextArea rows={2} />
          </CfgItem>
          <PermissionButton permission="order.exception.approve" type="primary" htmlType="submit" loading={write.pending}>
            确认减免
          </PermissionButton>
        </Form>
        </FieldConfigScope>
      </Modal>

      <Modal
        title={extendTarget ? `期次展期 · 第 ${extendTarget.period_no} 期（原到期 ${extendTarget.due_on}）` : "期次展期"}
        open={Boolean(extendTarget)}
        onCancel={() => setExtendTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTEXTEND" active={Boolean(extendTarget)}>
        <Form form={extendForm} layout="vertical" onFinish={submitExtend}>
          <Typography.Paragraph type="secondary">
            新到期日必须晚于原到期日；逾期期次展期后回到 PENDING。
          </Typography.Paragraph>
          <CfgItem name="new_due_on" label="新到期日" rules={[{ required: true, message: "请选择新到期日" }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="reason" label="展期原因" rules={[{ required: true, message: "请填写展期原因" }]}>
            <Input.TextArea rows={2} />
          </CfgItem>
          <PermissionButton permission="order.exception.approve" type="primary" htmlType="submit" loading={write.pending}>
            确认展期
          </PermissionButton>
        </Form>
        </FieldConfigScope>
      </Modal>
    </section>
  );
}

export function InstallmentsPanel() {
  const [reloadKey, setReloadKey] = useState(0);
  const write = useAsyncAction();
  // 逾期标记是全局动作（后端按 as_of 扫描全部合约），故放在 Tab 外层并触发全量刷新。
  const runMarkOverdue = async () => {
    await write.run(async () => {
      const result = await installmentsApi.markOverdue();
      message.success(
        result.marked > 0 ? `已标记 ${result.marked} 笔逾期` : "当前无新增逾期合约",
      );
      setReloadKey((key) => key + 1);
    });
  };
  return (
    <Tabs
      defaultActiveKey="stock"
      tabBarExtraContent={
        <Space>
          <PermissionButton permission="order.event.post" size="small" loading={write.pending} onClick={() => void runMarkOverdue()}>
            标记逾期
          </PermissionButton>
          <PermissionButton permission="finance.read" size="small" onClick={() => setReloadKey((key) => key + 1)}>
            刷新
          </PermissionButton>
        </Space>
      }
      items={[
        {
          key: "stock",
          label: "分期出售",
          children: <ContractTable contractType="STOCK_SALE" reloadKey={reloadKey} />,
        },
        {
          key: "advance",
          label: "代分期",
          children: <ContractTable contractType="ADVANCE_PURCHASE" reloadKey={reloadKey} />,
        },
        {
          key: "pickup",
          label: "提号分期",
          children: <ContractTable contractType="PICKUP_SALE" reloadKey={reloadKey} />,
        },
        {
          key: "consignment",
          label: "代挂分期",
          children: <ContractTable contractType="CONSIGNMENT_SALE" reloadKey={reloadKey} />,
        },
      ]}
    />
  );
}

