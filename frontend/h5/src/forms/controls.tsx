/**
 * H5 表单控件：只做「iOS 观感 + 可控值」，不引入任何表单库。
 *
 * 设计取舍（与桌面端不同，但业务口径一致）：
 *  - 桌面端靠 antd 的 `required` 规则做即时校验；移动端键盘弹出会遮住半屏，
 *    即时红字会把输入区继续往下挤。这里改为**提交时统一校验**，
 *    错误定位到字段下方并用 `scrollIntoView` 把该字段带回可视区。
 *  - 下拉一律走底部选择面板（Sheet），不用原生 `<select>`：iOS Safari 的原生
 *    选择器会把页面顶起、样式不可控，且无法搜索。
 *  - 金额输入用 `inputMode="decimal"` 而非 `type="number"`：后者在 iOS 上出现
 *    步进器、且 `0.00` 这类值会被归一化成 `0`，与后端 DECIMAL(18,2) 对不上。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Sheet } from "../components/Sheet";
import { CheckIcon, ChevronIcon, SearchIcon } from "../icons";

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

/** 字段容器：标题 + 控件 + 说明 + 错误。 */
export function Field(props: {
  label?: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string | null;
  /** 右侧的补充说明（如「最后一期 1,200.00 元」）。 */
  aside?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className={`h5-field${props.error ? " h5-field--invalid" : ""}`} data-invalid={props.error ? "1" : undefined}>
      {props.label ? (
        <div className="h5-field__label">
          <label htmlFor={props.htmlFor}>
            {props.label}
            {props.required ? <span className="h5-field__required" aria-hidden="true">*</span> : null}
          </label>
          {props.aside ? <span className="h5-field__aside">{props.aside}</span> : null}
        </div>
      ) : null}
      {props.children}
      {props.error ? <p className="h5-field__error">{props.error}</p> : null}
      {props.hint ? <p className="h5-field__hint">{props.hint}</p> : null}
    </div>
  );
}

export function TextInput(props: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: "text" | "tel" | "password" | "email";
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "decimal" | "tel";
  id?: string;
  disabled?: boolean;
}) {
  return (
    <input
      id={props.id}
      className="h5-input"
      type={props.type ?? "text"}
      inputMode={props.inputMode}
      autoComplete={props.autoComplete}
      autoCapitalize="off"
      autoCorrect="off"
      placeholder={props.placeholder}
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

/** 金额输入：保留用户原始字符串（不转 number），提交时再交给后端 DECIMAL。 */
export function MoneyInput(props: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <div className="h5-money">
      <span aria-hidden="true">¥</span>
      <input
        id={props.id}
        className="h5-input h5-input--money"
        inputMode="decimal"
        autoComplete="off"
        placeholder={props.placeholder ?? "0.00"}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(sanitizeAmount(event.target.value))}
      />
    </div>
  );
}

/** 只允许数字与一个小数点，且最多两位小数（与后端 DECIMAL(18,2) 对齐）。 */
export function sanitizeAmount(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot === -1) return cleaned;
  const head = cleaned.slice(0, firstDot + 1);
  const tail = cleaned.slice(firstDot + 1).replace(/\./g, "").slice(0, 2);
  return head + tail;
}

export function NumberInput(props: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  id?: string;
}) {
  return (
    <input
      id={props.id}
      className="h5-input"
      inputMode="numeric"
      autoComplete="off"
      placeholder={props.placeholder}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value.replace(/[^\d]/g, ""))}
    />
  );
}

/** 原生日期选择：iOS 上会升出系统滚轮，比自绘日历可靠得多。 */
export function DateInput(props: {
  value: string;
  onChange: (next: string) => void;
  id?: string;
  max?: string;
  min?: string;
}) {
  return (
    <input
      id={props.id}
      className="h5-input"
      type="date"
      max={props.max}
      min={props.min}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

export function TextArea(props: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  id?: string;
}) {
  return (
    <textarea
      id={props.id}
      className="h5-textarea"
      rows={props.rows ?? 3}
      placeholder={props.placeholder}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

/**
 * 下拉选择：收起态是一行「标签 — 值 — 箭头」，点开底部面板。
 * `searchable` 为 true 时面板顶部出现搜索框（游戏类型、客户等长列表）。
 */
export function PickerField(props: {
  label?: string;
  required?: boolean;
  value: string | number | null | undefined;
  options: Option[];
  onChange: (next: string) => void;
  placeholder?: string;
  searchable?: boolean;
  allowClear?: boolean;
  hint?: ReactNode;
  error?: string | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const selected = props.options.find((option) => String(option.value) === String(props.value ?? ""));
  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    if (!query) return props.options;
    return props.options.filter((option) => option.label.toLowerCase().includes(query));
  }, [keyword, props.options]);

  return (
    <>
      <Field label={props.label} required={props.required} hint={props.hint} error={props.error}>
        <button
          type="button"
          className={`h5-picker${selected ? "" : " is-empty"}`}
          disabled={props.disabled}
          onClick={() => {
            setKeyword("");
            setOpen(true);
          }}
        >
          <span className="h5-picker__value">{selected ? selected.label : (props.placeholder ?? "请选择")}</span>
          <ChevronIcon size={16} />
        </button>
      </Field>

      <Sheet
        open={open}
        title={props.label ?? "请选择"}
        onClose={() => setOpen(false)}
        footer={
          props.allowClear ? (
            <button
              type="button"
              className="h5-ghost h5-ghost--full"
              onClick={() => {
                props.onChange("");
                setOpen(false);
              }}
            >
              清除选择
            </button>
          ) : null
        }
      >
        {props.searchable ? (
          <div className="h5-search h5-search--sheet">
            <SearchIcon size={16} />
            <input
              value={keyword}
              placeholder="搜索"
              autoFocus
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>
        ) : null}
        <div className="h5-optionlist">
          {filtered.length === 0 ? (
            <p className="h5-empty">没有匹配的选项</p>
          ) : (
            filtered.map((option) => {
              const active = String(option.value) === String(props.value ?? "");
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`h5-optionlist__item${active ? " is-active" : ""}`}
                  onClick={() => {
                    props.onChange(String(option.value));
                    setOpen(false);
                  }}
                >
                  <span>
                    {option.label}
                    {option.hint ? <em>{option.hint}</em> : null}
                  </span>
                  {active ? <CheckIcon size={18} /> : null}
                </button>
              );
            })
          )}
        </div>
      </Sheet>
    </>
  );
}

