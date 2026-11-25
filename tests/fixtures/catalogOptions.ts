import type { OptionItem } from "@/shared/api/types/common";

export const customerSourceOptions: OptionItem[] = [
  { value: "自营", label: "自营" },
  { value: "微博", label: "微博" },
  { value: "小红书", label: "小红书" },
  { value: "闲鱼", label: "闲鱼" },
  { value: "同行推荐", label: "同行推荐" },
  { value: "其他", label: "其他", behavior: "OTHER" },
];

export const intermediaryPlatformOptions: OptionItem[] = [
  { value: "盼之", label: "盼之" },
  { value: "千寻", label: "千寻" },
  { value: "白情", label: "白情" },
  { value: "螃蟹", label: "螃蟹" },
  { value: "私下", label: "私下" },
  { value: "其他", label: "其他", behavior: "OTHER" },
];
