import { Card, Descriptions, Typography } from "antd";

export function BusinessDictionaryPanel() {
  return (
    <Card className="glass" title="业务分类口径">
      <Typography.Paragraph type="secondary">
        活字段只承载客户辅助信息；库存和订单字段由固定业务模型管理，不允许通过活字段覆盖。
      </Typography.Paragraph>
      <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label="业务">
          自营：本方承担资金、库存和利润；分销：向供货方拿货或提号后销售，也可使用本方资金。
        </Descriptions.Item>
        <Descriptions.Item label="类型">
          回收：自营买入账号；提号：分销取得账号；代挂：受委托挂售账号，是否产生资金占用取决于是否垫付。
        </Descriptions.Item>
        <Descriptions.Item label="产品类型">
          游戏类型，是产品的分类，例如王者荣耀、原神。新建订单或账号中的“游戏类型”字段保存此信息；它不是某一个具体账号。
        </Descriptions.Item>
        <Descriptions.Item label="产品">
          具体的游戏账号，是可以进入库存、售卖或交付的产品实例，包含游戏账号、账号密码、渠道/区服等信息。
        </Descriptions.Item>
        <Descriptions.Item label="库存账号">
          产品进入库存后的管理对象；库存中心展示其业务归属、入库类型、产品类型和账号状态，并承接全款或分期付款售卖。
        </Descriptions.Item>
        <Descriptions.Item label="增值服务">
          分期：本方账号售出，买家分期支付售卖款，归自营售出，不单独产生业务编号。代分期：他人账号售出，本方提供代付或分期服务并收取服务收益，归分销业务，生成 DFQ 业务订单号。
        </Descriptions.Item>
        <Descriptions.Item label="分期（自营售出）">
          售出方是本方，账号归本方库存；售出金额属于本方销售收入。买家按期回款，收齐后完成交付；每笔回款都归集到原售出订单及其分期合约。
        </Descriptions.Item>
        <Descriptions.Item label="代分期（分销服务）">
          售出方和账号所有权属于客户/合作方，本方不把账号计入库存或销售收入；创建时生成 DFQ 业务订单号。本方仅代付剩余款项、跟进分期回收，并以服务费、佣金或约定返点确认收益。代付本金与回收款须分别记录，不能混作本方售出收入。
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}
