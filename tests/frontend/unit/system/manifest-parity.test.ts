/**
 * TESTING-06 前端测试文件集合、分层归属与区域归属必须与 tests/manifest.json 一致。
 *
 * 所有测试文件必须被执行层、结果记录与变更检测共同识别，避免空集合让断言失去意义。
 *
 * 本守卫把所有测试文件实际扫一遍，与 manifest 的期望数量、四层归属、区域分布逐一核对。
 * 路径一律折成「相对仓库根」的 posix 串再匹配。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fastTests, matchesAny, quickTests } from "../../../../frontend/scripts/test-layers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE = <repo>/tests/frontend/unit/system
const REPO = path.resolve(HERE, "../../../..");
const FRONTEND = path.join(REPO, "frontend");
const MANIFEST = path.join(REPO, "tests", "manifest.json");

const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const DEEP_RE = /\.deep\.test\.[cm]?[jt]sx?$/;
const REGIONS = ["system", "workbench", "business", "customer", "finance", "operations", "settings", "shared"];

/** 前端测试只有一个根：仓库根 tests/frontend/（包内 src/ 与 frontend/tests/ 已清空）。 */
const ROOTS = [path.join(REPO, "tests", "frontend")];

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
  regions: Record<string, string>;
  regionByCode: Record<string, string>;
  layers: Record<string, { root: string; expected: Record<string, unknown> }>;
};

const expected = manifest.layers.frontend.expected as {
  files: number;
  layers: Record<string, number>;
  cases: Record<string, number>;
  byArea: Record<string, Record<string, number>>;
};

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(abs);
    return TEST_RE.test(entry.name) ? [abs] : [];
  });
}

/** 绝对路径 → 相对仓库根的 posix 串（test-layers 的 glob 以此为准）。 */
function relToRepo(abs: string): string {
  return path.relative(REPO, abs).split(path.sep).join("/");
}

/** tests/frontend/<kind>/<区域>/x.test.ts → { kind, region } */
function placementOf(abs: string): { kind: string; region: string } | null {
  const parts = relToRepo(abs).split("/");
  if (parts[0] !== "tests" || parts[1] !== "frontend" || parts.length < 5) return null;
  return { kind: parts[2], region: parts[3] };
}

const ALL = ROOTS.flatMap(walk).sort();

describe("TESTING-06 前端测试文件与 manifest 一致", () => {
  it("manifest 三端齐全，区域表用全名且保留编号映射", () => {
    for (const layer of ["backend", "frontend", "e2e"]) {
      expect(manifest.layers[layer], `manifest 缺 ${layer} 层`).toBeTruthy();
      expect(manifest.layers[layer].root.startsWith("tests/")).toBe(true);
    }
    expect(Object.keys(manifest.regions)).toEqual(expect.arrayContaining([...REGIONS]));
    // 功能编号（A..F/SYS）仍用字母，映射必须覆盖，否则区域分布算不出来。
    for (const code of ["A", "B", "C", "D", "E", "F", "SYS"]) {
      expect(REGIONS).toContain(manifest.regionByCode[code]);
    }
  });

  it("扫描根非空（扫描写错时这里是第一道红灯）", () => {
    expect(ALL.length, "tests/frontend 扫不到测试文件：扫描根写错了").toBeGreaterThan(0);
  });

  it(`测试文件总数等于 manifest 的 ${expected.files}`, () => {
    const names = ALL.map(relToRepo);
    expect(
      ALL.length,
      `实际 ${ALL.length} 个，manifest 记 ${expected.files} 个；前几个：${names.slice(0, 8).join(", ")}`,
    ).toBe(expected.files);
  });

  it("每个文件都落在 <kind>/<区域>/ 两层之下（kind ∈ unit|module，区域必须是已登记名）", () => {
    const bad = ALL.filter((p) => {
      const at = placementOf(p);
      return !at || !["unit", "module"].includes(at.kind) || !REGIONS.includes(at.region);
    }).map(relToRepo);
    expect(bad, "落位不合规（多一层/少一层或区域名写错）").toEqual([]);
  });

  it("区域分布与 manifest 逐格一致", () => {
    const actual: Record<string, Record<string, number>> = { unit: {}, module: {} };
    for (const p of ALL) {
      const at = placementOf(p);
      if (!at) continue;
      actual[at.kind][at.region] = (actual[at.kind][at.region] ?? 0) + 1;
    }
    expect(actual).toEqual(expected.byArea);
  });

  it("四层并集覆盖全部文件，且各层数量与 manifest 一致（专治「既不在 fast 也不在 react」）", () => {
    const deep = ALL.filter((p) => DEEP_RE.test(p));
    const nonDeep = ALL.filter((p) => !DEEP_RE.test(p));
    const fast = nonDeep.filter((p) => matchesAny(relToRepo(p), fastTests));
    const quick = nonDeep.filter((p) => matchesAny(relToRepo(p), quickTests));
    const react = nonDeep.filter((p) => !fast.includes(p) && !quick.includes(p));

    const actual = { fast: fast.length, quick: quick.length, react: react.length, deep: deep.length };
    expect(actual).toEqual(expected.layers);

    const covered = new Set([...fast, ...quick, ...react, ...deep].map(relToRepo));
    const missing = ALL.map(relToRepo).filter((f) => !covered.has(f));
    expect(missing, `未归层文件：${missing.slice(0, 10).join(", ")}`).toEqual([]);
  });

  it("deep 用例独立成层，不得混回 react（混回会让日常反馈从 ~170s 反弹到 ~408s）", () => {
    const deep = ALL.filter((p) => DEEP_RE.test(p));
    expect(deep.length, "deep 文件数变化：先确认是新增/删除用例，再改 manifest").toBe(
      expected.layers.deep,
    );
    expect(deep.every((p) => DEEP_RE.test(path.basename(p)))).toBe(true);
  });

  it("包内不得残留测试文件（防「搬了一半」）", () => {
    const leftover = [
      ...walk(path.join(FRONTEND, "src")),
      ...walk(path.join(FRONTEND, "tests")),
    ].map(relToRepo);
    expect(leftover, `包内仍残留测试文件：${leftover.slice(0, 10).join(", ")}`).toEqual([]);
  });
});
