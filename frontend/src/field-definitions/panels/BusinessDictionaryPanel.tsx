import { Card, Descriptions, Input, Space, Typography } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { optionSetsApi } from "../../shared/api/catalog";
import { useSession } from "../../shared/state/session";
import { appMessage } from "../../shared/ui/appFeedback";
import { PermissionButton } from "../../shared/ui";
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

function ActionLine({ category, action, desc, mergeCategory = true, categoryDesc }: { category: string; action: string; desc: string; mergeCategory?: boolean; categoryDesc?: string }) {
  const className = [
    "business-dictionary__action-line",
    mergeCategory ? "business-dictionary__action-line--merged" : "",
    category ? "business-dictionary__action-line--category-start" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={className}>
      <span className={`business-dictionary__tertiary${category ? "" : " business-dictionary__tertiary--empty"}`}>
        {category ? (
          <>
            <strong className="business-dictionary__category-name">{category}</strong>
            {categoryDesc ? <span className="business-dictionary__category-desc">{categoryDesc}</span> : null}
          </>
        ) : null}
      </span>
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

const dictionarySections = [
  { id: "business-dictionary-business", label: "业务" },
  { id: "business-dictionary-product", label: "产品" },
  { id: "business-dictionary-actions", label: "业务动作" },
  { id: "business-dictionary-states", label: "状态机" },
  { id: "business-dictionary-profit", label: "分润规则" },
  { id: "business-dictionary-cancel", label: "取消模型" },
  { id: "business-dictionary-stock", label: "入库规则" },
];

export function BusinessDictionaryPanel() {
  const { can } = useSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [remoteExists, setRemoteExists] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    void Promise.resolve(optionSetsApi.get("BUSINESS_DICTIONARY")).then((item) => {
      if (!mounted || !item) return;
      setRemoteExists(true);
      if (item.description?.trim()) setSavedContent(item.description);
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  const startEditing = () => {
    setDraft(savedContent ?? contentRef.current?.textContent?.trim() ?? "");
    setEditing(true);
  };

  const save = async () => {
    const description = draft.trim();
    if (!description) {
      appMessage.error("业务字典内容不能为空");
      return;
    }
    const payload = { label: "业务字典", group: "OPS", editable: true, options: [], description };
    try {
      if (remoteExists) await optionSetsApi.update("BUSINESS_DICTIONARY", payload);
      else await optionSetsApi.create({ code: "BUSINESS_DICTIONARY", ...payload });
      setRemoteExists(true);
      setSavedContent(description);
      setEditing(false);
      appMessage.success("业务字典已保存，所有用户可见");
    } catch (error) {
      appMessage.error(`业务字典保存失败：${String(error)}`);
    }
  };

  const actions = editing ? (
    <Space>
      <PermissionButton permission="option-set.manage" onClick={() => setEditing(false)}>返回</PermissionButton>
      <PermissionButton permission="option-set.manage" type="primary" onClick={() => void save()}>保存</PermissionButton>
    </Space>
  ) : can("option-set.manage") ? (
    <PermissionButton permission="option-set.manage" onClick={startEditing}>编辑</PermissionButton>
  ) : null;

  return (
    <Card className="glass business-dictionary" title="业务分类口径" extra={actions}>
      {editing ? <Input.TextArea aria-label="业务字典内容" value={draft} onChange={(event) => setDraft(event.target.value)} autoSize={{ minRows: 18 }} /> : null}
      {!editing && savedContent ? <Typography.Paragraph className="business-dictionary__saved-content">{savedContent}</Typography.Paragraph> : null}
      {!editing && !savedContent ? <div ref={contentRef}>
      <nav className="business-dictionary__toc" aria-label="业务字典目录">
        {dictionarySections.map((section) => (
          <a key={section.id} href={`#${section.id}`} aria-label={section.label} data-label={section.label} />
        ))}
      </nav>
      <Descriptions bordered size="small" column={1} labelStyle={{ width: 96 }}>
        <Descriptions.Item label={<span id="business-dictionary-business">业务</span>}>
          <EntryLine name="自营" desc="本方承担资金、库存和利润。" />
          <EntryLine name="分销" desc="向合作伙伴提号后销售或帮客户代售（代挂）游戏账号，提号可使用本方资金。" />
        </Descriptions.Item>
        <Descriptions.Item label="业务类型">
          <EntryLine name="回收" desc="自营买入账号。" />
          <EntryLine name="提号" desc="分销取得账号。" />
          <EntryLine name="代挂" desc="受委托挂售账号，付款和收款按实际发生登记。" />
        </Descriptions.Item>
        <Descriptions.Item label={<span id="business-dictionary-product">产品</span>}>
          具体的游戏账号，是可以进入库存中心的产品实例，包含游戏账号、账号密码、渠道/区服等信息。
        </Descriptions.Item>
        <Descriptions.Item label="产品类型">
          游戏类型，是产品的分类，例如王者荣耀、原神。
        </Descriptions.Item>
        <Descriptions.Item label="增值服务">
          <EntryLine
            name="分期服务"
            desc="本方账号售出后，买家分期支付售卖款。账号售出后建立自营分期合约，按期登记买家回款；收齐后完成账号交付，每笔回款归集到原售出订单及其分期合约。"
          />
        </Descriptions.Item>
        <Descriptions.Item label={<span id="business-dictionary-actions">业务动作</span>}>
          <Typography.Paragraph type="secondary">
            业务动作分为账号流转、资金动作和账务动作三层；账号流转描述账号从取得到交付的状态变化，资金动作按资金实际流入或流出归类，账务动作描述入账、结算和更正。退款、押金等按实际方向登记，审计动作只记录谁在什么时候操作，不等同于业务事实。
          </Typography.Paragraph>
          <div className="business-dictionary__action-table">
          <EntryGroup title="账号流转" stacked>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>买号入库</strong></span>
              <span className="business-dictionary__action-detail">回收、提号、代挂的账号创建订单后进库存中心。</span>
            </div>
            <ActionLine category="买号交付" action="账号交付" desc="采购方把账号交给本方；按实际记录换绑手机号、手机号绑定人、交易平台或中介信息，并记录交付登记审计事件。" />
            <ActionLine category="账号运营" action="平台上架" desc="库存中心账号可到平台寄售，记录实际上架时间与平台信息；不改变账号库存状态。" />
            <ActionLine category="" action="平台下架" desc="记录实际下架时间与平台信息；不改变账号库存状态。" mergeCategory />
            <ActionLine category="" action="系统下架" desc="特指代挂订单，直接下架本系统，库存状态改为出库。" mergeCategory />
            <ActionLine category="" action="描述" desc="描述库存账号的等级、资源、限制等说明，不改变账号业务状态或资金事实。" mergeCategory />
            <ActionLine category="" action="作图" desc="作库存账号图片资料，不改变账号业务状态或资金事实。" mergeCategory />
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>卖号出库</strong></span>
              <span className="business-dictionary__action-detail">账号售卖，库存状态改为出库。</span>
            </div>
            <ActionLine category="卖号交付" action="账号交付" desc="售出完成后登记账号交接；全款、分期结清和代挂售出统一记录，换绑手机号及手机号绑定人作为交付字段。" />
          </EntryGroup>
          <EntryGroup title="资金动作">
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>收入</strong></span>
              <span className="business-dictionary__action-detail">本方实际收到的资金记录。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>支出</strong></span>
              <span className="business-dictionary__action-detail">本方实际付出的资金记录。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>资金划转</strong></span>
              <span className="business-dictionary__action-detail">本方账户之间的资金调拨，不产生收入或支出。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>押金管理</strong></span>
              <span className="business-dictionary__action-detail">押金的收取、释放与损失处理。</span>
            </div>
          </EntryGroup>
          <EntryGroup title="账务动作">
            <ActionLine category="过账" action="业务事实过账" desc="将已确认的业务事实登记为订单事件或资金流水。" />
            <ActionLine category="分期结算" action="按期收款结算" desc="按分期计划登记收款、更新已收金额，并在全部结清后进入可交付状态。" />
            <ActionLine category="对账与核销" action="业务与资金匹配" desc="将业务记录、资金流水和外部账单进行匹配并标记核销。" />
            <ActionLine category="冲销" action="业务事实冲销" desc="对已经登记的业务或资金事实做反向更正，并记录冲销审计事件；不等同于取消或终止操作。" />
          </EntryGroup>
          </div>
        </Descriptions.Item>
        <Descriptions.Item label={<span id="business-dictionary-states">状态机</span>}>
          <Typography.Paragraph type="secondary">
            状态机描述业务对象的生命周期，状态只能通过领域动作流转并由后端受控校验。订单、账号、分期为受控状态机（对应后端核心状态机模块的转移表）；库存状态为业务概念描述，无独立转移表。
          </Typography.Paragraph>
          <div className="business-dictionary__action-table">
          <EntryGroup title="订单流程（内部）">
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>订单处理中</strong></span>
              <span className="business-dictionary__action-detail">订单创建后进入内部处理流程；台账以账号库存状态为主，售出或交付后进入完成，取消后终止。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>分期还款中</strong></span>
              <span className="business-dictionary__action-detail">售出后建立分期合约进入；按期收款，全部结清到已完成，或已取消。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>已完成</strong></span>
              <span className="business-dictionary__action-detail">业务与资金结清并交付；受控冲销可回退订单处理中，或到已取消。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>订单已取消</strong></span>
              <span className="business-dictionary__action-detail">终态，不得再产生新事件；已发生资金事实走冲销或退款流程。</span>
            </div>
          </EntryGroup>
          <EntryGroup title="账号状态机">
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>在库</strong></span>
              <span className="business-dictionary__action-detail">账号买入后进入库存中心；未售出前保持在库，售出后转为已售，取消后到终态。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>已售</strong></span>
              <span className="business-dictionary__action-detail">已售出或赊购；回收、取消入库、取消售出回待售，赊购保持，取消售出并终结或取消到终态。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>账号已取消</strong></span>
              <span className="business-dictionary__action-detail">终态。</span>
            </div>
          </EntryGroup>
          <EntryGroup title="分期状态机">
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>待启还</strong></span>
              <span className="business-dictionary__action-detail">合约创建、首付未确认；收款→还款中，标逾期→逾期，结清→已结清，取消→已取消。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>还款中</strong></span>
              <span className="business-dictionary__action-detail">已有应收计划；收款保持，标逾期→逾期，结清→已结清，违约处置→已违约，取消→已取消。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>逾期</strong></span>
              <span className="business-dictionary__action-detail">到期未足额；收款保持，结清→已结清，违约处置→已违约，结案→已结案，取消→已取消。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>已结清</strong></span>
              <span className="business-dictionary__action-detail">应收收齐或受控减免；选交付方式并交付→已交付，取消→已取消。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>已交付</strong></span>
              <span className="business-dictionary__action-detail">终态（交付不产生现金流）。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>已违约</strong></span>
              <span className="business-dictionary__action-detail">授权违约处置；收款保持，结案→已结案。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>已结案</strong></span>
              <span className="business-dictionary__action-detail">终态。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>分期已取消</strong></span>
              <span className="business-dictionary__action-detail">终态。</span>
            </div>
          </EntryGroup>
          <EntryGroup title="库存状态">
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>入库</strong></span>
              <span className="business-dictionary__action-detail">订单创建成功即进入库存中心，包含回收、提号、代挂，状态为在库。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>在库</strong></span>
              <span className="business-dictionary__action-detail">库存中心可用账号，可上架寄售（平台上架不改变库存状态）。</span>
            </div>
            <div className="business-dictionary__action-line business-dictionary__action-line--category-start">
              <span className="business-dictionary__tertiary"><strong>出库</strong></span>
              <span className="business-dictionary__action-detail">账号售出完成或系统出库（代挂下架）后离开库存中心，状态变为出库。</span>
            </div>
          </EntryGroup>
          </div>
        </Descriptions.Item>
        <Descriptions.Item label="返点规则">
          <EntryLine
            name="买号返点"
            desc="买号结束后的返点。"
          />
          <EntryLine
            name="卖号返点"
            desc="卖号的返点。"
          />
        </Descriptions.Item>
        <Descriptions.Item label={<span id="business-dictionary-profit">分润规则</span>}>
          <EntryLine
            name="分润"
            desc="订单利润分润：按参与方分配订单利润，支持按比例或按金额两种口径。"
          />
        </Descriptions.Item>
        <Descriptions.Item label={<span id="business-dictionary-cancel">取消模型</span>}>
          <EntryLine
            name="取消原则"
            desc="取消不删除已登记记录；对已有资金流水建立反向流水，并记录取消原因、实际登录操作人和操作时间。"
          />
          <EntryLine
            name="回收/提号未售出"
            desc="建单入库时已支出买入款；取消时登记退回金额和收款钱包，资金回到公司，账号退出库存。"
          />
          <EntryLine
            name="代挂未售出"
            desc="未发生本方买入支出；取消时只记录取消原因，不产生资金流水。"
          />
          <EntryLine
            name="已售出"
            desc="人工确认售出即代表已收款；取消时冲销售出流水，登记退款金额和付款钱包，普通账号回库存，提号账号结束。"
          />
          <EntryLine
            name="全额与部分"
            desc="取消用于全额反向处理并结束该笔交易；部分退钱走退款流程，订单仍保持已售出。"
          />
        </Descriptions.Item>
        <Descriptions.Item label={<span id="business-dictionary-stock">入库规则</span>}>
          <EntryLine name="首次入库" desc="回收、提号、代挂订单创建成功后，账号进入库存中心并按在库状态管理。" />
          <EntryLine name="未售出重复账号" desc="按游戏类型 + 游戏账号精确匹配；只要历史账号仍未售出，就禁止重复入库，不能通过确认强行建单。" />
          <EntryLine name="已售出账号回流" desc="历史账号已售出后，重复建单视为账号回流；经复购确认后允许重新进入库存。" />
          <EntryLine name="取消记录" desc="已取消账号不参与重复入库校验。" />
        </Descriptions.Item>
      </Descriptions>
      </div> : null}
    </Card>
  );
}