/** 少量互斥选项（2~5 个）用横排胶囊，比点开面板少一步。 */
export function ChipField(props: {
  label?: string;
  required?: boolean;
  value: string;
  options: Option[];
  onChange: (next: string) => void;
  hint?: ReactNode;
  error?: string | null;
}) {
  return (
    <Field label={props.label} required={props.required} hint={props.hint} error={props.error}>
      <div className="h5-chipgroup">
        {props.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`h5-chip${option.value === props.value ? " is-active" : ""}`}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

export function SwitchField(props: {
  label: string;
  hint?: ReactNode;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="h5-switchrow">
      <div className="h5-switchrow__main">
        <span>{props.label}</span>
        {props.hint ? <p>{props.hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={props.value}
        aria-label={props.label}
        className={`h5-switchrow__toggle${props.value ? " is-on" : ""}`}
        onClick={() => props.onChange(!props.value)}
      >
        <span />
      </button>
    </div>
  );
}

/** 分组卡片：标题 + 说明 + 字段。 */
export function FormSection(props: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  /** 卡片右上角的动作（如「增加一行」）。 */
  action?: ReactNode;
}) {
  return (
    <section className="h5-formsection">
      {props.title || props.action ? (
        <header className="h5-formsection__head">
          <div>
            {props.title ? <h2>{props.title}</h2> : null}
            {props.description ? <p>{props.description}</p> : null}
          </div>
          {props.action}
        </header>
      ) : null}
      <div className="h5-formsection__body">{props.children}</div>
    </section>
  );
}

/** 提交条：贴在安全区上方，键盘弹起时随视口一起上移（sticky 而非 fixed）。 */
export function SubmitBar(props: {
  label: string;
  busy?: boolean;
  disabled?: boolean;
  hint?: string | null;
  secondary?: { label: string; onClick: () => void };
  onClick: () => void;
}) {
  return (
    <div className="h5-submitbar">
      {props.hint ? <p className="h5-submitbar__hint">{props.hint}</p> : null}
      <div className="h5-submitbar__row">
        {props.secondary ? (
          <button type="button" className="h5-ghost" onClick={props.secondary.onClick} disabled={props.busy}>
            {props.secondary.label}
          </button>
        ) : null}
        <button
          type="button"
          className="h5-primary h5-primary--grow"
          disabled={props.busy || props.disabled}
          onClick={props.onClick}
        >
          {props.busy ? "提交中…" : props.label}
        </button>
      </div>
    </div>
  );
}

/** 表单级错误：提交失败时贴顶显示（字段级错误走 Field 的 error）。 */
export function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="h5-alert h5-alert--error" role="alert">
      {error}
    </div>
  );
}

/** 滚动到第一个校验失败的字段。移动端提交后键盘已收起，必须把错误字段带回视野。 */
export function revealFirstError(): void {
  window.setTimeout(() => {
    const target = document.querySelector<HTMLElement>('[data-invalid="1"]');
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 30);
}

/**
 * 表单页面外壳：顶栏（返回 + 标题）+ 内容 + 提交条。
 * 详情页与表单页共用同一套顶栏，避免出现两种返回手势。
 */
export function FormPage(props: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 顶栏右侧动作（如「删除」）。 */
  action?: ReactNode;
}) {
  return (
    <div className="h5-page">
      <header className="h5-navbar">
        <button type="button" className="h5-navbar__back" onClick={props.onBack}>
          <ChevronIcon size={16} className="h5-navbar__chevron" />
          返回
        </button>
        <div className="h5-navbar__title">
          {props.title}
          {props.subtitle ? <small>{props.subtitle}</small> : null}
        </div>
        <div className="h5-navbar__spacer">{props.action}</div>
      </header>
      <div className="h5-formbody">{props.children}</div>
      {props.footer}
    </div>
  );
}

/** 自动聚焦：表单页打开后把光标放到第一个输入框（新建场景省一次点击）。 */
export function useAutoFocus<T extends HTMLElement>(): { ref: RefObject<T | null> } {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => ref.current?.focus(), 260);
    return () => window.clearTimeout(timer);
  }, []);
  return { ref };
}
