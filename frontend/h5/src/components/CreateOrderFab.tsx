/**
 * 新建订单悬浮入口（业务台账 / 工作台共用）。
 *
 * 手机上「新建」必须是单手可达的悬浮按钮，而不是页头右上角的小字 —— 页头在
 * 大屏手机上 thumb zone 之外。三种业务类型用动作面板一次选完，不跳二级菜单。
 */
import { useState } from "react";
import type { SessionUser } from "../api";
import { ActionSheet } from "./Sheet";
import { PlusIcon } from "../icons";
import { can } from "../perm";
import { navigate } from "../router";

const KINDS = [
  { key: "HS", label: "新建回收订单", hint: "收号入库，登记买入与客户" },
  { key: "TH", label: "新建提号订单", hint: "分销提号，登记供货方与预计收款" },
  { key: "DG", label: "新建代挂订单", hint: "代挂寄售，只登记账号与委托方" },
];

export function CreateOrderFab({ user }: { user: SessionUser }) {
  const [open, setOpen] = useState(false);
  if (!can(user, "order.create")) return null;
  return (
    <>
      <button type="button" className="h5-fab" aria-label="新建订单" onClick={() => setOpen(true)}>
        <PlusIcon size={24} />
      </button>
      <ActionSheet
        open={open}
        title="新建什么业务"
        description="订单号由系统按业务类型生成，不可修改"
        onClose={() => setOpen(false)}
        actions={KINDS.map((kind) => ({
          key: kind.key,
          label: kind.label,
          hint: kind.hint,
          onSelect: () => navigate(`/orders/new/${kind.key}`),
        }))}
      />
    </>
  );
}
