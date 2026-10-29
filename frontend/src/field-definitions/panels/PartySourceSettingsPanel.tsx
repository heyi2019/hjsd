import { Card, Typography } from "antd";
import { OptionDictionarySection } from "./IntermediaryPlatformSettingsPanel";

/** 参与方来源主数据：客户与供货方分开维护，分别供四类建单表单联动使用。 */
export function PartySourceSettingsPanel() {
  return (
    <Card className="glass" title="参与方来源">
      <Typography.Paragraph type="secondary">
        客户来源供回收、代挂、代分期表单联动；供货方来源供提号表单联动。修改后会同步到对应建单表单。
      </Typography.Paragraph>
      <div className="ui-stack">
        <OptionDictionarySection
          code="CUSTOMER_SOURCE"
          title="客户来源主数据"
          description="维护回收、代挂、代分期使用的客户来源。"
        />
        <OptionDictionarySection
          code="SUPPLIER_SOURCE"
          title="供货方来源主数据"
          description="维护提号表单使用的供货方来源。"
        />
      </div>
    </Card>
  );
}
