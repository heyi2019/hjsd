/** 业务统一下拉：收口弹层外观与动效，替代对裸 .ant-select-dropdown 的全局 !important 覆盖。
 *
 * 为什么要封装：
 *  - antd 弹层关闭依赖 rc-motion 在「离场动画」结束（animationend）后加 hidden 类。
 *    此前在根容器上用 `animation: ui-spring-in ... both !important` 钉死所有状态，
 *    关闭时动画名不变、浏览器不重播、rc-motion 收不到 animationend → 弹层永远不 hidden
 *    → 下拉关不掉（点开第二个时第一个仍残留展开，2026-10-13 复现）。
 *  - 本组件给弹层注入 classNames.popup.root="ui-select-pop"；Select.css 统一处理选项间距、选中态
 *    与极短淡入（无位移缩放，解决「下拉出现太久」），
 *    离场交还 antd 原生，关闭流程恢复正常。弹簧入场此前曾钉死根容器导致关不掉，
 *    故 Select 下拉不走弹簧、改极短淡入（2026-10-13 用户裁决 B）。
 *
 * 调用方零成本迁移：透传 antd Select 全部 props（含 options / allowClear / onChange 等），
 * 仅 React 18 下需把 ref 类型一并透传。 */
import { Select as AntdSelect } from "antd";
import type { SelectProps } from "antd";
import { forwardRef } from "react";
import "./Select.css";

type SelectRef = React.ElementRef<typeof AntdSelect>;

export const Select = forwardRef<SelectRef, SelectProps>((props, ref) => {
  const { popupClassName, classNames, virtual, ...restProps } = props;
  const mergedPopup = ["ui-select-pop", popupClassName].filter(Boolean).join(" ").trim();
  return (
    <AntdSelect
      {...restProps}
      // 关闭虚拟列表：antd 默认 virtual 只渲染可视区选项，导致无障碍辅助树只暴露前两项，
      // 屏幕阅读器/键盘无法触达其余选项（L270）。业务选项集规模小，全量渲染无性能负担；
      // 调用方仍可用 virtual 显式覆盖。
      virtual={virtual ?? false}
      ref={ref}
      classNames={{
        ...classNames,
        popup: {
          ...classNames?.popup,
          root: mergedPopup,
        },
      }}
    />
  );
});

Select.displayName = "Select";
