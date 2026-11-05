// 用 TypeScript AST 精确定位 it() 用例区间，避免字符串切分把括号算错。
// 用法：node scripts/trim-sale-cases.mjs --file <path> [--list] [--drop "标题1,标题2"]
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const argv = process.argv.slice(2);
const argOf = (n, f = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : f;
};
const file = argOf("--file");
const listOnly = argv.includes("--list");
const drop = new Set((argOf("--drop", "") || "").split(",").map((s) => s.trim()).filter(Boolean));

const src = readFileSync(file, "utf8");
const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** 收集所有 it("标题", ...) 的 CallExpression 节点 */
const cases = [];
const walk = (node) => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const name = node.expression.text;
    if ((name === "it" || name === "test") && node.arguments.length >= 2 && ts.isStringLiteral(node.arguments[0])) {
      cases.push({
        title: node.arguments[0].text,
        start: node.getStart(sf),
        end: node.getEnd(),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
    }
  }
  ts.forEachChild(node, walk);
};
walk(sf);

if (listOnly || drop.size === 0) {
  for (const c of cases) console.log(`${String(c.line).padStart(4)}  ${(c.end - c.start + "B").padStart(6)}  ${c.title}`);
  console.log(`\n共 ${cases.length} 条用例`);
  process.exit(0);
}

const missing = [...drop].filter((t) => !cases.some((c) => c.title === t));
if (missing.length) {
  console.error("未找到下列标题，放弃改动：");
  missing.forEach((t) => console.error("  - " + t));
  process.exit(1);
}

const targets = cases.filter((c) => drop.has(c.title));
// 从后往前删，保证前面区间偏移不变；连同其后的换行一起删，避免留下连续空行
let out = src;
for (const c of [...targets].sort((a, b) => b.start - a.start)) {
  let end = c.end;
  while (out[end] === "\n" || out[end] === "\r") end++;
  out = out.slice(0, c.start) + out.slice(end);
}

writeFileSync(file, out);
console.log(`删除 ${targets.length} 条：`);
targets.forEach((c) => console.log(`  - [${c.line}] ${c.title}`));
console.log(`剩余 ${cases.length - targets.length} 条`);
