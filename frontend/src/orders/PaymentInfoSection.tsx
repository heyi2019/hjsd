/** 通用付款信息区：回收、提号等需要付款资金记录的业务共用。 */
import { Input } from "antd";
import type { Pool } from "../shared/api/catalog";
import { Select } from "../shared/ui";
import { BusinessRegistrationGroup } from "../shared/ui";
import { CfgItem } from "./ConfigurableField";
import "./PaymentInfoSection.css";

export function PaymentInfoSection(props: {
  pools: Pool[];
}) {
  return (
    <BusinessRegistrationGroup className="payment-info-section payment-info-fields" title="资金流水">
      <CfgItem name="payment_pool_id" label="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}>
        <Select placeholder="请选择资金账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} />
      </CfgItem>
      <CfgItem className="payment-info-fields__note" name="payment_note" label="资金流水备注">
        <Input placeholder="可选填" />
      </CfgItem>
    </BusinessRegistrationGroup>
  );
}
