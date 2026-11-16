export function LoginAside() {
  return (
    <section className="login-aside" aria-label="产品介绍">
      <div className="login-aside__topline">
        <span className="login-brand-mark" aria-hidden="true">宜</span>
        <span>宜游轩</span>
      </div>
      <div className="login-aside__content">
        <p className="login-kicker">业务运营中枢</p>
        <h1>经营，<br /><em>进入高速模式。</em></h1>
        <p className="login-aside__copy">订单、资金、库存与利润，在一个工作台里实时同步。</p>
      </div>
      <div className="login-aside__footer">
        <span>订单</span><i /> <span>资金</span><i /> <span>经营</span>
      </div>
    </section>
  );
}
