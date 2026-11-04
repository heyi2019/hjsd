import { useState } from "react";
import { createCustomer } from "../../api";
import { DetailNav } from "../../components/Detail";
import { navigate } from "../../router";

/**
 * 新建客户。字段与桌面端一致的最小集：姓名必填，其余可后补。
 * 后端会对同名/同手机号返回 duplicate_candidates —— 必须把提示显式呈现出来，
 * 否则用户会重复建档，合并成本比补录高一个量级。
 */
export function CustomerFormPage() {
  const [displayName, setDisplayName] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [wechat, setWechat] = useState("");
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<number>(0);

  const submit = async () => {
    if (!displayName.trim()) {
      setError("请填写客户姓名");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createCustomer({
        display_name: displayName.trim(),
        contact_name: contactName.trim() || null,
        phone: phone.trim() || null,
        wechat: wechat.trim() || null,
        source: source.trim() || null,
        note: note.trim() || null,
      });
      const candidates = (result as { duplicate_candidates?: unknown[] }).duplicate_candidates;
      if (Array.isArray(candidates) && candidates.length > 0) {
        setDuplicates(candidates.length);
        // 有疑似重复时不直接跳转，留在本页让用户确认，避免「建完就走」造成重复档案。
        return;
      }
      navigate(`/customers/${result.customer.id}`, true);
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h5-page">
      <DetailNav title="新建客户" />

      <div className="h5-section">
        {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}
        {duplicates > 0 ? (
          <div className="h5-alert" role="status">
            已创建，但系统发现 {duplicates} 条疑似重复档案，请到桌面端合并确认。
          </div>
        ) : null}

        <div className="h5-login__card">
          <div className="h5-form">
            <label className="h5-field">
              <span>客户姓名（必填）</span>
              <input
                value={displayName}
                placeholder="用于列表展示的名称"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <label className="h5-field">
              <span>联系人</span>
              <input
                value={contactName}
                placeholder="与客户姓名不同时填写"
                onChange={(event) => setContactName(event.target.value)}
              />
            </label>
            <label className="h5-field">
              <span>手机号</span>
              <input
                inputMode="numeric"
                value={phone}
                placeholder="11 位手机号"
                onChange={(event) => setPhone(event.target.value)}
              />
            </label>
            <label className="h5-field">
              <span>微信</span>
              <input
                value={wechat}
                placeholder="微信号"
                onChange={(event) => setWechat(event.target.value)}
              />
            </label>
            <label className="h5-field">
              <span>来源</span>
              <input
                value={source}
                placeholder="如：老客介绍 / 群内成交"
                onChange={(event) => setSource(event.target.value)}
              />
            </label>
            <label className="h5-field">
              <span>备注</span>
              <input value={note} placeholder="选填" onChange={(event) => setNote(event.target.value)} />
            </label>
            <button type="button" className="h5-primary" disabled={busy} onClick={submit}>
              {busy ? "保存中…" : "保存客户"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
