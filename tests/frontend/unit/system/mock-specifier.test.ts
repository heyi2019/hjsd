/**
 * TESTING-04 测试文件的模块定位必须用别名（@/ 或 @fixtures/）或包名，禁止相对路径。
 *
 * 为什么需要守卫：vi.mock 用相对路径时，测试文件一旦搬家，解析结果不会报错——
 * 它仍可能落到某个存在的文件上，于是 mock 注册了却没命中被测模块，测试改用真实现
 * 照常通过。这类失效是静默的，只有在改代码的人同步改了断言的地方才会暴露。
 * 把「相对路径」本身定为违规，才能把静默失效变成提交时的显式失败。
 *
 * 当前仓库不保留相对路径豁免；新增一条相对路径即红。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE = <repo>/tests/frontend/unit/system
const REPO = path.resolve(HERE, "../../../..");
const SRC = path.join(REPO, "frontend", "src");
const FIXTURES = path.join(REPO, "tests", "fixtures");
const TESTS_ROOT = path.join(REPO, "tests", "frontend");
const BASELINE = path.join(REPO, "tests", "config", "mock-specifier-baseline.json");

const MOCK_CALL = /vi\.(?:mock|doMock|importActual|importMock)\(\s*["'`]([^"'`]+)["'`]/g;

/** 去掉注释再扫：本文件自己的说明里就写着反例，注释里的 `vi.mock("../x")` 不是违规；
 *  被注释掉的 mock 同理不该算（它本来就不生效）。 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** 基线里的 file 字段以**仓库根**为基准（如 tests/frontend/module/business/OrdersPage.test.tsx）。 */
const rel = (abs: string) => path.relative(REPO, abs).split(path.sep).join("/");

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) testFiles(full, acc);
    else if (/\.(test|spec)\.tsx?$/.test(e.name)) acc.push(full);
  }
  return acc;
}

type Entry = { file: string; specifier: string };

function collect(): Entry[] {
  const rows: Entry[] = [];
  const roots = [TESTS_ROOT, FIXTURES].filter((dir) => existsSync(dir));
  for (const root of roots) {
    for (const f of testFiles(root)) {
      for (const m of stripComments(readFileSync(f, "utf8")).matchAll(MOCK_CALL)) {
        rows.push({ file: rel(f), specifier: m[1] });
      }
    }
  }
  return rows;
}

/** 别名 → 候选真实文件。字面量目录不算命中，只有真实文件才算。 */
function aliasTargets(specifier: string): string[] {
  const base = specifier.startsWith("@fixtures/")
    ? path.join(FIXTURES, specifier.slice("@fixtures/".length))
    : path.join(SRC, specifier.slice(2));
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
    path.join(base, "index.ts"), path.join(base, "index.tsx")];
}

const key = (e: Entry) => `${e.file}::${e.specifier}`;
const entries: Entry[] = collect();
const baselineFile = JSON.parse(readFileSync(BASELINE, "utf8")) as { 条目: Entry[] };
const baseline = baselineFile.条目;
const frozen = new Set(baseline.map(key));
const actual = new Set(entries.map(key));

describe("TESTING-04 测试文件的模块标识", () => {
  it("扫描根非空（扫描写错时这里是第一道红灯）", () => {
    expect(existsSync(TESTS_ROOT), "tests/frontend 不存在").toBe(true);
    expect(entries.length, "扫到的 vi.mock 为 0，守卫已失效").toBeGreaterThan(0);
  });

  it("禁止相对路径：新增必须改用 @/ 或 @fixtures/ 别名", () => {
    const offending = entries.filter((e) => e.specifier.startsWith(".") && !frozen.has(key(e)));
    expect(
      offending.map((e) => `${e.file} → vi.mock("${e.specifier}")`),
      "新增了相对路径 vi.mock。搬家后它会静默失效，请改写为 @/ 或 @fixtures/ 别名",
    ).toEqual([]);
  });

  it("@/ 与 @fixtures/ 别名必须解析到真实文件", () => {
    const broken = entries
      .filter((e) => e.specifier.startsWith("@/") || e.specifier.startsWith("@fixtures/"))
      .filter((e) => !aliasTargets(e.specifier).some(isFile))
      .map((e) => `${e.file} → ${e.specifier}`);
    expect(broken, "别名指向的文件不存在（拼写错误或目标已改名）").toEqual([]);
  });

  it("基线不得残留失效条目（文件或 mock 目标已消失）", () => {
    const dead = baseline
      .filter((e) => !existsSync(path.join(REPO, e.file)))
      .map((e) => `${e.file}（文件已不存在）`);
    const gone = baseline.filter((e) => existsSync(path.join(REPO, e.file)) && !actual.has(key(e)))
      .map((e) => `${e.file} → ${e.specifier}（mock 已删除或改写）`);
    expect([...dead, ...gone], "基线有失效条目，请从 mock-specifier-baseline.json 中删除").toEqual([]);
  });

  it("相对路径存量不增长（当前基线 0 条）", () => {
    const relative = entries.filter((e) => e.specifier.startsWith("."));
    expect(relative.length, `相对路径 ${relative.length} 条，超过冻结上限 ${baseline.length}`)
      .toBeLessThanOrEqual(baseline.length);
  });
});
