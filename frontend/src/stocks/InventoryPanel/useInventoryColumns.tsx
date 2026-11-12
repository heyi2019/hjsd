import { Dropdown, Space } from "antd";
import { type ColumnsType } from "antd/es/table";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import { formatDateTimeMinute } from "../../shared/lib/format";
import { MoneyText, PermissionButton, StatusTag } from "../../shared/ui";
import { BUSINESS_MODE_LABEL, INVENTORY_AGE_COLOR, INVENTORY_TYPE_LABEL, isEditableAccountType } from "../inventory-logic";
import { columnKey, useListViewColumns } from "../../shared/lib/listColumns";
import { inventoryCellValue, moreMenuItems } from "./helpers";
import { type Dispatch, type SetStateAction } from "react";

export function useInventoryColumns(params: {
  canDelete: boolean;
  editingAccount: Account | null;
  executionDetails: Record<number, AccountExecutionDetail>;
  loadExecution: (row: Account, force?: boolean) => Promise<void>;
  setSaleTarget: Dispatch<SetStateAction<Account | null>>;
  setConsignmentTarget: Dispatch<SetStateAction<Account | null>>;
  setRebateTarget: Dispatch<SetStateAction<Account | null>>;
  setDeleteTarget: Dispatch<SetStateAction<Account | null>>;
  openCashflow: (account: Account) => Promise<void>;
  openDelivery: (account: Account) => Promise<void>;
  openProfitShare: (account: Account) => Promise<void>;
  openEditor: (account: Account) => Promise<void>;
  handleMoreAction: (key: string, row: Account) => void;
}) {
  const {
    canDelete, editingAccount, executionDetails, loadExecution,
    setSaleTarget, setConsignmentTarget, setRebateTarget, setDeleteTarget,
    openCashflow, openDelivery, openProfitShare, openEditor, handleMoreAction,
  } = params;
  const { arrange: arrangeColumns } = useListViewColumns("INVENTORY");
  const columns: ColumnsType<Account> = [
    { title: "库存编号", dataIndex: "stock_no", width: 86, ellipsis: true },
    { title: "游戏/产品类型", dataIndex: "game_type", width: 80, ellipsis: true, render: (v: string | null) => inventoryCellValue(v)},
    { title: "游戏账号/产品", dataIndex: "game_account", width: 120, ellipsis: true, render: (v: string | null) => inventoryCellValue(v) },
    { title: "营地账号", dataIndex: "camp_account", width: 120, ellipsis: true, render: (v: string | null) => inventoryCellValue(v) },
    { title: "订单号", dataIndex: "source_order_no", width: 80, ellipsis: true, render: (v: string | null) => inventoryCellValue(v) },
    { title: "入库时间", dataIndex: "inventory_entry_at", width: 132, ellipsis: true, render: (v: string | null) => formatDateTimeMinute(v) },
    { title: "入库负责人", dataIndex: "inventory_operator", width: 100, ellipsis: true, render: (v: string | null, row) => inventoryCellValue(v || row.created_by) },
    { title: "业务", dataIndex: "business_mode", width: 56, ellipsis: true, render: (v: string | null) => v ? BUSINESS_MODE_LABEL[v] ?? v : inventoryCellValue(v)},
    { title: "业务类型", dataIndex: "inventory_type", width: 68, ellipsis: true, render: (v: string | null) => v ? INVENTORY_TYPE_LABEL[v] ?? v : inventoryCellValue(v) },
    {
      title: "未售时长",
      width: 68,

      // key 必须与 scopes.py 的 ListColumn 注册（inventory_age）一致，
      // 否则 arrangeColumns 按 columnKey 匹配不到，隐藏/调序配置对它无效。
      key: "inventory_age",
      // 天数与档位都由后端下发（AccountOut.inventory_age_days / _level），
      // 此处不做任何日期减法，也不再按 7/30 天判色。
      render: (_value, row) => (
        row.inventory_age_days == null
          ? inventoryCellValue(null)
          : (
            <StatusTag
              status={row.status}
              color={row.inventory_age_level ? INVENTORY_AGE_COLOR[row.inventory_age_level] : undefined}
              label={`${row.inventory_age_days}天`}
            />
          )
      ),
    },
    { title: "状态", key: "status", dataIndex: "inventory_status", width: 68, render: (v: string | undefined, row) => <StatusTag status={v ?? (row.status === "WAITING" ? "IN_STOCK" : "OUT_OF_STOCK")} optionSet="INVENTORY_STATUS" /> },
    {
      title: "成本",
      dataIndex: "cost_amount",
      width: 90,
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "操作",
      key: "actions",
      width: 420,
      render: (_value, row) => (
        <Space className="inventory-row-actions" size={4}>
          <PermissionButton
            permission="order.create"
            type="link"
            size="small"
            aria-label="售出"
            disabled={row.status !== 'WAITING'}
            onClick={(event) => {
              event.stopPropagation();
              setSaleTarget(row);
            }}
          >
            售出
          </PermissionButton>
          <PermissionButton
            permission="order.create"
            type="link"
            size="small"
            aria-label="寄售"
            disabled={row.status === "SOLD"}
            onClick={(event) => {
              event.stopPropagation();
              setConsignmentTarget(row);
            }}
          >
            寄售
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            type="link"
            size="small"
            aria-label="返点"
            onClick={(event) => {
              event.stopPropagation();
              setRebateTarget(row);
            }}
          >
            返点
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            type="link"
            size="small"
            aria-label="资金收支"
            onClick={(event) => {
              event.stopPropagation();
              void openCashflow(row);
            }}
          >
            资金收支
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            type="link"
            size="small"
            aria-label="交付"
            onClick={(event) => {
              event.stopPropagation();
              void openDelivery(row);
            }}
          >
            交付
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            type="link"
            size="small"
            aria-label="分润"
            onClick={(event) => {
              event.stopPropagation();
              void openProfitShare(row);
            }}
          >
            分润
          </PermissionButton>
          {isEditableAccountType(row.inventory_type) ? <>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              aria-label="编辑"
              disabled={editingAccount !== null}
              onClick={(event) => {
                event.stopPropagation();
                openEditor(row);
              }}
            >
              编辑
            </PermissionButton>
            <Dropdown
              trigger={["click"]}
              placement="bottomRight"
              onOpenChange={(open) => { if (open) void loadExecution(row); }}
              menu={{
                className: "inventory-more-menu",
                items: moreMenuItems(row, executionDetails[row.id]),
                onClick: ({ key }) => handleMoreAction(key, row),
              }}
            >
              <PermissionButton
                permission="order.create"
                type="link"
                size="small"
                aria-label="更多"
                onClick={(event) => event.stopPropagation()}
              >
                更多
              </PermissionButton>
            </Dropdown>
          </> : null}
          {canDelete ? <PermissionButton
            permission="order.create"
            type="link"
            size="small"
            danger
            aria-label="删除账号"
            onClick={(event) => {
              event.stopPropagation();
              setDeleteTarget(row);
            }}
          >
            删除
          </PermissionButton> : null}
        </Space>
      ),
    },
  ];
  const mobileFieldOrder = arrangeColumns(columns).map(columnKey);

  return {
    columns,
    mobileFieldOrder,
    arrangeColumns,
  };
}
