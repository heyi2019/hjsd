import { Form, Input, Upload } from "antd";
import type { UploadFile } from "antd/es/upload/interface";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { BusinessRegistrationSection, Select } from "../../shared/ui";
import type { GameTypeOption } from "../../shared/api/types/org";
import type { EmployeeOption } from "../../shared/api/types/org";
import { CfgItem, sectionLabel } from "../ConfigurableField";
import { DeliveryInfoSection } from "../DeliveryInfoSection";
import { ResponsibleEmployeeSelect } from "../ResponsibleEmployeeSelect";
import "./RecoveryAccountSection.css";

/** 读取本地图片为 data URL：与账号描述图同构，提交前即完成转换，避免表单提交时再异步读取。 */
function readImageDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

/** 佐证图上传：受控值即 data URL 数组，最多 3 张。二次验证与钱包实名注销共用。 */
function OptionalImagesUpload({ value, onChange, namePrefix = "图片" }: { value?: string[]; onChange?: (next: string[]) => void; namePrefix?: string }) {
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  useEffect(() => {
    setFileList((current) => {
      const currentUrls = current.map((file) => file.url).filter((url): url is string => Boolean(url));
      const nextUrls = value ?? [];
      if (currentUrls.length === nextUrls.length && currentUrls.every((url, index) => url === nextUrls[index])) {
        return current;
      }
      return nextUrls.map((url, index) => ({ uid: `${namePrefix}-${index}`, name: `${namePrefix}${index + 1}`, status: "done" as const, url }));
    });
  }, [namePrefix, value]);
  const handleChange = (next: { fileList: UploadFile[] }) => {
    const sliced = next.fileList.slice(0, 3);
    setFileList(sliced);
    void Promise.all(sliced.map(async (file) => (
      file.url ?? (file.originFileObj ? readImageDataUrl(file.originFileObj) : null)
    ))).then((urls) => onChange?.(urls.filter((url): url is string => Boolean(url))));
  };
  return (
    <Upload
      listType="picture-card"
      accept="image/*"
      maxCount={3}
      fileList={fileList}
      beforeUpload={() => false}
      onChange={handleChange}
    >
      <span aria-hidden="true">＋</span>
      <div>上传图片</div>
    </Upload>
  );
}

/** 新建业务（回收/提号/代挂）的游戏账号资料区。只负责字段，不处理提交和接口。
 *  库存编号由库存中心创建账号时自动生成，业务单内联填写游戏账号信息，不再关联已有库存账号。 */
export function RecoveryAccountSection(props: {
  children?: ReactNode;
  fieldNames?: Partial<{
    gameType: string;
    gameAccount: string;
    gamePassword: string;
    campAccount: string;
    channelRegion: string;
    boundPhone: string;
    boundPhoneOwner: string;
    hasSecondary: string;
    secondaryImages: string;
    walletRealname: string;
    walletRealnameImages: string;
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
    campAccount: "camp_account",
    channelRegion: "channel_region",
    boundPhone: "bound_phone",
    boundPhoneOwner: "bound_phone_owner",
    hasSecondary: "has_secondary",
    secondaryImages: "secondary_images",
    walletRealname: "wallet_realname",
    walletRealnameImages: "wallet_realname_images",
    accountNote: "game_account_note",
    ...props.fieldNames,
  };
  const form = Form.useFormInstance();
  const accountTitle = sectionLabel("ACCOUNT_PRODUCT", "游戏账号信息");
  const selectedGameType = Form.useWatch(fieldNames.gameType, form);
  const selectedSecondary = Form.useWatch(fieldNames.hasSecondary, form);
  const selectedWalletRealname = Form.useWatch(fieldNames.walletRealname, form);
  // 「有无二次」选「有」/true 时才要求留证：其余情况不渲染上传区，提交侧同样不传图片。
  const showSecondaryImages = selectedSecondary === "有" || selectedSecondary === true;
  // 钱包实名选「已注销」时才留注销佐证图。
  const showWalletRealnameImages = selectedWalletRealname === "已注销";
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
      <CfgItem name={fieldNames.campAccount} label="营地账号">
        <Input placeholder="可选填，如绑定营地的账号" autoComplete="off" />
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
      {showSecondaryImages ? (
        <CfgItem name={fieldNames.secondaryImages} label="二次图片（选填）" className="account-secondary-images">
          <OptionalImagesUpload namePrefix="二次图片" />
        </CfgItem>
      ) : null}
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
      {showWalletRealnameImages ? (
        <CfgItem name={fieldNames.walletRealnameImages} label="钱包实名图片（选填）" className="account-secondary-images">
          <OptionalImagesUpload namePrefix="钱包实名图片" />
        </CfgItem>
      ) : null}
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
