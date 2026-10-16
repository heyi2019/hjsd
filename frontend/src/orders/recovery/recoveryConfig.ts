export const INTERMEDIARY_PLATFORM_OPTIONS = ["盼之", "千寻", "白情", "螃蟹", "私下", "其他"]
  .map((value) => ({ value, label: value }));

export const INTERMEDIARY_TYPE_OPTIONS = [
  { value: "普中", label: "普中" },
  { value: "包赔", label: "包赔" },
];

export const COMPENSATION_TYPE_OPTIONS = [
  { value: "首保", label: "首保" },
  { value: "续保", label: "续保" },
];

export const CUSTOMER_SOURCE_OPTIONS = ["自营", "微博", "小红书", "闲鱼", "同行推荐", "其他"]
  .map((value) => ({ value, label: value }));

export const HAS_SECONDARY_OPTIONS = [
  { value: "有", label: "有" },
  { value: "无", label: "无" },
];

export function getRecoveryLayout(width: number) {
  return width <= 680 ? "single" : width < 1000 ? "double" : width < 1200 ? "three" : "four";
}
