/** 业务中心：业务作业 / 订单台账 / 库存 / 分期 / 返点（页面原型 §3）。
 * 资金类动作一律不在列表内直接过账：必须打开详情弹窗发起。 */
import { Card, Form, Input, Modal, Select, Space, Tabs, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  ordersApi,
  orderTypesApi,
  type Order,
  type OrderType,
  type OrderTypeRoute,
} from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import { EVENT_TYPE_LABEL, today } from "../shared/lib/format";
import { CAPITAL_TYPE_LABEL, orderTypeLabel } from "../shared/lib/labels";
import { InventoryPanel } from "../accounts/InventoryPanel";
import { InstallmentsPanel } from "../installments/InstallmentsPanel";
import { RebatesPanel } from "../rebates/RebatesPanel";
import {
  DataTable,
  ErrorBanner,
  PermissionButton,
  StatusTag,
} from "../shared/ui";

interface EventForm {
  event_type: string;
  amount?: string;
  occurred_on: string;
  portion: string;
  delivery_mode?: string;
  note?: string;
}

/** 事件弹窗只给「可过账」集合：`TRANSFER` 走资金中心专属入口（POST /transfers），
 *  放进事件表单必然被后端以「不是可过账的金额事件」拒绝（实测 422）。 */
const POSTABLE_EVENT_TYPES = ["BUY", "COST", "SELL", "PAYMENT", "DELIVER", "CANCEL"] as const;

/** 份额中文标签（与后端 Portion 枚举一一对应）。 */
const PORTION_LABEL: Record<string, string> = {
  PRINCIPAL: "本金",
  PROFIT: "利润",
  GROSS: "总额",
};

/** 路由接口不可用时的兜底份额：至少不给出必然失败项（HS/TH/DFQ 通用）。 */
const FALLBACK_PORTIONS = ["PRINCIPAL", "PROFIT"];

/** 交付方式：与分期「换绑交付」同一口径（后端 delivery_mode = PLATFORM_OPERATOR / CUSTOMER_SELF）。 */
const DELIVERY_MODE_OPTIONS = [
  { value: "PLATFORM_OPERATOR", label: "平台/本方操作换绑" },
  { value: "CUSTOMER_SELF", label: "客户自行换绑" },
];

