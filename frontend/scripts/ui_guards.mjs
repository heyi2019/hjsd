/** UI 组件库静态守卫（零依赖，构建前跑）。
 * 挡的是「构建期即可判定」的回归：计数被当金额渲染、页面绕过组件库各写一套、端口回退 8000。
 * 用法：npm run guard（已挂在 npm run check 之前）。 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

/** 页面文件：排除组件库本体，否则守卫会自己告自己。 */
const pages = () =>
  walk(SRC).filter((f) => f.endsWith(".tsx") && !f.includes(join("shared", "ui")));

/** 计数语义的 label：必须显式 kind: "count"，否则被 MoneyText 渲染成 "1.00"。 */
const COUNT_LABELS = [
  "资金池数量", "未闭环异常", "阻断级异常", "已指派", "异常总数", "订单总数",
  "待处理", "TH 未闭环", "在库 / 分期中", "在库账号", "已售", "客户总数",
  "启用中", "已停用", "合约数", "逾期合约", "归集总数", "待结算", "订单数",
];

const failures = [];
const fail = (rule, detail) => failures.push(`  [${rule}] ${detail}`);

// 规则 1：计数型指标必须显式 kind: "count"
for (const file of pages()) {
  const text = readFileSync(file, "utf8");
  for (const label of COUNT_LABELS) {
    const pattern = new RegExp(`label: "${label}",[\\s\\S]{0,160}?amount:`, "g");
    for (const hit of text.matchAll(pattern)) {
      const segment = text.slice(hit.index, hit.index + hit[0].length);
      if (!segment.includes('kind: "count"')) {
        fail("count-kind", `${relative(process.cwd(), file)} → label: "${label}" 缺 kind: "count"`);
      }
    }
  }
}

// 规则 2~4：页面不得绕过组件库
const BANNED = [
  ["no-antd-statistic", (t) => t.includes("<Statistic"), "须用 StatCard / StatRow"],
  ["no-antd-tag", (t) => /<Tag[ >]/.test(t), "须用 StatusTag"],
  ["no-raw-button", (t) => /<Button[ >]/.test(t), "写操作须用 PermissionButton 权限门控"],
];
for (const [rule, probe, hint] of BANNED) {
  for (const file of pages()) {
    if (probe(readFileSync(file, "utf8"))) {
      fail(rule, `${relative(process.cwd(), file)} ${hint}`);
    }
  }
}

// 规则 5：端口不得回退 8000（已被 Docker 占用）
const client = readFileSync(join(SRC, "shared/api/client.ts"), "utf8");
if (client.includes("127.0.0.1:8000")) fail("port", "client.ts 仍指向 8000（应为 8123）");
if (!client.includes("127.0.0.1:8123")) fail("port", "client.ts 缺少 8123 兜底基址");

// 规则 6：异常类型中文映射必须与后端 IssueType 枚举逐条对齐（漏一条页面上就露出英文枚举）
const enumsSrc = readFileSync(
  join(process.cwd(), "..", "backend", "app", "domain", "enums.py"),
  "utf8",
);
// 注意：不能按空行截断——枚举体后面紧跟注释行，须截到下一个顶层 class/def 为止。
const issueTypeBlock = enumsSrc.match(/class IssueType\(StrEnum\):[\s\S]*?(?=\n(?:class|def) )/);
if (!issueTypeBlock) {
  fail("issue-type", "未找到后端 IssueType 枚举，无法校验前端映射");
} else {
  const backendTypes = [...issueTypeBlock[0].matchAll(/^\s+[A-Z_]+\s*=\s*"([A-Z_]+)"/gm)].map(
    (m) => m[1],
  );
  const workbench = readFileSync(join(SRC, "quality", "QualityWorkbench.tsx"), "utf8");
  const labelBlock = workbench.match(/ISSUE_TYPE_LABEL[^=]*=\s*\{([\s\S]*?)\n\};/);
  const frontendTypes = labelBlock
    ? [...labelBlock[1].matchAll(/([A-Z_]+):/g)].map((m) => m[1])
    : [];
  if (backendTypes.length === 0) {
    fail("issue-type", "后端 IssueType 枚举解析出 0 条，守卫正则可能已失效");
  }
  for (const type of backendTypes) {
    if (!frontendTypes.includes(type)) {
      fail("issue-type", `前端 ISSUE_TYPE_LABEL 缺后端枚举 ${type}`);
    }
  }
  for (const type of frontendTypes) {
    if (!backendTypes.includes(type)) {
      fail("issue-type", `前端 ISSUE_TYPE_LABEL 的 ${type} 在后端枚举中不存在（键名拼错或已废弃）`);
    }
  }
}

// 规则 7：StatusTag 必须覆盖后端状态枚举（否则页面上直接露出英文枚举）
const enumsPy = readFileSync(
  join(process.cwd(), "..", "backend", "app", "domain", "enums.py"),
  "utf8",
);
const statusTagSrc = readFileSync(join(SRC, "shared", "ui", "StatusTag.tsx"), "utf8");
const labelBlockM = statusTagSrc.match(/const LABELS[^=]*=\s*\{([\s\S]*?)\n\};/);
const labelKeys = labelBlockM
  ? [...labelBlockM[1].matchAll(/^\s{2}([A-Z_]+):/gm)].map((m) => m[1])
  : [];
// 这些枚举的值会直接进 StatusTag，必须全部有中文标签
const STATUS_ENUMS = [
  "OrderStatus", "InstallmentStatus", "AccountStatus", "RebateStatus",
  "IssueStatus", "IssueSeverity", "ImportBatchStatus", "ImportRowStatus",
  "PoolStatus", "DepositStatus",
];
/** 取枚举块。注意：传给 new RegExp 的模式里反斜杠必须双写（`\\(`），
 *  否则 JS 字符串会把 `\(` 变成空转义 `(`，整条规则静默失效。 */
const ENUM_BLOCK = (name) =>
  new RegExp(`class ${name}\\(StrEnum\\):[\\s\\S]*?(?=\\n(?:class|def) )`);

for (const enumName of STATUS_ENUMS) {
  const m = enumsPy.match(ENUM_BLOCK(enumName));
  if (!m) {
    fail("status-label", `后端未找到枚举 ${enumName}，规则 7 覆盖不完整`);
    continue;
  }
  const values = [...m[0].matchAll(/^\s+[A-Z_]+\s*=\s*"([A-Z_]+)"/gm)].map((x) => x[1]);
  if (values.length === 0) {
    fail("status-label", `枚举 ${enumName} 解析出 0 个值，正则可能已失效`);
    continue;
  }
  for (const v of values) {
    if (!labelKeys.includes(v)) fail("status-label", `StatusTag 缺 ${enumName}.${v} 的中文标签`);
  }
}

if (failures.length) {
  console.error(`UI 守卫未通过（${failures.length} 项）：`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`UI 守卫通过：${pages().length} 个页面文件，7 条规则全过（含后端 IssueType 对齐 + StatusTag 状态覆盖）。`);
