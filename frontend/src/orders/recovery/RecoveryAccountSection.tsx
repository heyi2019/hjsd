import { Form, Input } from "antd";
import type { ReactNode } from "react";
import type { Account } from "../../shared/api/catalog";
import { Select } from "../../shared/ui";
import { HAS_SECONDARY_OPTIONS } from "./recoveryConfig";
import "./RecoveryAccountSection.css";

/** 新建回收的游戏账号资料区。只负责字段，不处理提交和接口。 */
export function RecoveryAccountSection(props: {
  children?: ReactNode;
  fieldNames?: Partial<{
    gameType: string;
    gameAccount: string;
    gamePassword: string;
    channelRegion: string;
    boundPhone: string;
    hasSecondary: string;
    accountNote: string;
    accountId: string;
  }>;
  /** 回收/代挂只选择库存中心已建档账号；不在业务订单里重复建档。 */
  inventoryAccounts?: Account[];
}) {
  const fieldNames = {
    gameType: "game_type",
    gameAccount: "game_account",
    gamePassword: "game_password",
    channelRegion: "channel_region",
    boundPhone: "bound_phone",
    hasSecondary: "has_secondary",
    accountNote: "game_account_note",
    accountId: "account_id",
    ...props.fieldNames,
  };
  const inventoryAccounts = props.inventoryAccounts;
  return (
    <section className="recovery-account-section recovery-entry-fields" aria-labelledby="game-account-info-title">
      <div id="game-account-info-title" className="recovery-entry-fields__title">
        {inventoryAccounts ? "选择库存账号" : "游戏账号信息"}
      </div>
      {inventoryAccounts ? (
        <Form.Item
          name={fieldNames.accountId}
          label="库存账号"
          rules={[{ required: true, message: "请选择库存账号" }]}
          extra={inventoryAccounts.length ? "账号资料统一维护在库存中心" : "请先到库存中心新增账号"}
        >
          <Select
            placeholder="请选择已建档库存账号"
            disabled={!inventoryAccounts.length}
            options={inventoryAccounts.map((account) => ({
              value: account.id,
              label: `${account.inventory_no} · ${account.game_account || "未填写游戏账号"}`,
            }))}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
      ) : (
        <>
          <Form.Item name={fieldNames.gameType} label="游戏类型" rules={[{ required: true, message: "游戏类型必填" }]}>
            <Input placeholder="例如：王者荣耀" />
          </Form.Item>
          <Form.Item name={fieldNames.gameAccount} label="游戏账号" rules={[{ required: true, message: "游戏账号必填" }]}>
            <Input placeholder="请输入游戏账号" />
          </Form.Item>
          <Form.Item name={fieldNames.gamePassword} label="账号密码" rules={[{ required: true, message: "账号密码必填" }]}>
            <Input placeholder="请输入账号密码" />
          </Form.Item>
          <Form.Item name={fieldNames.channelRegion} label="渠道／区服" rules={[{ required: true, message: "渠道／区服必填" }]}>
            <Input placeholder="例如：安卓一区／微信" />
          </Form.Item>
          <Form.Item name={fieldNames.boundPhone} label="绑定手机号">
            <Input placeholder="可选填" />
          </Form.Item>
          <Form.Item name={fieldNames.hasSecondary} label="有无二次">
            <Select options={HAS_SECONDARY_OPTIONS} />
          </Form.Item>
          <Form.Item className="recovery-entry-fields__account-note" name={fieldNames.accountNote} label="账号备注">
            <Input placeholder="可选填" />
          </Form.Item>
        </>
      )}
      {props.children}
    </section>
  );
}
