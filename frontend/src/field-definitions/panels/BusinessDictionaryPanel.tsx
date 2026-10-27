import { Card, Descriptions, Typography } from "antd";

/** 二级条目行：一级条目占多行，每行「加粗名称 + 说明」，不用卡片。 */
function EntryLine({ name, desc }: { name: string; desc: string }) {
  return (
    <div>
      <strong>{name}</strong>：{desc}
    </div>
  );
}

export function BusinessDictionaryPanel() {
  return (
    <Card className="glass" title="业务分类口径">
      <Typography.Paragraph type="secondary">
        业务字典定义系统记录什么；字段与表单配置决定这些信息在哪里、以何种方式录入。核心业务字段受固定模型保护，扩展字段只补充业务信息，不覆盖资金、订单或库存事实。
      </Typography.Paragraph>
      <Descriptions bordered size="small" column={1} labelStyle={{ width: 96 }}>
        <Descriptions.Item label="业务">
          <EntryLine name="自营" desc="本方承担资金、库存和利润。" />
          <EntryLine name="分销" desc="向供货方提号后销售或帮客户代售（代挂）游戏账号，提号可使用本方资金。" />
        </Descriptions.Item>
        <Descriptions.Item label="业务类型">
          <EntryLine name="回收" desc="自营买入账号。" />
          <EntryLine name="提号" desc="分销取得账号。" />
          <EntryLine name="代挂" desc="受委托挂售账号，付款和收款按实际发生登记。" />
        </Descriptions.Item>
        <Descriptions.Item label="产品">
          具体的游戏账号，是可以进入库存中心的产品实例，包含游戏账号、账号密码、渠道/区服等信息。
        </Descriptions.Item>
        <Descriptions.Item label="产品类型">
          游戏类型，是产品的分类，例如王者荣耀、原神。
        </Descriptions.Item>
        <Descriptions.Item label="库存账号">
          产品进入库存中心后的管理对象，记录账号的业务归属、业务类型、产品类型和账号状态，承接全款或分期付款售卖；代分期账号同样计入库存，业务类型留空，以增值服务「代分期」标识。
        </Descriptions.Item>
        <Descriptions.Item label="增值服务">
          <EntryLine
            name="分期（自营增值服务）"
            desc="本方账号售出，买家分期支付售卖款，归自营售出，不单独产生业务编号；售出金额属于本方销售收入，买家按期回款，收齐后完成交付，每笔回款都归集到原售出订单及其分期合约。"
          />
          <EntryLine
            name="代分期（分销增值服务）"
            desc="客户向本方借款，按合约分期还款；本方登记付款和收款。账号计入本方库存或销售收入，创建时生成代分期业务订单号；付款与收款须分别记录，服务费、佣金或约定返点按实际业务确认收益。"
          />
        </Descriptions.Item>
        <Descriptions.Item label="业务事件">
          <Typography.Paragraph type="secondary">
            每笔订单的生命周期由七类业务事件构成；返点等后续业务以这些事件是否已登记为判定依据。
          </Typography.Paragraph>
          <EntryLine
            name="采购入库"
            desc="把号收进来：回收单收客户的号、提号单提号时登记；代分期垫资买入也可登记（须先建垫资合约）；代挂不允许。买号返点以此为判定依据。"
          />
          <EntryLine
            name="卖出"
            desc="号出手：回收、提号、代挂订单成交卖出时登记；代分期不允许直接卖出（卖动作由收款体现）。卖号返点以此为判定依据。"
          />
          <EntryLine
            name="收款"
            desc="实际收到一笔钱：订单收款的凭证；代分期每收一期款登记一条。代分期卖号返点以此为判定依据。"
          />
          <EntryLine
            name="费用"
            desc="补记订单费用：订单过程中的额外支出（如解封费、手续费）；回收单须关联库存账号，代挂不允许。"
          />
          <EntryLine name="交付" desc="号交给买家：完成账号交接的动作。" />
          <EntryLine name="取消" desc="订单作废：取消未完成的订单。" />
          <EntryLine name="退款" desc="退回已收款：把收到的钱退回给付款方。" />
        </Descriptions.Item>
        <Descriptions.Item label="返点规则">
          <EntryLine
            name="买号返点"
            desc="回收、提号、代分期订单均可登记，须已登记采购入库（代分期为垫资买入）。"
          />
          <EntryLine
            name="卖号返点"
            desc="回收、提号、代挂、代分期订单均可登记；回收、提号、代挂须已登记卖出，代分期须已登记收款。"
          />
          <EntryLine
            name="结算与作废"
            desc="返点金额（基数）必填，费率不填按零计；可分多次到账结算，累计达到基数自动结清；从未结算的记录可作废，已结算的只能逐笔冲销。"
          />
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}
