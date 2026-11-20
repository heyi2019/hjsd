import { ArrowDownOutlined, ArrowUpOutlined } from "@ant-design/icons";
import { Button, Space, Typography } from "antd";
import "./TimeOrderControl.css";

export function TimeOrderControl({ descending, onChange, label = "时序" }: {
  descending: boolean;
  onChange: (descending: boolean) => void;
  label?: string;
}) {
  return <Space size={4}>
    <Typography.Text strong>{label}</Typography.Text>
    <Space.Compact className="ledger-sort-actions" aria-label={label}>
      <Button size="small" type="text" icon={<ArrowDownOutlined />} aria-label="最新在前" title="最新在前" aria-pressed={descending} onClick={() => onChange(true)} />
      <Button size="small" type="text" icon={<ArrowUpOutlined />} aria-label="最旧在前" title="最旧在前" aria-pressed={!descending} onClick={() => onChange(false)} />
    </Space.Compact>
  </Space>;
}
