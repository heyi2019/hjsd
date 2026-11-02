import { describe, expect, it } from "vitest";
import { dateValueFromEvent, dateValueProps } from "./DateField";

describe("DateField value mapping", () => {
  it("将接口日期字符串映射为日期控件值", () => {
    expect(dateValueProps("2026-11-02").value?.format("YYYY-MM-DD")).toBe("2026-11-02");
    expect(dateValueProps(undefined).value).toBeNull();
  });

  it("将日期控件值转换回接口需要的日期字符串", () => {
    expect(dateValueFromEvent({ format: () => "2026-11-02" } as never)).toBe("2026-11-02");
    expect(dateValueFromEvent(null)).toBeUndefined();
  });
});
