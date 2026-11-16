import { Dropdown, Space } from "antd";
import { type ColumnsType } from "antd/es/table";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import { formatDateTimeMinute } from "../../shared/lib/format";
import { MoneyText, PermissionButton, StatusTag } from "../../shared/ui";
import { BUSINESS_MODE_LABEL, INVENTORY_AGE_COLOR, INVENTORY_TYPE_LABEL, isEditableAccountType } from "../inventory-logic";
import { columnKey, useListViewColumns } from "../../shared/lib/listColumns";
import { inventoryCellValue, operationMenuItems, type InventoryActionKey } from "./helpers";
import type { InventoryOrderRow } from "./types";
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
  openPlatformOffsale: (account: Account) => Promise<void>;
  openEditor: (account: Account, orderId?: number) => Promise<void>;
  handleInventoryAction: (key: InventoryActionKey, row: Account) => void;
}) {
  const {
    canDelete, editingAccount, executionDetails, loadExecution,
    setSaleTarget, setConsignmentTarget, setRebateTarget, setDeleteTarget,
    openCashflow, openPlatformOffsale, openEditor, handleInventoryAction,
  } = params;
  const { arrange: arrangeColumns } = useListViewColumns("INVENTORY");
  const columns: ColumnsType<InventoryOrderRow> = [
    { title: "库存编号", key: "stock_no", width: 86, ellipsis: true, render: (_v, row) => inventoryCellValue(row.account.stock_no) },
    { title: "订单号", dataIndex: "order_no", width: 80, ellipsis: true, render: (v: string | null) => inventoryCellValue(v) },
    { title: "入库时间", dataIndex: "inventory_entry_at", width: 132, ellipsis: true, render: (v: string | null) => formatDateTimeMinute(v) },
    { title: "入库操作人", dataIndex: "inventory_operator", width: 100, ellipsis: true, render: (v: string | null, row) => inventoryCellValue(v || row.account.created_by) },
    {
      title: "成本",
      dataIndex: "cost_amount",
      width: 90,
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    { title: "游戏/产品类型", key: "account_game_type", width: 80, ellipsis: true, render: (_v, row) => inventoryCellValue(row.account_game_type) },
    { title: "游戏账号/产品", key: "account_game_account", width: 120, ellipsis: true, render: (_v, row) => inventoryCellValue(row.account_game_account) },
    { title: "业务", key: "business_mode", width: 56, ellipsis: true, render: (_v, row) => row.account_business_mode ? BUSINESS_MODE_LABEL[row.account_business_mode] ?? row.account_business_mode : inventoryCellValue(null)},
    { title: "业务类型", dataIndex: "inventory_type", width: 68, ellipsis: true, render: (v: string | null) => v ? INVENTORY_TYPE_LABEL[v] ?? v : inventoryCellValue(v) },
    {
      title: "在手时间",
      width: 68,

      // key 必须与 scopes.py 的 ListColumn 注册（inventory_age）一致，
      // 否则 arrangeColumns 按 columnKey 匹配不到，隐藏/调序配置对它无效。
      key: "inventory_age",
      // 天数与档位都由后端下发（AccountOut.inventory_age_days / _level），
      // 此处不做任何日期减法，也不再按 7/30 天判色。
      render: (_value, row) => (
        row.account.inventory_age_days == null
          ? inventoryCellValue(null)
          : (
            <StatusTag
              status={row.account.status}
              color={row.account.inventory_age_level ? INVENTORY_AGE_COLOR[row.account.inventory_age_level] : undefined}
              label={`${row.account.inventory_age_days}天`}
            />
          )
      ),
    },
    { title: "状态", key: "status", dataIndex: "account_status", width: 68, render: (_v: string | undefined, row) => <StatusTag status={row.account.status === "WAITING" ? "IN_STOCK" : "OUT_OF_STOCK"} optionSet="INVENTORY_STATUS" /> },
    {
      title: "操作",
      key: "actions",
      width: 420,
      render: (_value, row) => {
        const account = row.account;
        const operationItems = operationMenuItems(row, executionDetails[account.id]);
        const canCancel = isEditableAccountType(row.inventory_type) && row.order_type !== "DG";
        return (
        <Space className="inventory-row-actions" size={4}>
          <PermissionButton
            permission="order.create"
            type="link"
            size="small"
            aria-label="售出"
            disabled={row.account_status !== 'WAITING'}
            onClick={(event) => {
              event.stopPropagation();
              setSaleTarget(account);
            }}
          >
            售出
          </PermissionButton>
          {operationItems.length > 0 ? <Dropdown
            trigger={["click"]}
            placement="bottomLeft"
            onOpenChange={(open) => { if (open) void loadExecution(account); }}
            menu={{
              className: "inventory-operation-menu",
              items: operationItems,
              onClick: ({ key }) => {
                if (key === "consignment") setConsignmentTarget(account);
                if (key === "offsale") void openPlatformOffsale(account);
                if (key === "description" || key === "images") handleInventoryAction(key, account);
              },
            }}
          >
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              aria-label="运营"
              onClick={(event) => event.stopPropagation()}
            >
              运营
            </PermissionButton>
          </Dropdown> : null}
          <PermissionButton
            permission="order.event.post"
            type="link"
            size="small"
            aria-label="返点"
            onClick={(event) => {
              event.stopPropagation();
              setRebateTarget(account);
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
              void openCashflow(account);
            }}
          >
            资金收支
          </PermissionButton>
          {isEditableAccountType(row.inventory_type) ? <>
            <PermissionButton
              permission="order.update"
              type="link"
              size="small"
              aria-label="编辑"
              disabled={editingAccount !== null}
              onClick={(event) => {
                event.stopPropagation();
                void openEditor(account, row.id);
              }}
            >
              编辑
            </PermissionButton>
            {canCancel ? <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              danger
              aria-label="取消"
              disabled={account.status === "SOLD" || account.status === "VOID"}
              onClick={(event) => {
                event.stopPropagation();
                handleInventoryAction("void", account);
              }}
            >
              取消
            </PermissionButton> : null}
          </> : null}
          {canDelete ? <PermissionButton
            permission="order.update"
            type="link"
            size="small"
            danger
            aria-label="删除"
            onClick={(event) => {
              event.stopPropagation();
              setDeleteTarget(account);
            }}
          >
            删除
          </PermissionButton> : null}
        </Space>
        );
      },
    },
  ];
  const mobileFieldOrder = arrangeColumns(columns).map(columnKey);

  return {
    columns,
    mobileFieldOrder,
    arrangeColumns,
  };
}
