import { Form, Input } from "antd";
import { Select } from "../shared/ui";
import { useOptionSet } from "../shared/lib/optionSets";
import { CfgItem } from "./ConfigurableField";

/** 客户来源只允许选择预设值；「其他」时再收集具体渠道，避免自由输入导致来源口径分散。 */
export function CustomerSourceFields(props: { name: string; otherName: string }) {
  const source = Form.useWatch(props.name);
  const form = Form.useFormInstance();
  const configuredOptions = useOptionSet("CUSTOMER_SOURCE");
  const onChange = (value: string) => {
    if (value !== "其他") form.setFieldValue(props.otherName, undefined);
  };

  return (
    <>
      <CfgItem name={props.name} label="客户来源">
        <Select placeholder="请选择客户来源" options={configuredOptions ?? []} loading={configuredOptions === null} disabled={configuredOptions === null} onChange={onChange} />
      </CfgItem>
      <CfgItem
        className="customer-source-other"
        name={props.otherName}
        label="其他来源"
        rules={source === "其他" ? [{ required: true, whitespace: true, message: "请输入其他来源" }] : []}
      >
        <Input disabled={source !== "其他"} placeholder={source === "其他" ? "请输入来源名称" : "选择其他后可填写"} />
      </CfgItem>
    </>
  );
}
