/** 分期合约表及期次表的列定义。 */
import type { Dispatch, SetStateAction } from "react";
import { Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { FormInstance } from "antd";
import type { Installment, Schedule } from "../../shared/api/types/installments";
import { INSTALLMENT_STATUS_LABEL, installmentDisplayStatus, today } from "../../shared/lib/format";
import { orderTypeLabel, BUSINESS_MODE_LABEL, ORDER_TYPE_LABEL } from "../../shared/lib/labels";
import { configurableLabel } from "../../shared/lib/optionSets";
import { MoneyText, PermissionButton, StatusTag } from "../../shared/ui";
import type { Permission } from "../../shared/state/session";
import { SCHEDULE_STATUS_LABEL } from "./InstallmentsPanel.fragments";

// 可用动作 key 由后端 action_availability 下发（InstallmentOut/ScheduleOut.available_actions）。
// 前端只回显，不再按 status/dispositions 拼白名单——口径收敛到后端唯一来源。
const can = (row: { available_actions: string[] }, key: string) =>
  row.available_actions.includes(key);

export type ContractColumnsDeps = {
  gameLabel: (value: string) => string;
  payForm: FormInstance;
  recoverForm: FormInstance;
  cancelForm: FormInstance;
  settleForm: FormInstance;
  defaultForm: FormInstance;
  waiveForm: FormInstance;
  extendForm: FormInstance;
  setPayTarget: Dispatch<SetStateAction<Installment | null>>;
  setRecoverTarget: Dispatch<SetStateAction<Installment | null>>;
  setCancelTarget: Dispatch<SetStateAction<Installment | null>>;
  setSettleTarget: Dispatch<SetStateAction<Installment | null>>;
  setDefaultTarget: Dispatch<SetStateAction<Installment | null>>;
  setWaiveTarget: Dispatch<SetStateAction<Schedule | null>>;
  setExtendTarget: Dispatch<SetStateAction<Schedule | null>>;
  openDeliver: (row: Installment) => void;
  settlePermission: Permission;
};

export function buildContractColumns(deps: ContractColumnsDeps): {
  columns: ColumnsType<Installment>;
  scheduleColumns: ColumnsType<Schedule>;
} {
  const {
    gameLabel,
    payForm, recoverForm, cancelForm, settleForm, defaultForm, waiveForm, extendForm,
    setPayTarget, setRecoverTarget, setCancelTarget, setSettleTarget, setDefaultTarget,
    setWaiveTarget, setExtendTarget, openDeliver, settlePermission,
  } = deps;

  const columns: ColumnsType<Installment> = [
    { title: "合约号", dataIndex: "inst_no" },
    {
      title: "订单",
      key: "order",
      render: (_v, row) => row.order.order_no,
    },
    {
      title: "业务模式",
      key: "business",
      render: (_v, row) => BUSINESS_MODE_LABEL[row.order.account_business_mode ?? ""] || "-",
    },
    {
      title: "业务类型",
      key: "order_type",
      render: (_v, row) => {
        return orderTypeLabel(row.order.order_type, { ...ORDER_TYPE_LABEL });
      },
    },
    {
      title: "产品",
      key: "product",
      render: (_v, row) => {
        return [row.order.account_game_type ? gameLabel(row.order.account_game_type) : null, row.order.account_game_account].filter(Boolean).join(" / ") || "-";
      },
    },
    {
      title: "对方",
      key: "party",
      render: (_v, row) => row.order.party_name || "-",
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
    { title: "操作人", key: "operator", dataIndex: "operator", render: (v: string | null | undefined) => v || "-" },
    {
      title: "操作",
      key: "actions",
      render: (_v, row) => (
        <Space size={2}>
          <PermissionButton
            permission="order.event.post"
            size="small"
            disabled={!can(row, "pay")}
            onClick={() => { payForm.resetFields(); setPayTarget(row); payForm.setFieldsValue({ paid_on: today() }); }}
          >
            登记收款
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            size="small"
            type="primary"
            disabled={!can(row, "deliver")}
            onClick={() => openDeliver(row)}
          >
            换绑交付
          </PermissionButton>
          <PermissionButton
            permission="order.update"
            size="small"
            disabled={!can(row, "recover")}
            onClick={() => { recoverForm.resetFields(); setRecoverTarget(row); recoverForm.setFieldsValue({ occurred_on: today() }); }}
          >
            登记回收
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            size="small"
            danger
            disabled={!can(row, "cancel")}
            onClick={() => { cancelForm.resetFields(); setCancelTarget(row); cancelForm.setFieldsValue({ cancelled_on: today() }); }}
          >
            终止分期并退款
          </PermissionButton>
          <PermissionButton
            permission={settlePermission}
            size="small"
            disabled={!can(row, "settle_early")}
            onClick={() => { settleForm.resetFields(); setSettleTarget(row); settleForm.setFieldsValue({ paid_on: today() }); }}
          >
            提前结清
          </PermissionButton>
          <PermissionButton
            permission="order.update"
            size="small"
            danger
            disabled={!can(row, "default")}
            onClick={() => { defaultForm.resetFields(); setDefaultTarget(row); }}
          >
            登记违约
          </PermissionButton>
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
            disabled={!can(schedule, "waive")}
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
            disabled={!can(schedule, "extend")}
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

  return { columns, scheduleColumns };
}
