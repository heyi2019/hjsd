import { Form, Input } from "antd";
import { Select } from "../shared/ui";
import { useOptionSet } from "../shared/lib/optionSets";
import { CfgItem } from "./ConfigurableField";

export const PARTY_SOURCE_FALLBACK_OPTIONS = ["自营", "微博", "小红书", "闲鱼", "同行推荐", "其他"]
  .map((value) => ({ value, label: value }));

/** 提号订单的供货方来源与客户来源口径独立维护；未加载主数据时仍保留旧业务默认项。 */
export const SUPPLIER_SOURCE_FALLBACK_OPTIONS = ["氪金联盟", "同行", "其他"]
  .map((value) => ({ value, label: value }));

/** 客户来源只允许选择预设值；「其他」时再收集具体渠道，避免自由输入导致来源口径分散。 */
export function CustomerSourceFields(props: { name: string; otherName: string }) {
  const source = Form.useWatch(props.name);
  const form = Form.useFormInstance();
  const configuredOptions = useOptionSet("CUSTOMER_SOURCE");
  const sourceOptions = configuredOptions?.length ? configuredOptions : PARTY_SOURCE_FALLBACK_OPTIONS;
  const onChange = (value: string) => {
    if (value !== "其他") form.setFieldValue(props.otherName, undefined);
  };

  return (
    <>
      <CfgItem className="recovery-order-modal__party-field" name={props.name} label="客户来源">
        <Select placeholder="请选择客户来源" options={sourceOptions} onChange={onChange} />
      </CfgItem>
      <CfgItem
        className="recovery-order-modal__party-field recovery-customer-source-other"
        name={props.otherName}
        label="其他来源"
        rules={source === "其他" ? [{ required: true, whitespace: true, message: "请输入客户来源" }] : []}
      >
        <Input disabled={source !== "其他"} placeholder={source === "其他" ? "请输入来源名称" : "选择其他后可填写"} />
      </CfgItem>
    </>
  );
}