export function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [types, setTypes] = useState<OrderType[]>([]);
  const [eventOrder, setEventOrder] = useState<Order | null>(null);
  const [eventPortions, setEventPortions] = useState<string[]>(FALLBACK_PORTIONS);
  const [filterType, setFilterType] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [eventForm] = Form.useForm<EventForm>();
  const watchedEventType = Form.useWatch("event_type", eventForm);
  const isDeliver = watchedEventType === "DELIVER";

  const load = useCallback(async () => {
    try {
      const [list, typeList] = await Promise.all([ordersApi.list(), orderTypesApi.list()]);
      setOrders(list);
      setTypes(typeList);
      setLoadError(null);
    } catch (error) {
      setLoadError(normalizeError(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 打开事件弹窗：先按该订单业务拉取其真实配置的资金份额路由，再回填默认份额。
   *  份额选项与默认值都必须来自路由表——DG 只配 PROFIT/GROSS，写死 PRINCIPAL 会直接撞
   *  `POOL_ROUTE_MISSING`（实测：DG 单登记任何金额事件都会 422）。 */
  const openEvent = useCallback(
    async (order: Order) => {
      const definition = types.find((type) => type.code === order.order_type);
      let portions: string[] = FALLBACK_PORTIONS;
      if (definition) {
        try {
          const routes = await orderTypesApi.routes(definition.id);
          const active = routes
            .filter((route: OrderTypeRoute) => route.is_active)
            .map((route) => route.portion);
          if (active.length) portions = active;
        } catch (error) {
          setLoadError(normalizeError(error));
        }
      }
      setEventPortions(portions);
      setEventOrder(order);
      eventForm.resetFields();
      eventForm.setFieldsValue({ occurred_on: today(), event_type: "BUY", portion: portions[0] });
    },
    [eventForm, types],
  );

  const submitEvent = async (values: EventForm) => {
    if (!eventOrder) return;
    try {
      const result = await ordersApi.postEvent(eventOrder.id, {
        event_type: values.event_type,
        amount: values.amount || "0",
        occurred_on: values.occurred_on,
        portion: values.portion,
        // 换绑交付必须带交付方式，否则后端以 DELIVERY_CONDITION_UNMET 拒绝（实测 422）。
        delivery_mode: values.event_type === "DELIVER" ? values.delivery_mode : undefined,
        note: values.note,
      });
      message.success(
        result.cashflow_no
          ? `已过账，流水号 ${result.cashflow_no}`
          : "已登记（无金额事件，不产生现金流）",
      );
      setEventOrder(null);
      eventForm.resetFields();
      await load();
    } catch (error) {
      setLoadError(normalizeError(error));
    }
  };

  const filtered = filterType ? orders.filter((order) => order.order_type === filterType) : orders;
  const pending = filtered.filter((order) => ["DRAFT", "ACTIVE"].includes(order.status));
  const typeNames = Object.fromEntries(types.map((type) => [type.code, type.name]));

  const worklistColumns: ColumnsType<Order> = [
    { title: "订单号", dataIndex: "order_no" },
    { title: "业务", dataIndex: "order_type", render: (v: string) => orderTypeLabel(v, typeNames) },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    { title: "成交日", dataIndex: "trade_date" },
    {
      title: "下一步",
      render: (_v, row) => (
        <PermissionButton
          permission="order.event.post"
          type="link"
          size="small"
          onClick={() => void openEvent(row)}
        >
          登记事件
        </PermissionButton>
      ),
    },
  ];

  const ledgerColumns: ColumnsType<Order> = [
    { title: "订单号", dataIndex: "order_no" },
    { title: "业务", dataIndex: "order_type", render: (v: string) => orderTypeLabel(v, typeNames) },
    { title: "资金性质", dataIndex: "capital_type", render: (v: string) => CAPITAL_TYPE_LABEL[v] ?? v },
    { title: "成交日", dataIndex: "trade_date" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    {
      title: "操作",
      render: (_v, row) => (
        <PermissionButton
          permission="order.event.post"
          type="link"
          size="small"
          onClick={() => void openEvent(row)}
        >
          登记事件
        </PermissionButton>
      ),
    },
  ];

  return (
    <section className="ui-stack">
      <ErrorBanner error={loadError} />

      <Tabs
        defaultActiveKey="worklist"
        items={[
          {
            key: "worklist",
            label: "业务作业",
            children: (
              <Card className="glass">
                <Space className="ui-filter-bar" style={{ marginBottom: 12 }}>
                  <Select
                    allowClear
                    placeholder="业务类型"
                    style={{ width: 180 }}
                    value={filterType}
                    onChange={(value) => {
                      setFilterType(value);
                      setPage(1);
                    }}
                    options={types.map((type) => ({
                      value: type.code,
                      label: type.name,
                    }))}
                  />
                  <Typography.Text type="secondary">
                    资金操作不在列表内直接过账，请打开详情发起
                  </Typography.Text>
                </Space>
                <DataTable<Order>
                  columns={worklistColumns}
                  rows={pending}
                  page={1}
                  pageSize={Math.max(pending.length, 10)}
                  total={pending.length}
                  emptyText="当前没有待处理业务"
                  onPageChange={() => undefined}
                />
              </Card>
            ),
          },
          {
            key: "orders",
            label: "订单台账",
            children: (
              <Card className="glass">
                <DataTable<Order>
                  columns={ledgerColumns}
                  rows={filtered}
                  page={page}
                  pageSize={pageSize}
                  total={filtered.length}
                  emptyText="暂无订单"
                  onPageChange={(nextPage, nextSize) => {
                    setPage(nextPage);
                    setPageSize(nextSize);
                  }}
                />
              </Card>
            ),
          },
          { key: "inventory", label: "库存", children: <InventoryPanel /> },
          { key: "installments", label: "分期", children: <InstallmentsPanel /> },
          { key: "rebates", label: "返点", children: <RebatesPanel /> },
        ]}
      />

      <Modal
        title={eventOrder ? `登记事件 · ${eventOrder.order_no}` : "登记事件"}
        open={Boolean(eventOrder)}
        onCancel={() => setEventOrder(null)}
        footer={null}
      >
        <Form
          form={eventForm}
          layout="vertical"
          onFinish={submitEvent}
          initialValues={{ occurred_on: today(), portion: eventPortions[0], event_type: "BUY" }}
        >
          <Form.Item name="event_type" label="事件类型" rules={[{ required: true }]}>
            <Select
              options={POSTABLE_EVENT_TYPES.map((value) => ({
                value,
                label: EVENT_TYPE_LABEL[value] ?? value,
              }))}
            />
          </Form.Item>
          <Form.Item name="amount" label="金额（DELIVER 无金额，留空）">
            <Input disabled={isDeliver} />
          </Form.Item>
          <Form.Item
            name="portion"
            label="资金份额（按本业务已配置路由）"
            rules={[{ required: true, message: "请选择资金份额" }]}
          >
            <Select
              options={eventPortions.map((value) => ({
                value,
                label: PORTION_LABEL[value] ?? value,
              }))}
            />
          </Form.Item>
          {isDeliver ? (
            <Form.Item
              name="delivery_mode"
              label="交付方式"
              rules={[{ required: true, message: "换绑交付必须选择交付方式" }]}
            >
              <Select options={DELIVERY_MODE_OPTIONS} />
            </Form.Item>
          ) : null}
          <Form.Item name="occurred_on" label="发生日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item
            name="note"
            label={isDeliver ? "交付凭证说明（必填）" : "凭证说明（DELIVER 必填）"}
            rules={isDeliver ? [{ required: true, message: "换绑交付必须记录凭证说明" }] : []}
          >
            <Input.TextArea rows={2} />
          </Form.Item>
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit">
            提交过账
          </PermissionButton>
        </Form>
      </Modal>
    </section>
  );
}

