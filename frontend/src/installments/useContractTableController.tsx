import { Form, Space } from "antd";
import { appMessage } from "../shared/ui/appFeedback";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { installmentsApi, ordersApi, type Installment, type InstallmentDisposition, type Order, type Schedule } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { downloadBlob } from "../shared/api/download";
import { INSTALLMENT_STATUS_LABEL, installmentDisplayStatus, money, today } from "../shared/lib/format";
import { orderTypeLabel, BUSINESS_MODE_LABEL, ORDER_TYPE_LABEL } from "../shared/lib/labels";
import { configurableLabel } from "../shared/lib/optionSets";
import { MoneyText, PermissionButton, StatusTag, useCompactLayout } from "../shared/ui";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { useListViewColumns } from "../shared/lib/listColumns";
import { useSession } from "../shared/state/session";
import { SCHEDULE_STATUS_LABEL } from "./InstallmentsPanel.fragments";
import type { Permission } from "../shared/state/session";

export function useContractTableController(params: { contractType: string; reloadKey: number; dateRange?: [string, string] | null }) {
  const { contractType, reloadKey, dateRange } = params;
  // 上层每次渲染都会新建 [from, to] 数组，直接当 useCallback 依赖会每次变化 →
  // load 变 → useEffect 触发 → 无限重拉。这里只依赖两个原始字符串。
  const dateFrom = dateRange?.[0] ?? "";
  const dateTo = dateRange?.[1] ?? "";
  const [rows, setRows] = useState<Installment[]>([]);
  const [totals, setTotals] = useState<{ total_receivable: string; total_paid: string; total_remaining: string } | null>(null);
  const [sortDesc, setSortDesc] = useState(true);
  const [orders, setOrders] = useState<Order[]>([]);
  const { can } = useSession();
  // 提前结清：后端接受 order.event.post 或 finance.order.event.post 任一，取当前用户实际持有的码做门控。
  const settlePermission: Permission = can("order.event.post") ? "order.event.post" : "finance.order.event.post";
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
  const compact = useCompactLayout();
  // 弹窗不会同时打开，故全部写操作共用一个 pending/error 即可覆盖。
  const write = useAsyncAction();

  // P2-274：各业务弹窗共享同一份 write.error，上一操作的失败提示会残留到其它弹窗。
  // 只要「某个业务弹窗由关到开」（含从 A 弹窗切到 B 弹窗）就清空错误态，保证每个弹窗起始干净。
  // 注意：不能把 write 放进依赖——useAsyncAction 每次渲染返回新对象，一旦放入，失败提示被
  // setError 写出后，同一次重渲染就会再次触发 effect 把 error 清掉，反而吞掉失败提示
  // （回归测试 收款提交失败 / P2-274 会因此失败）。write.clearError 本身是稳定引用，可安全调用。
  const prevTargetsRef = useRef<Record<string, unknown>>({});
  useEffect(() => {
    const targets: Record<string, unknown> = {
      payTarget, deliverTarget, recoverTarget, resaleTarget,
      cancelTarget, settleTarget, defaultTarget, waiveTarget, extendTarget,
    };
    const openedNew = Object.keys(targets).some((k) => targets[k] && !prevTargetsRef.current[k]);
    if (openedNew) write.clearError();
    prevTargetsRef.current = targets;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payTarget, deliverTarget, recoverTarget, resaleTarget, cancelTarget, settleTarget, defaultTarget, waiveTarget, extendTarget]);
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
      // 日期区间与合计都走服务端：列表与合计同条件，前端不再本地筛/本地求和。
      const rangeParams = {
        trade_date_from: dateFrom || undefined,
        trade_date_to: dateTo || undefined,
      };
      const [list, orderList, summary] = await Promise.all([
        installmentsApi.list(rangeParams),
        ordersApi.list(),
        installmentsApi.totals(rangeParams),
      ]);
      const filtered = list.filter((item) => item.contract_type === contractType);
      setRows(filtered);
      setOrders(orderList);
      setTotals(summary);
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
  }, [contractType, dateFrom, dateTo]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const [exporting, setExporting] = useState(false);
  /** 分期与回款按列配置导出 CSV：导出全部分期合约（含其他业务类型的合约表）。 */
  const exportCsv = async () => {
    setExporting(true);
    try {
      downloadBlob(await installmentsApi.exportCsv(), `分期与回款-${today()}.csv`);
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setExporting(false);
    }
  };

  const submitPay = async (values: Record<string, unknown>) => {
    if (!payTarget) return;
    await write.run(async () => {
        await installmentsApi.pay(payTarget.id, {
          amount: values.amount as string,
          paid_on: values.paid_on as string,
          period_no: values.period_no === undefined ? undefined : Number(values.period_no),
          form_extra: values.form_extra as Record<string, unknown> | undefined,
        });
        appMessage.success("收款已登记");
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
          bound_phone: values.bound_phone ? String(values.bound_phone) : undefined,
          bound_phone_owner: values.bound_phone_owner ? String(values.bound_phone_owner) : undefined,
          form_extra: values.form_extra as Record<string, unknown> | undefined,
        });
        appMessage.success("已完成交付，不新增现金流");
        setDeliverTarget(null);
        deliverForm.resetFields();
        await load();
    });
  };

  const openDeliver = (row: Installment) => {
    const order = orders.find((item) => item.id === row.order_id);
    deliverForm.resetFields();
    setDeliverTarget(row);
    deliverForm.setFieldsValue({
      delivered_on: today(),
      bound_phone: order?.account_snapshot?.bound_phone ?? undefined,
      bound_phone_owner: order?.account_snapshot?.bound_phone_owner ?? undefined,
    });
  };

  const submitRecover = async (values: Record<string, unknown>) => {
    if (!recoverTarget) return;
    await write.run(async () => {
        await installmentsApi.recover(recoverTarget.id, {
          occurred_on: values.occurred_on as string,
          note: values.note as string,
          form_extra: values.form_extra as Record<string, unknown> | undefined,
        });
        appMessage.success("逾期账号已登记回收");
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
          form_extra: values.form_extra as Record<string, unknown> | undefined,
        });
        appMessage.success("已登记出售，原分期与出售订单的利润关联保留");
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
          form_extra: values.form_extra as Record<string, unknown> | undefined,
        });
        const refundSummary = `退款已登记：¥${money(result.refund_amount)}`;
        appMessage.success(
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
          form_extra: values.form_extra as Record<string, unknown> | undefined,
        });
        appMessage.success("已提前结清，剩余应收一次性收清");
        setSettleTarget(null);
        settleForm.resetFields();
        await load();
    });
  };

  const submitDefault = async (values: Record<string, unknown>) => {
    if (!defaultTarget) return;
    await write.run(async () => {
        await installmentsApi.markDefault(defaultTarget.id, { reason: values.reason as string, form_extra: values.form_extra as Record<string, unknown> | undefined });
        appMessage.success("已登记违约，合约进入 DEFAULTED");
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
          form_extra: values.form_extra as Record<string, unknown> | undefined,
        });
        appMessage.success("期次减免已登记");
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
          form_extra: values.form_extra as Record<string, unknown> | undefined,
        });
        appMessage.success("期次展期已登记");
        setExtendTarget(null);
        extendForm.resetFields();
        await load();
    });
  };

  // 总应收 / 剩余应收都只采用后端下发值（含「不小于 0」的 clamp），前端不再自行推导。

  // 合计直接取服务端（Decimal）；日期区间已在后端筛，列表不再二次过滤。
  const totalReceivable = totals?.total_receivable ?? "0.00";
  const totalPaid = totals?.total_paid ?? "0.00";

  const { arrange: arrangeColumns } = useListViewColumns("INSTALLMENT");
  const columns: ColumnsType<Installment> = [
    { title: "合约号", dataIndex: "inst_no" },
    {
      title: "订单",
      key: "order",
      render: (_v, row) => orders.find((order) => order.id === row.order_id)?.order_no ?? row.order_id,
    },
    {
      title: "业务",
      key: "business",
      render: (_v, row) => BUSINESS_MODE_LABEL[orders.find((order) => order.id === row.order_id)?.account_business_mode ?? ""] || "-",
    },
    {
      title: "类型",
      key: "order_type",
      render: (_v, row) => {
        const order = orders.find((item) => item.id === row.order_id);
        return order ? orderTypeLabel(order.order_type, { ...ORDER_TYPE_LABEL }) : "-";
      },
    },
    {
      title: "产品",
      key: "product",
      render: (_v, row) => {
        const order = orders.find((item) => item.id === row.order_id);
        return order ? [order.account_game_type, order.account_game_account].filter(Boolean).join(" / ") || "-" : "-";
      },
    },
    {
      title: "对方",
      key: "party",
      render: (_v, row) => orders.find((order) => order.id === row.order_id)?.party_name || "-",
    },
    {
      title: "总应收",
      key: "receivable",
      align: "right",
      dataIndex: "total_receivable",
      render: (value: string) => <MoneyText value={value} />,
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
      key: "bad_debt",
      dataIndex: "bad_debt_amount",
      align: "right",
      render: (v: string | undefined) => <MoneyText value={v ?? "0"} />,
    },
    {
      title: "剩余",
      key: "remaining",
      align: "right",
      dataIndex: "remaining_receivable",
      render: (value: string) => <MoneyText value={value ?? "0.00"} />,
    },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={installmentDisplayStatus(v)} label={configurableLabel("INSTALLMENT_STATUS", installmentDisplayStatus(v), INSTALLMENT_STATUS_LABEL)} /> },
    {
      title: "操作",
      key: "actions",
      render: (_v, row) => (
        <Space size={2}>
          <PermissionButton
            permission="order.event.post"
            size="small"
            disabled={["SETTLED", "DELIVERED", "CLOSED", "CANCELLED"].includes(row.status)}
            onClick={() => { payForm.resetFields(); setPayTarget(row); payForm.setFieldsValue({ paid_on: today() }); }}
          >
            登记收款
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            size="small"
            type="primary"
            disabled={row.status !== "SETTLED"}
            onClick={() => openDeliver(row)}
          >
            换绑交付
          </PermissionButton>
          <PermissionButton
            permission="order.update"
            size="small"
            disabled={
              !(["CLOSED", "OVERDUE", "DEFAULTED"].includes(row.status)) ||
              dispositions[row.id]?.some((item) => item.action === "RECOVER")
            }
            onClick={() => { recoverForm.resetFields(); setRecoverTarget(row); recoverForm.setFieldsValue({ occurred_on: today() }); }}
          >
            登记回收
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            size="small"
            danger
            disabled={!(["PENDING", "ACTIVE", "OVERDUE"].includes(row.status))}
            onClick={() => { cancelForm.resetFields(); setCancelTarget(row); cancelForm.setFieldsValue({ cancelled_on: today() }); }}
          >
            终止分期并退款
          </PermissionButton>
          <PermissionButton
            permission={settlePermission}
            size="small"
            disabled={!(["PENDING", "ACTIVE", "OVERDUE"].includes(row.status))}
            onClick={() => { settleForm.resetFields(); setSettleTarget(row); settleForm.setFieldsValue({ paid_on: today() }); }}
          >
            提前结清
          </PermissionButton>
          <PermissionButton
            permission="order.update"
            size="small"
            danger
            disabled={!(["ACTIVE", "OVERDUE"].includes(row.status))}
            onClick={() => { defaultForm.resetFields(); setDefaultTarget(row); }}
          >
            登记违约
          </PermissionButton>
          {["CLOSED", "OVERDUE", "DEFAULTED"].includes(row.status) &&
            dispositions[row.id]?.some((item) => item.action === "RECOVER") &&
            !dispositions[row.id]?.some((item) => item.action === "RESELL") && (
              <PermissionButton
                permission="order.update"
                size="small"
                onClick={() => { resaleForm.resetFields(); setResaleTarget(row); resaleForm.setFieldsValue({ occurred_on: today() }); }}
              >
                登记出售
              </PermissionButton>
            )}
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
            permission="order.update"
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
            permission="order.update"
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


  return {
    rows,
    setRows,
    sortDesc,
    setSortDesc,
    orders,
    setOrders,
    can,
    settlePermission,
    schedules,
    setSchedules,
    dispositions,
    setDispositions,
    payTarget,
    setPayTarget,
    deliverTarget,
    setDeliverTarget,
    recoverTarget,
    setRecoverTarget,
    resaleTarget,
    setResaleTarget,
    cancelTarget,
    setCancelTarget,
    settleTarget,
    setSettleTarget,
    defaultTarget,
    setDefaultTarget,
    waiveTarget,
    setWaiveTarget,
    extendTarget,
    setExtendTarget,
    error,
    setError,
    loading,
    setLoading,
    compact,
    write,
    payForm,
    deliverForm,
    recoverForm,
    resaleForm,
    cancelForm,
    settleForm,
    defaultForm,
    waiveForm,
    extendForm,
    load,
    exporting,
    setExporting,
    exportCsv,
    submitPay,
    submitDeliver,
    openDeliver,
    submitRecover,
    submitResale,
    submitCancel,
    submitSettleEarly,
    submitDefault,
    submitWaive,
    submitExtend,
    totalReceivable,
    totalPaid,
    arrangeColumns,
    columns,
    scheduleColumns,
  };
}

export type ContractTableController = ReturnType<typeof useContractTableController>;
