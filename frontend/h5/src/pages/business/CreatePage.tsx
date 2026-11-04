/**
 * 建单入口页：底栏第二格，点进来只做一件事——选业务类型。
 *
 * 为什么不把三种建单表单平铺在这一页：HS 与 TH/DG 的字段集差别很大（前者要卖方、
 * 回收价与资金账户，后者要同行/寄售方与售价），同屏堆三套字段必然误填。这里只做
 * 「选类型」，选定后进入对应表单，返回时回到本页——与 iOS 的「新建」选择器一致。
 *
 * 权限：无 `order.create` 的角色（如财务、查看人）看到的是说明文字而不是三个
 * 必 403 的入口。
 */
import type { SessionUser } from "../../api";
import { ROLE_LABEL } from "../../labels";
import { can } from "../../perm";
import { navigate } from "../../router";

const KINDS = [
  {
    key: "HS",
    glyph: "回",
    tone: "blue",
    title: "回收（自营）",
    summary: "从卖方手上收号，进库存后再卖",
    points: ["登记卖方与账号资料", "回收价进本金", "入库后可售出"],
  },
  {
    key: "TH",
    glyph: "提",
    tone: "purple",
    title: "提号",
    summary: "向同行提号，通常当天转手",
    points: ["供货方为同行", "登记进货价", "直接关联售出"],
  },
  {
    key: "DG",
    glyph: "挂",
    tone: "orange",
    title: "代挂",
    summary: "替客户挂单代卖，零本金",
    points: ["寄售方为号主", "无买入价", "售出只记利润"],
  },
] as const;

export function CreatePage({ user }: { user: SessionUser }) {
  const allowed = can(user, "order.create");

  return (
    <div className="h5-page">
      <header className="h5-pagehead">
        <h1>建单</h1>
        <p>选择业务类型开始录入</p>
      </header>

      {!allowed ? (
        <p className="h5-empty">
          当前角色（{ROLE_LABEL[user.role?.toLowerCase()] ?? user.role}）没有建单权限，请联系管理员。
        </p>
      ) : (
        <ul className="h5-kindlist">
          {KINDS.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className="h5-kindcard"
                onClick={() => navigate(`/orders/new/${item.key}`)}
              >
                <span className={`h5-row__icon h5-row__icon--${item.tone}`} aria-hidden>
                  {item.glyph}
                </span>
                <span className="h5-kindcard__main">
                  <span className="h5-kindcard__title">
                    {item.title}
                    <em>{item.key}</em>
                  </span>
                  <span className="h5-kindcard__summary">{item.summary}</span>
                  <span className="h5-kindcard__points">
                    {item.points.map((point) => (
                      <span key={point}>{point}</span>
                    ))}
                  </span>
                </span>
                <span className="h5-kindcard__go" aria-hidden>›</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="h5-footnote">
        建单会自动生成订单号并写入审计；金额与账号资料以表单字段配置为准，管理员可随时调整。
      </p>
    </div>
  );
}
