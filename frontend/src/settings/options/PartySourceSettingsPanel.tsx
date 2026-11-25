import { Card, Typography } from "antd";
import { OptionDictionarySection } from "./IntermediaryPlatformSettingsPanel";

/** 参与方来源主数据：客户与供货方分开维护，分别供四类建单表单联动使用。 */
export function PartySourceSettingsPanel() {
  return (
    <Card className="glass" title="参与方来源">
      <Typography.Paragraph type="secondary">
        客户来源与供货方来源分别维护，修改后会同步到相关业务表单。
      </Typography.Paragraph>
      <div className="ui-stack">
        <OptionDictionarySection
          code="CUSTOMER_SOURCE"
          title="客户来源主数据"
          description="维护回收、代挂使用的客户来源。"
        />
        <OptionDictionarySection
          code="SUPPLIER_SOURCE"
          title="供货方来源主数据"
          description="维护供货方来源。"
        />
      </div>
    </Card>
  );
}
