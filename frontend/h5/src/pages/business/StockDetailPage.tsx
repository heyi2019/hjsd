import { useEffect, useState } from "react";
import { fetchStock, type StockRow } from "../../api";
import { money, stockStatusLabel, stockStatusTone } from "../../labels";
import { DetailHead, DetailNav, KeyValue } from "../../components/Detail";

/** 账号密码在库里是明文（既定裁决，勿加密/脱敏），但手机常在他人视线内，
 *  默认折叠、点一下才显示，属于展示层的保护，不改变存储口径。 */
function Secret({ value }: { value: string | null | undefined }) {
  const [shown, setShown] = useState(false);
  if (!value) return <>—</>;
  return (
    <button type="button" className="h5-secret" onClick={() => setShown((prev) => !prev)}>
      {shown ? value : "••••••"}
      <span>{shown ? "隐藏" : "显示"}</span>
    </button>
  );
}

export function StockDetailPage({ stockId }: { stockId: number }) {
  const [stock, setStock] = useState<StockRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setStock(null);
    setError(null);
    void fetchStock(stockId)
      .then((data) => {
        if (alive) setStock(data);
      })
      .catch((issue: Error) => {
        if (alive) setError(issue.message);
      });
    return () => {
      alive = false;
    };
  }, [stockId]);

  return (
    <div className="h5-page">
      <DetailNav title="账号详情" />

      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}
      {!stock && !error ? <p className="h5-empty">加载中…</p> : null}

      {stock ? (
        <>
          <DetailHead
            glyph="库"
            tone={stockStatusTone(stock.status)}
            title={stock.stock_no ?? `#${stock.id}`}
            subtitle={`${stock.game_account ?? "—"}${stock.platform ? ` · ${stock.platform}` : ""}`}
            right={
              <span className={`h5-pill h5-pill--${stockStatusTone(stock.status)}`}>
                {stockStatusLabel(stock.status)}
              </span>
            }
          />

          <section className="h5-section">
            <div className="h5-section__head"><h2>账号资料</h2></div>
            <KeyValue
              rows={[
                { label: "游戏账号", value: stock.game_account },
                { label: "账号密码", value: <Secret value={stock.game_password} /> },
                { label: "营地账号", value: stock.camp_account },
                { label: "绑定手机", value: stock.bound_phone },
                { label: "游戏 / 区服", value: stock.game_type },
                { label: "渠道区服", value: stock.channel_region },
                { label: "来源单号", value: stock.source_order_no },
                { label: "备注", value: stock.note },
              ]}
            />
          </section>

          <section className="h5-section">
            <div className="h5-section__head"><h2>成本与库龄</h2></div>
            <KeyValue
              rows={[
                { label: "入库成本", value: `¥${money(stock.cost_amount)}` },
                { label: "采购日期", value: stock.buy_date },
                {
                  label: "在库天数",
                  value:
                    stock.inventory_age_days === null || stock.inventory_age_days === undefined
                      ? null
                      : `${stock.inventory_age_days} 天`,
                },
                {
                  label: "库龄档位",
                  value:
                    stock.inventory_age_level === "OVERDUE"
                      ? "超 30 天"
                      : stock.inventory_age_level === "WARNING"
                        ? "超 7 天"
                        : stock.inventory_age_level === "NORMAL"
                          ? "正常"
                          : null,
                },
              ]}
            />
          </section>
        </>
      ) : null}
    </div>
  );
}
