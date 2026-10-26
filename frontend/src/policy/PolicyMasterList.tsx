import { Card, List } from "antd";
import type { PolicyDefinition } from "../shared/api/catalog";
import { StatusTag } from "../shared/ui";

interface PolicyMasterListProps {
  definitions: PolicyDefinition[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  scopeOptions: { value: string; label: string }[];
}

/** 经营规则主列表（左栏）：系统预置闭集，仅作选择，不提供新建入口。 */
export function PolicyMasterList({ definitions, selectedId, onSelect, scopeOptions }: PolicyMasterListProps) {
  return (
    <Card title="规则清单" className="glass">
      <List
        data-testid="policy-master"
        className="policy-master"
        dataSource={definitions}
        renderItem={(d) => (
          <List.Item
            key={d.id}
            className={d.id === selectedId ? "is-active" : ""}
            onClick={() => onSelect(d.id)}
            aria-current={d.id === selectedId}
          >
            <List.Item.Meta
              title={d.name}
              description={scopeOptions.find((o) => o.value === d.scope_type)?.label ?? d.scope_type}
            />
            <StatusTag status={d.status} optionSet="POLICY_STATUS" />
          </List.Item>
        )}
      />
    </Card>
  );
}
