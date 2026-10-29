import { Card, Descriptions, Typography } from "antd";
import type { ReactNode } from "react";
import "./BusinessDictionaryPanel.css";

/** 二级条目行：一级条目占多行，每行「加粗名称 + 说明」，不用卡片。 */
function EntryLine({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="business-dictionary__entry">
      <span className="business-dictionary__entry-name"><strong>{name}</strong>：</span>
      <span className="business-dictionary__entry-desc">{desc}</span>
    </div>
  );
}

function ActionLine({ category, action, desc, mergeCategory = true }: { category: string; action: string; desc: string; mergeCategory?: boolean }) {
  const className = [
    "business-dictionary__action-line",
    mergeCategory ? "business-dictionary__action-line--merged" : "",
    category ? "business-dictionary__action-line--category-start" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={className}>
      <span className={`business-dictionary__tertiary${category ? "" : " business-dictionary__tertiary--empty"}`}><strong>{category}</strong></span>
      <span className="business-dictionary__action-detail"><strong>{action}</strong>：{desc}</span>
    </div>
  );
}

function EntryGroup({ title, children, stacked = false }: { title: string; children: ReactNode; stacked?: boolean }) {
  return (
    <section className={stacked ? "business-dictionary__group business-dictionary__group--stacked" : "business-dictionary__group"}>
      <div className="business-dictionary__group-label"><Typography.Text strong>{title}</Typography.Text></div>
      <div className="business-dictionary__group-body">{children}</div>
    </section>
  );
}

