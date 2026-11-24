/** 字段配置表格列：从 useOrderFormFieldsPanelController 逐字提取（无 hooks、无副作用改动）。 */
import type { Dispatch, SetStateAction } from "react";
import { Space, Switch, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { appMessage } from "../../shared/ui/appFeedback";
import { orderFormFieldsApi } from "../../shared/api/orders.api";
import type { OrderFormField } from "../../shared/api/types/forms";
import { normalizeError } from "../../shared/api/client";
import { FIELD_TYPE_LABEL } from "../../shared/lib/labels";
import { configurableLabel } from "../../shared/lib/optionSets";
import { ConfirmButton, PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";
import {
  FLOW_DIRECTION_OPTIONS,
  MANAGED_OPTION_FIELD_KEYS,
  describeCondition,
} from "./OrderFormFieldsPanel.fragments";

type LabelOption = { value: string; label: string };

export function buildOrderFormFieldColumns(params: {
  orderedSectionOptions: LabelOption[];
  togglingId: number | null;
  activeType: string;
  rows: OrderFormField[];
  gameTypeNames: string[];
  intermediaryPlatformNames: string[];
  intermediaryTypeNames: string[];
  compensationTypeNames: string[];
  load: (code: string) => Promise<void>;
  setError: Dispatch<SetStateAction<{ message: string; code?: string } | null>>;
  startEditing: (row: OrderFormField) => void;
  setTogglingId: Dispatch<SetStateAction<number | null>>;
}): ColumnsType<OrderFormField> {
  const {
    orderedSectionOptions, togglingId, activeType, rows,
    gameTypeNames, intermediaryPlatformNames, intermediaryTypeNames, compensationTypeNames,
    load, setError, startEditing, setTogglingId,
  } = params;
  return [
    { title: "字段键", dataIndex: "field_key" },
    { title: "标签", dataIndex: "label" },
    {
      title: "归属板块",
      dataIndex: "section",
      render: (value: OrderFormField["section"]) => orderedSectionOptions.find((item) => item.value === value)?.label ?? "其他补充信息",
    },
    { title: "排序", dataIndex: "sort_order", width: 72 },
    { title: "类型", dataIndex: "field_type", render: (v: string, row) => MANAGED_OPTION_FIELD_KEYS.includes(row.field_key) ? "联动选择" : configurableLabel("FIELD_TYPE", v, FIELD_TYPE_LABEL) },
    { title: "资金流向性质", dataIndex: "flow_direction", render: (value: OrderFormField["flow_direction"]) => FLOW_DIRECTION_OPTIONS.find((item) => item.value === value)?.label ?? "-" },
    {
      title: "必填",
      dataIndex: "required",
      render: (value: boolean, row: OrderFormField) => (
        <Space direction="vertical" size={0}>
          <PermissionGate
            permission="field-definition.manage"
            fallback={<Typography.Text type="secondary">{value ? "必填" : row.required_when ? "条件必填" : "选填"}</Typography.Text>}
          >
            <Switch
              checked={value}
              disabled={Boolean(row.required_locked)}
              loading={togglingId === row.id}
              aria-label={`必填_${row.field_key}`}
              onChange={async (checked: boolean) => {
                try {
                  setTogglingId(row.id);
                  await orderFormFieldsApi.update(row.id, { required: checked });
                  appMessage.success(checked ? "已设为必填" : row.required_when ? "已设为条件必填" : "已设为选填");
                  await load(activeType);
                } catch (err) {
                  setError(normalizeError(err));
                } finally {
                  setTogglingId(null);
                }
              }}
            />
          </PermissionGate>
          {row.required_when ? (
            <Typography.Text type="secondary" aria-label={`条件_${row.field_key}`}>
              条件必填：{describeCondition(
                rows.find((item) => item.field_key === row.required_when?.field)?.label ?? row.required_when.field,
                row.required_when,
              )}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "选项",
      dataIndex: "options",
      render: (value: Array<{ value: string; label: string }> | null | undefined, row) =>
        row.field_key === "game_type" ? `游戏类型主数据 · ${gameTypeNames.slice(0, 2).join("、") || "暂无"}等 ${gameTypeNames.length} 项` :
        row.field_key === "channel_region" ? "游戏类型渠道／区服主数据 · 随游戏类型联动" :
        row.field_key === "intermediary_platform" ? `经手平台主数据 · ${intermediaryPlatformNames.slice(0, 2).join("、") || "暂无"}等 ${intermediaryPlatformNames.length} 项` :
        row.field_key === "intermediary_type" ? `中介类型主数据 · ${intermediaryTypeNames.slice(0, 2).join("、") || "暂无"}等 ${intermediaryTypeNames.length} 项` :
        row.field_key === "compensation_type" ? `包赔类型主数据 · ${compensationTypeNames.slice(0, 2).join("、") || "暂无"}等 ${compensationTypeNames.length} 项` :
        row.field_key === "payment_pool_id" ? "资金账户主数据 · 随资金账户配置联动" :
        ["customer_source", "dg_customer_source"].includes(row.field_key) ? "客户来源主数据 · 回收/代挂共用" :
        value && value.length
          ? value.map((o) => o.label).join("、")
          : "-",
    },
    {
      title: "启用",
      dataIndex: "is_active",
      render: (value: boolean) => (
        <StatusTag status={value ? "ACTIVE" : "DISABLED"} label={value ? "是" : "否"} />
      ),
    },
    {
      title: "操作",
      render: (_v, row) => (
        <PermissionGate permission="field-definition.manage">
          <Space size={2}>
            <PermissionButton
              permission="field-definition.manage"
              size="small"
              aria-label={`编辑${row.label}`}
              onClick={() => startEditing(row)}
            >
              编辑
            </PermissionButton>
            <ConfirmButton
              permission="field-definition.manage"
              size="small"
              disabled={Boolean(row.required_locked)}
              title={row.is_active ? `停用字段「${row.label}」` : `启用字段「${row.label}」`}
              description={row.is_active
                ? "停用后该字段从建单表单消失（自定义字段值保留在订单数据中）。若被其它字段的条件必填引用，需先解除条件。"
                : "启用后该字段重新出现在建单表单中。"}
              danger={row.is_active}
              onConfirm={async () => {
                await orderFormFieldsApi.setActive(row.id, !row.is_active);
                await load(activeType);
              }}
            >
              {row.is_active ? "停用" : "启用"}
            </ConfirmButton>
              <Tooltip title={!row.is_custom ? "预置字段不可删除（仅自定义字段可删）" : undefined}>
                <span>
                  <ConfirmButton
                    permission="field-definition.manage"
                    size="small"
                    danger
                    disabled={!row.is_custom}
                    title={`删除字段「${row.label}」`}
                    description="删除后不可恢复；自定义字段的历史值仍保留在订单 form_extra 中。"
                    okText="确认删除"
                    onConfirm={async () => {
                      await orderFormFieldsApi.remove(row.id);
                      appMessage.success("字段已删除");
                      await load(activeType);
                    }}
                  >
                    删除
                  </ConfirmButton>
                </span>
              </Tooltip>
          </Space>
        </PermissionGate>
      ),
    },
  ];

}
