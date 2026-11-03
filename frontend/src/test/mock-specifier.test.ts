/**
 * TESTING-04 vi.mock 的模块标识必须用 @/ 别名或包名；相对路径冻结在基线内，只减不增。
 *
 * 为什么需要守卫：vi.mock 用相对路径时，测试文件一旦搬家，解析结果不会报错——
 * 它仍可能落到某个存在的文件上，于是 mock 注册了却没命中被测模块，测试改用真实现
 * 照常通过。这类失效是静默的，只有在改代码的人同步改了断言的地方才会暴露。
 * 把「相对路径」本身定为违规，才能把静默失效变成提交时的显式失败。
 *
 * 基线 src/test/mock-specifier-baseline.json 是存量冻结清单：新增不允许，
 * 但条目失效（文件或目标已不存在）时必须删除，否则基线会腐烂成假豁免。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.dirname(HERE);
const FRONTEND = path.dirname(SRC);
// 纯逻辑测试已于 2026-11-04 迁到 frontend/tests/；守卫只扫 src/ 就等于对它们完全失效
// （相对 vi.mock 可以随便加、永不报警）。两个目录必须都扫。
const TESTS_DIR = path.join(FRONTEND, "tests");
const BASELINE = path.join(HERE, "mock-specifier-baseline.json");

const MOCK_CALL = /vi\.(?:mock|doMock|importActual|importMock)\(\s*["'`]([^"'`]+)["'`]/g;

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// 基线里的 file 字段以 frontend/ 为基准（如 "src/users/UsersPanel.test.tsx"），
// 此处必须同基准，否则「文件不存在」会全是假警报。
const rel = (abs: string) => path.relative(FRONTEND, abs).split(path.sep).join("/");

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
  const roots = [SRC, TESTS_DIR].filter((dir) => existsSync(dir));
  for (const root of roots) {
    for (const f of testFiles(root)) {
      for (const m of readFileSync(f, "utf8").matchAll(MOCK_CALL)) {
        rows.push({ file: rel(f), specifier: m[1] });
      }
    }
  }
  return rows;
}

/** `@/x` 相对 src 解析；字面量目录不算命中，只有真实文件才算。 */
function aliasTargets(specifier: string): string[] {
  const base = path.join(SRC, specifier.slice(2));
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
    path.join(base, "index.ts"), path.join(base, "index.tsx")];
}

const key = (e: Entry) => `${e.file}::${e.specifier}`;
const entries: Entry[] = collect();
const baseline: Entry[] = JSON.parse(readFileSync(BASELINE, "utf8")).条目;
const frozen = new Set(baseline.map(key));
const actual = new Set(entries.map(key));

describe("TESTING-04 vi.mock 模块标识", () => {
  it("相对路径只允许出现在冻结基线内；新增必须改用 @/ 别名", () => {
    const offending = entries.filter((e) => e.specifier.startsWith(".") && !frozen.has(key(e)));
    expect(
      offending.map((e) => `${e.file} → vi.mock("${e.specifier}")`),
      "新增了相对路径 vi.mock。搬家后它会静默失效，请改写为 @/ 别名（如 @/shared/api/client）",
    ).toEqual([]);
  });

  it("@/ 别名必须解析到 src 下的真实文件", () => {
    const broken = entries
      .filter((e) => e.specifier.startsWith("@/"))
      .filter((e) => !aliasTargets(e.specifier).some(isFile))
      .map((e) => `${e.file} → ${e.specifier}`);
    expect(broken, "@/ 别名指向的文件不存在（拼写错误或目标已改名）").toEqual([]);
  });

  it("基线不得残留失效条目（文件或 mock 目标已消失）", () => {
    const dead = baseline
      .filter((e) => !existsSync(path.join(FRONTEND, e.file)))
      .map((e) => `${e.file}（文件已不存在）`);
    const gone = baseline.filter((e) => existsSync(path.join(FRONTEND, e.file)) && !actual.has(key(e)))
      .map((e) => `${e.file} → ${e.specifier}（mock 已删除或改写）`);
    expect([...dead, ...gone], "基线有失效条目，请从 mock-specifier-baseline.json 中删除").toEqual([]);
  });

  it("相对路径存量不增长", () => {
    const relative = entries.filter((e) => e.specifier.startsWith("."));
    expect(relative.length, `相对路径 ${relative.length} 条，超过冻结上限 ${baseline.length}`)
      .toBeLessThanOrEqual(baseline.length);
  });

  it("两个测试根都在扫描范围内", () => {
    // 目录被删/改名时上面三条会因为「扫不到」而全绿——必须显式确认搬出去的那批仍在。
    expect(existsSync(TESTS_DIR), "frontend/tests 不存在（纯逻辑测试被搬回或删了？）").toBe(true);
    const scanned = entries.filter((e) => e.file.startsWith("tests/"));
    expect(scanned.length, "frontend/tests 下扫到的 vi.mock 为 0，守卫已对该目录失效").toBeGreaterThan(0);
  });
});
