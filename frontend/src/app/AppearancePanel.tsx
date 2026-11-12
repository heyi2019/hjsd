/**
 * 外观设置：玻璃材质透明度（iOS 27 透明度滑桿口径）。
 * 单一系数驱动全站玻璃，实时预览，无需刷新。
 */
import { Card, Radio, Slider, Typography } from "antd";
import {
  GLASS_DEFAULT,
  GLASS_MAX,
  GLASS_MIN,
  GLASS_STEP,
  useGlass,
} from "../shared/state/glass";
import { useTheme } from "../shared/state/theme";

export function AppearancePanel() {
  const { alpha, setAlpha, reduced } = useGlass();
  const { mode, setMode } = useTheme();

  return (
    <div className="ui-stack">
      <Card className="glass" title="界面主题">
        <div role="radiogroup" aria-label="界面主题">
          <Radio.Group value={mode} onChange={(event) => setMode(event.target.value)}>
            <Radio value="light">浅色</Radio>
            <Radio value="system">跟随系统</Radio>
            <Radio value="dark">深色</Radio>
          </Radio.Group>
        </div>
      </Card>
      <Card className="glass" title="玻璃材质透明度">
        <div className="ui-stack">
          <Slider
            min={GLASS_MIN}
            max={GLASS_MAX}
            step={GLASS_STEP}
            value={alpha}
            onChange={setAlpha}
            aria-label="玻璃材质透明度"
            marks={{ [GLASS_MIN]: "清透", [GLASS_DEFAULT]: "默认", [GLASS_MAX]: "厚实" }}
          />
          {reduced ? (
            <Typography.Text type="warning">
              系统已开启「降低透明度」或「增强对比度」，玻璃材质当前强制为不透明实底，
              本滑桿暂不产生视觉变化。关闭系统偏好后自动恢复。
            </Typography.Text>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
