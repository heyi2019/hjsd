import { Form, Input } from "antd";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { BusinessRegistrationSection, Select } from "../../shared/ui";
import type { GameTypeOption } from "../../shared/api/catalog";
import type { EmployeeOption } from "../../shared/api/catalog";
import { CfgItem, sectionLabel } from "../ConfigurableField";
import { DeliveryInfoSection } from "../DeliveryInfoSection";
import { ResponsibleEmployeeSelect } from "../ResponsibleEmployeeSelect";
import "./RecoveryAccountSection.css";

/** 新建业务（回收/提号/代挂）的游戏账号资料区。只负责字段，不处理提交和接口。
 *  库存编号由库存中心创建账号时自动生成，业务单内联填写游戏账号信息，不再关联已有库存账号。 */
export function RecoveryAccountSection(props: {
  children?: ReactNode;
  fieldNames?: Partial<{
    gameType: string;
    gameAccount: string;
    gamePassword: string;
    channelRegion: string;
    boundPhone: string;
    boundPhoneOwner: string;
    hasSecondary: string;
    walletRealname: string;
    accountNote: string;
  }>;
  accountExtras?: ReactNode;
  gameTypes?: GameTypeOption[];
  employees?: EmployeeOption[];
  businessResponsibleLabel?: string;
  showIntermediaryDelivery?: boolean;
}) {
  const fieldNames = {
    gameType: "game_type",
    gameAccount: "game_account",
    gamePassword: "game_password",
    channelRegion: "channel_region",
    boundPhone: "bound_phone",
    boundPhoneOwner: "bound_phone_owner",
    hasSecondary: "has_secondary",
    walletRealname: "wallet_realname",
    accountNote: "game_account_note",
    ...props.fieldNames,
  };
  const form = Form.useFormInstance();
  const accountTitle = sectionLabel("ACCOUNT_PRODUCT", "游戏账号信息");
  const selectedGameType = Form.useWatch(fieldNames.gameType, form);
  const channelRegions = props.gameTypes?.find((item) => item.name === selectedGameType)?.channel_regions ?? [];
  const selectedChannelRegion = Form.useWatch(fieldNames.channelRegion, form);
  const filterLibraryOption = (input: string, option?: { label?: ReactNode }) =>
    String(option?.label ?? "").toLocaleLowerCase().includes(input.trim().toLocaleLowerCase());
  useEffect(() => {
    if (channelRegions.length && selectedChannelRegion && !channelRegions.includes(String(selectedChannelRegion))) {
      form.setFieldValue(fieldNames.channelRegion, undefined);
    }
  }, [channelRegions, fieldNames.channelRegion, form, selectedChannelRegion]);
  return (
    <BusinessRegistrationSection className="account-section" title={accountTitle}>
      <CfgItem name={fieldNames.gameType} label="游戏类型" rules={[{ required: true, message: "游戏类型必填" }]}>
        {props.gameTypes?.length ? (
          <Select
            showSearch
            optionFilterProp="label"
            filterOption={filterLibraryOption}
            defaultActiveFirstOption
            options={props.gameTypes.map((item) => ({ value: item.name, label: item.name }))}
            placeholder="请选择或搜索游戏类型"
            notFoundContent="没有匹配的库内选项"
          />
        ) : (
          <Input placeholder="例如：王者荣耀" />
        )}
      </CfgItem>
      <CfgItem name={fieldNames.gameAccount} label="游戏账号" rules={[{ required: true, message: "游戏账号必填" }]}>
        <Input placeholder="请输入游戏账号" />
      </CfgItem>
      <CfgItem name={fieldNames.gamePassword} label="账号密码" rules={[{ required: true, message: "账号密码必填" }]}>
        <Input placeholder="请输入账号密码" />
      </CfgItem>
      <CfgItem name={fieldNames.channelRegion} label="渠道／区服" rules={[{ required: true, message: "渠道／区服必填" }]}>
        {channelRegions.length ? (
          <Select
            showSearch
            optionFilterProp="label"
            filterOption={filterLibraryOption}
            defaultActiveFirstOption
            options={channelRegions.map((item) => ({ value: item, label: item }))}
            placeholder="请选择或搜索渠道／区服"
            notFoundContent="没有匹配的库内选项"
          />
        ) : (
          <Input placeholder="例如：安卓一区／微信" />
        )}
      </CfgItem>
      <CfgItem name={fieldNames.hasSecondary} label="有无二次">
        <Select />
      </CfgItem>
      <CfgItem name={fieldNames.walletRealname} label="钱包实名">
        <Select
          allowClear
          placeholder="请选择"
          options={[
            { value: "未注销", label: "未注销" },
            { value: "已注销", label: "已注销" },
          ]}
        />
      </CfgItem>
      {props.businessResponsibleLabel ? <ResponsibleEmployeeSelect name="business_responsible_ids" label={props.businessResponsibleLabel} employees={props.employees ?? []} /> : null}
      <CfgItem name={fieldNames.accountNote} label="账号备注" className="account-note">
        <Input placeholder="可选填" />
      </CfgItem>
      {props.accountExtras}
      {props.children}
      <DeliveryInfoSection showIntermediary={props.showIntermediaryDelivery} employees={props.employees} />
    </BusinessRegistrationSection>
  );
}
