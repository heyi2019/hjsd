import { describe, expect, it } from "vitest";
import { runParallelJobs } from "../../../../frontend/scripts/test-full-sharded-scheduling.mjs";

describe("全量回归层调度", () => {
  it("fast 与 quick 同时启动，并保留各层完成结果", async () => {
    const events: string[] = [];
    const run = async (name: string, _args: string[], _timeout: number, options: { buffered?: boolean }) => {
      events.push(`${name}:start:${options.buffered ? "buffered" : "direct"}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`${name}:end`);
    };

    const failures = await runParallelJobs(
      [
        ["fast", ["fast"], 60_000],
        ["quick", ["quick"], 150_000],
      ],
      run,
    );

    expect(events.slice(0, 2)).toEqual(["fast:start:buffered", "quick:start:buffered"]);
    expect(events.slice(2)).toEqual(["fast:end", "quick:end"]);
    expect(failures).toEqual([]);
  });
});