export function BusinessDictionaryPanel() {
  return (
    <Card className="glass business-dictionary" title="业务分类口径">
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
        <Descriptions.Item label="业务动作">
          <Typography.Paragraph type="secondary">
            业务动作分为账号生命周期、资金动作和账务动作三层；账号动作描述账号从取得到交付的状态变化，资金动作按资金实际流入或流出归类，账务动作描述入账、结算和更正。退款、押金等按实际方向登记，审计动作只记录谁在什么时候操作，不等同于业务事实。
          </Typography.Paragraph>
          <div className="business-dictionary__action-table">
          <EntryGroup title="账号生命周期动作" stacked>
            <ActionLine category="创建订单" action="创建订单" desc="建立业务单据和参与方关系，并记录订单创建审计事件。" />
            <ActionLine category="买号入库" action="回收入库" desc="回收订单创建后，将客户账号纳入本方库存。" mergeCategory />
            <ActionLine category="" action="提号入库" desc="提号订单创建后，将同行取得的账号纳入库存。" mergeCategory />
            <ActionLine category="" action="代挂入库" desc="代挂订单创建后，将受托账号纳入代挂库存。" mergeCategory />
            <ActionLine category="" action="代分期入库" desc="代分期订单创建后，将对应账号纳入分期业务库存。" mergeCategory />
            <ActionLine category="买号交付" action="账号交付" desc="采购方把账号交给本方；按实际记录换绑手机号、手机号绑定人、交易平台或中介信息，并记录交付登记审计事件。" />
            <ActionLine category="账号运营" action="寄售上架" desc="买号交付后，将代挂账号登记到指定寄售平台，记录实际上架时间与平台信息；不改变账号库存状态。" />
            <ActionLine category="" action="寄售下架" desc="只取消指定寄售平台的上架记录；账号仍保留在 ERP 库存，不改变库存状态。" mergeCategory />
            <ActionLine category="" action="账号描述维护" desc="维护库存账号的等级、资源、限制等说明，不改变账号业务状态或资金事实。" mergeCategory />
            <ActionLine category="" action="账号图片维护" desc="维护库存账号图片资料，不改变账号业务状态或资金事实。" mergeCategory />
            <ActionLine category="卖号出库" action="全款售出出库" desc="全款售出后直接完成售出出库。" />
            <ActionLine category="" action="自营分期售出" desc="本方账号分期售出，建立自营分期合约，账号进入“分期中”。" />
            <ActionLine category="" action="分销分期建单" desc="分销分期建立业务订单和分期合约，后续按收款计划完成销售闭环。" />
            <ActionLine category="" action="代挂账号售出" desc="受托代挂账号成交后登记售出，按实际业务完成后续交付，并记录售出过账审计事件。" />
            <ActionLine category="卖号交付" action="账号交付" desc="售出完成后登记账号交接；全款、分期结清和代挂售出统一记录，换绑手机号及手机号绑定人作为交付字段。" />
            <ActionLine category="取消订单" action="库存取消交易" desc="适用于回收取消、提号取消、代挂取消（系统下架）：回收对应资金并冲销入库买入流水；代挂还会同步取消寄售平台上架记录，账号退出库存中心。" />
            <ActionLine category="" action="售出取消交易" desc="适用于回收、提号、代分期、代挂四类售出订单：退回售出款项并冲销售出流水，取消后账号回到库存中心，保留订单审计轨迹。" mergeCategory />
            <ActionLine category="" action="分期取消交易" desc="适用于代分期取消：终止分期合约，按已收款原路退款并完成对应订单的取消闭环。" mergeCategory />
          </EntryGroup>
          <EntryGroup title="资金动作">
            <ActionLine category="收入" action="售出收款" desc="登记全款售出或售出订单的实际资金流入。" />
            <ActionLine category="" action="分期收款" desc="登记分期计划收款，并将每期收款归集到原售出订单及其分期合约。" />
            <ActionLine category="" action="返点到账" desc="登记买号或卖号返点实际到账的收入；手续费另记支出。" />
            <ActionLine category="" action="退款收入" desc="登记从供货方、平台或其他付款方实际收到的退款。" />
            <ActionLine category="支出" action="买号付款" desc="登记入库采购支出。" />
            <ActionLine category="" action="附加费用" desc="登记平台费、中介费等附加费用。" />
            <ActionLine category="" action="退款支出" desc="登记退给客户或其他收款方的退款。" />
            <ActionLine category="资金划转" action="资金账户间划转" desc="资金在本方资金账户之间转移，不代表收入或支出。" />
            <ActionLine category="押金管理" action="押金占用" desc="记录押金或保证金被占用。" />
            <ActionLine category="" action="押金释放" desc="释放押金；押金释放不等同于退款。" />
            <ActionLine category="" action="押金损失" desc="确认押金转为损失。" />
          </EntryGroup>
          <EntryGroup title="账务动作">
            <ActionLine category="过账" action="业务事实过账" desc="将已确认的业务事实登记为订单事件或资金流水，包括买号付款、售出收款、分期收款、费用和退款。" />
            <ActionLine category="分期结算" action="按期收款结算" desc="按分期计划登记收款、更新已收金额，并在全部结清后进入可交付状态。" />
            <ActionLine category="返点结算" action="分次到账结算" desc="将登记的返点按实际到账分次结算，累计达到基数后完成结清。" />
            <ActionLine category="对账与核销" action="业务与资金匹配" desc="将业务记录、资金流水和外部账单进行匹配并标记核销。" />
            <ActionLine category="冲销" action="业务事实冲销" desc="对已经登记的业务或资金事实做反向更正，并记录冲销审计事件；不等同于取消订单。" />
            <ActionLine category="作废" action="未生效记录作废" desc="对尚未发生结算或业务事实的记录终止其有效性；已结算事实应使用冲销，不直接作废。" />
          </EntryGroup>
          </div>
        </Descriptions.Item>
        <Descriptions.Item label="返点规则">
          <EntryLine
            name="买号返点"
            desc="回收、提号、代分期订单创建后均可登记；入库事件仅用于记录业务流水，不作为返点资格门槛。"
          />
          <EntryLine
            name="卖号返点"
            desc="回收、提号、代挂、代分期订单创建后均可登记；卖出或收款事件仅用于记录业务流水，不作为返点资格门槛。"
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
