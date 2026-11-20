import { AppstoreOutlined, FileTextOutlined, WalletOutlined } from "@ant-design/icons";

export function LoginAside() {
  return (
    <section className="login-aside" aria-label="产品介绍">
      <div className="login-aside__topline">
        <span className="login-brand-mark" aria-hidden="true">宜</span>
        <span className="login-aside__brand">宜游轩 <small>ERP</small></span>
      </div>
      <div className="login-aside__content">
        <p className="login-kicker">宜游轩 · 业务工作台</p>
        <h1>让经营更清晰，<br /><em>让每一步更从容。</em></h1>
        <p className="login-aside__copy">从库存、订单到资金，让日常业务在一个工作台有序流转。</p>
        <div className="login-overview" aria-label="工作台功能">
          <div className="login-overview__heading"><span>一个工作台，连接日常业务</span><span>WORKSPACE</span></div>
          <div className="login-overview__items">
            <div><span className="login-overview__icon"><AppstoreOutlined /></span><strong>库存管理</strong><small>掌握在库情况</small></div>
            <div><span className="login-overview__icon"><FileTextOutlined /></span><strong>订单跟进</strong><small>记录业务进展</small></div>
            <div><span className="login-overview__icon"><WalletOutlined /></span><strong>资金明细</strong><small>查看收支流水</small></div>
          </div>
        </div>
      </div>
      <div className="login-aside__footer">
        <span>宜游轩 ERP</span><i /><span>让业务井然有序</span>
      </div>
    </section>
  );
}
