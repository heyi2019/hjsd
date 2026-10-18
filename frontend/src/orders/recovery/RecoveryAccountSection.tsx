import { Form, Input } from "antd";
import type { ReactNode } from "react";
import { Select } from "../../shared/ui";
import type { GameTypeOption } from "../../shared/api/catalog";
import { HAS_SECONDARY_OPTIONS } from "./recoveryConfig";
import "./RecoveryAccountSection.css";

/** 新建业务（回收/提号/代挂/代分期）的游戏账号资料区。只负责字段，不处理提交和接口。
 *  库存编号由库存中心创建账号时自动生成，业务单内联填写游戏账号信息，不再关联已有库存账号。 */
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
  }>;
  gameTypes?: GameTypeOption[];
}) {
  const fieldNames = {
    gameType: "game_type",
    gameAccount: "game_account",
    gamePassword: "game_password",
    channelRegion: "channel_region",
    boundPhone: "bound_phone",
    hasSecondary: "has_secondary",
    accountNote: "game_account_note",
    ...props.fieldNames,
  };
  return (
    <section className="recovery-account-section recovery-entry-fields" aria-labelledby="game-account-info-title">
      <div id="game-account-info-title" className="recovery-entry-fields__title">
        游戏账号信息
      </div>
      <Form.Item name={fieldNames.gameType} label="游戏类型" rules={[{ required: true, message: "游戏类型必填" }]}>
        {props.gameTypes?.length ? (
          <Select
            showSearch
            optionFilterProp="label"
            filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
            options={props.gameTypes.map((item) => ({ value: item.name, label: item.name }))}
            placeholder="请选择或搜索游戏类型"
          />
        ) : (
          <Input placeholder="例如：王者荣耀" />
        )}
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
      {props.children}
    </section>
  );
}
