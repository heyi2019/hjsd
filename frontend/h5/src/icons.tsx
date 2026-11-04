/**
 * 线性图标（24×24，stroke 走 currentColor）：Apple 风格里图标是「线条 + 圆角」，
 * emoji 会因为平台字体不同变得花哨且不可控，故一律用内联 SVG。
 */

type IconProps = { size?: number; filled?: boolean };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export function HomeIcon({ size = 25, filled = false }: IconProps) {
  return (
    <svg {...base(size)} fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"}>
      <path d="M3.6 10.4 12 3.6l8.4 6.8V20a.9.9 0 0 1-.9.9h-5v-6h-5v6h-5a.9.9 0 0 1-.9-.9z" />
    </svg>
  );
}

export function ListIcon({ size = 25, filled = false }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} />
      <path d="M7.5 9h9M7.5 12.5h9M7.5 16h5.5" stroke={filled ? "var(--h5-card)" : "currentColor"} />
    </svg>
  );
}

export function PersonIcon({ size = 25, filled = false }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="8.2" r="3.9" fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} />
      <path d="M4.6 20.2c.6-3.7 3.7-6.1 7.4-6.1s6.8 2.4 7.4 6.1" />
    </svg>
  );
}

export function WeChatIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.6}>
      <path d="M10 4.2c-3.6 0-6.5 2.3-6.5 5.2 0 1.6.9 3 2.3 4l-.5 2 2.2-1.1c.8.2 1.6.3 2.5.3" />
      <path d="M20.5 14.2c0-2.4-2.3-4.3-5.2-4.3s-5.2 1.9-5.2 4.3 2.3 4.3 5.2 4.3c.7 0 1.4-.1 2-.3l1.9 1-.4-1.7c1-.8 1.7-1.9 1.7-3.3z" />
      <circle cx="7.8" cy="8.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="13.8" cy="13.9" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="17.2" cy="13.9" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ChevronIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2}>
      <path d="M9 5.5 15.5 12 9 18.5" />
    </svg>
  );
}

export function SearchIcon({ size = 17 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2}>
      <circle cx="10.8" cy="10.8" r="6.4" />
      <path d="m15.6 15.6 4 4" />
    </svg>
  );
}

export function CustomersIcon({ size = 25, filled = false }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="9.4" cy="8.4" r="3.5" fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} />
      <path d="M2.8 19.6c.5-3.3 3.3-5.5 6.6-5.5s6.1 2.2 6.6 5.5" />
      <path d="M16.4 5.5a3.1 3.1 0 0 1 0 6M18 14.6c2 .7 3.4 2.5 3.7 5" />
    </svg>
  );
}

export function WalletIcon({ size = 25, filled = false }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect
        x="2.8"
        y="6.2"
        width="18.4"
        height="13"
        rx="3.4"
        fill={filled ? "currentColor" : "none"}
        stroke={filled ? "none" : "currentColor"}
      />
      <path
        d="M2.8 10.4h18.4"
        stroke={filled ? "var(--h5-card)" : "currentColor"}
      />
      <circle cx="17" cy="14.8" r="1.2" fill={filled ? "var(--h5-card)" : "currentColor"} stroke="none" />
    </svg>
  );
}

export function ChevronLeftIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2.2}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </svg>
  );
}
