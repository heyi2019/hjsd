/**
 * 详情页共用的小件：顶栏返回、键值分组、金额行。
 *
 * 详情页在移动端不显示底栏（见 App.tsx 的 resolveScreen），因此必须自带返回：
 * iOS 用户没有硬件返回键，只能靠顶栏或手势，不给返回入口等于把人困住。
 */
import type { ReactNode } from "react";
import { goBack } from "../router";
import { ChevronLeftIcon } from "../icons";

export function DetailNav({ title }: { title: string }) {
  return (
    <header className="h5-navbar">
      <button type="button" className="h5-navbar__back" onClick={() => goBack()} aria-label="返回">
        <ChevronLeftIcon />
        返回
      </button>
      <span className="h5-navbar__title">{title}</span>
      <span className="h5-navbar__spacer" />
    </header>
  );
}

export function KeyValue({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  const visible = rows.filter((row) => row.value !== null && row.value !== undefined && row.value !== "");
  if (visible.length === 0) return null;
  return (
    <div className="h5-kv">
      {visible.map((row) => (
        <div key={row.label}>
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function DetailHead({
  glyph,
  tone,
  title,
  subtitle,
  right,
}: {
  glyph: string;
  tone: string;
  title: string;
  subtitle: string;
  right?: ReactNode;
}) {
  return (
    <div className="h5-detail-head">
      <span className={`h5-row__icon h5-row__icon--${tone}`} aria-hidden>{glyph}</span>
      <div className="h5-detail-head__main">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {right}
    </div>
  );
}
