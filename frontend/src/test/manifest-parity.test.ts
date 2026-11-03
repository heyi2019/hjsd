/**
 * TESTING-06 前端测试文件集合与分层归属必须与 tests/manifest.json 一致。
 *
 * 背景：这个仓库搬过三次测试目录，每次都有东西「不报错地消失」——
 *   - `test-full-sharded.mjs` 原来只扫 `src/`，迁出的文件「既不在 fast 也不在 react」，
 *     分层统计依然自洽，但它们再也不会被 test:full 跑到；
 *   - `record_frontend_results._rel_key` 用 `relative_to(frontend)`，搬出包外直接
 *     `return None`，记录被静默丢弃；
 *   - `test-changed.mjs` 只认 `frontend/` 前缀，`tests/` 变更被过滤后打印「未发现前端变更」。
 *
 * 共同点：失败表现是「结果为空」，而空集合上的断言恒真。
 *
 * 本守卫把所有测试文件实际扫一遍，与 manifest 的期望数量、四层归属逐一核对。
 * 路径一律折成「相对 frontend 包」的 posix 串再匹配，故搬迁前后都成立。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fastTests, matchesAny, quickTests } from "../../scripts/test-layers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../..");
const REPO = path.resolve(FRONTEND, "..");
const MANIFEST = path.join(REPO, "tests", "manifest.json");

const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const DEEP_RE = /\.deep\.test\.[cm]?[jt]sx?$/;

/** 前端测试可能存在三个根：包内 src/、包内 tests/、仓库根 tests/frontend/。 */
const ROOTS = [
  path.join(FRONTEND, "src"),
  path.join(FRONTEND, "tests"),
  path.join(REPO, "tests", "frontend"),
];

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
  regions: Record<string, string>;
  layers: Record<string, { root: string; expected: Record<string, unknown> }>;
};

const expected = manifest.layers.frontend.expected as {
  files: number;
  layers: Record<string, number>;
  cases: Record<string, number>;
  byArea: Record<string, number>;
};

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(abs);
    return TEST_RE.test(entry.name) ? [abs] : [];
  });
}

/** 绝对路径 → 相对 frontend 包的 posix 串（test-layers 的 glob 以此为准）。 */
function relToFrontend(abs: string): string {
  return path.relative(FRONTEND, abs).split(path.sep).join("/");
}

const ALL = ROOTS.flatMap(walk).sort();

describe("TESTING-06 前端测试文件与 manifest 一致", () => {
  it("manifest 三端齐全且区域表含 shared 与 SYS", () => {
    for (const layer of ["backend", "frontend", "e2e"]) {
      expect(manifest.layers[layer], `manifest 缺 ${layer} 层`).toBeTruthy();
      expect(manifest.layers[layer].root.startsWith("tests/")).toBe(true);
    }
    expect(Object.keys(manifest.regions)).toEqual(
      expect.arrayContaining(["A", "B", "C", "D", "E", "F", "SYS", "shared"]),
    );
  });

  it("扫描根非空（扫描写错时这里是第一道红灯）", () => {
    expect(ALL.length, "三个根都扫不到测试文件：扫描根写错了").toBeGreaterThan(0);
  });

  it(`测试文件总数等于 manifest 的 ${expected.files}`, () => {
    const names = ALL.map((p) => relToFrontend(p));
    expect(
      ALL.length,
      `实际 ${ALL.length} 个，manifest 记 ${expected.files} 个；多出/缺少的前几个：${names.slice(0, 8).join(", ")}`,
    ).toBe(expected.files);
  });

  it("四层并集覆盖全部文件，且各层数量与 manifest 一致（专治「既不在 fast 也不在 react」）", () => {
    const deep = ALL.filter((p) => DEEP_RE.test(p));
    const nonDeep = ALL.filter((p) => !DEEP_RE.test(p));
    const fast = nonDeep.filter((p) => matchesAny(relToFrontend(p), fastTests));
    const quick = nonDeep.filter((p) => matchesAny(relToFrontend(p), quickTests));
    const react = nonDeep.filter(
      (p) => !fast.includes(p) && !quick.includes(p),
    );

    const actual = { fast: fast.length, quick: quick.length, react: react.length, deep: deep.length };
    expect(actual).toEqual(expected.layers);

    const covered = new Set([...fast, ...quick, ...react, ...deep].map(relToFrontend));
    const missing = ALL.map(relToFrontend).filter((f) => !covered.has(f));
    expect(missing, `未归层文件：${missing.slice(0, 10).join(", ")}`).toEqual([]);
  });

  it("deep 用例独立成层，不得混回 react（混回会让日常反馈从 ~170s 反弹到 ~408s）", () => {
    const deep = ALL.filter((p) => DEEP_RE.test(p));
    expect(deep.length, "deep 文件数变化：先确认是新增/删除用例，再改 manifest").toBe(
      expected.layers.deep,
    );
    // react 层必须靠 exclude 把 deep 排除掉，一旦 exclude 写错，deep 会双跑。
    expect(deep.every((p) => DEEP_RE.test(path.basename(p)))).toBe(true);
  });

  it("搬迁完成后，包内两个根不得再残留测试文件（防「搬了一半」）", () => {
    const rootTests = path.join(REPO, "tests", "frontend");
    const migrated = existsSync(rootTests) && walk(rootTests).length > 0;
    if (!migrated) return; // 搬迁前：包内就是家

    const leftover = [
      ...walk(path.join(FRONTEND, "src")),
      ...walk(path.join(FRONTEND, "tests")),
    ].map(relToFrontend);
    expect(leftover, `搬迁后包内仍残留测试文件：${leftover.slice(0, 10).join(", ")}`).toEqual([]);
  });
});
