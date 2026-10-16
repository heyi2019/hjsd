/** UI 组件库静态守卫（零依赖，构建前跑）。
 * 挡的是「构建期即可判定」的回归：计数被当金额渲染、页面绕过组件库各写一套、端口回退 8000。
 * 用法：npm run guard（已挂在 npm run check 之前）。 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

/** 页面文件：排除组件库本体，否则守卫会自己告自己。 */
const pages = () =>
  walk(SRC).filter((f) => f.endsWith(".tsx") && !f.includes(join("shared", "ui")) && !f.includes(join("auth", "LoginPage")) && !f.includes(join("auth", "ChangePasswordPage")) && !f.includes(join("auth", "UserCenterPage")));

/** 计数语义的 label：必须显式 kind: "count"，否则被 MoneyText 渲染成 "1.00"。 */
const COUNT_LABELS = [
  "资金池数量", "订单总数",
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
  ["no-raw-table", (t) => /<Table(?:<[^>]+>)?[ >]/.test(t), "须用 DataTable 统一列表壳"],
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

// 规则 6：StatusTag 必须覆盖后端状态枚举（否则页面上直接露出英文枚举）
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
  "ImportBatchStatus", "ImportRowStatus",
  "PoolStatus", "DepositStatus", "PolicyStatus",
];
/** 取枚举块。注意：传给 new RegExp 的模式里反斜杠必须双写（`\\(`），
 *  否则 JS 字符串会把 `\(` 变成空转义 `(`，整条规则静默失效。 */
const ENUM_BLOCK = (name) =>
  new RegExp(`class ${name}\\(StrEnum\\):[\\s\\S]*?(?=\\n(?:class|def) )`);

for (const enumName of STATUS_ENUMS) {
  const m = enumsPy.match(ENUM_BLOCK(enumName));
  if (!m) {
    fail("status-label", `后端未找到枚举 ${enumName}，规则 6 覆盖不完整`);
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

// 规则 7：normalizeError 必须来自共享层，禁止各页面复制一份。
// 背景：曾有 11 个页面各自复制一份逐字相同的实现，修复一处网络层文案要改 11 个文件，
// 且极易漏改。共享实现见 shared/api/client.ts。
const SHARED_CLIENT = join(SRC, "shared", "api", "client.ts");
for (const file of pages()) {
  if (file === SHARED_CLIENT) continue;
  const text = readFileSync(file, "utf8");
  // 解析出 0 个匹配也算失败——说明正则本身可能已失效（见 ENUM_BLOCK 注释）。
  const match = text.match(/function\s+normalizeError\s*\(/);
  if (match) {
    fail(
      "normalize-error",
      `${relative(process.cwd(), file)} → 重复实现 normalizeError，应从 shared/api/client 导入`,
    );
  }
  // 导入路径校验必须容许相对前缀：页面多在 src/<域>/ 下，真实导入串是
  // `"../shared/api/client"`；原正则 /from\s+"[^"]*api\/client"/ 虽能匹配该串，
  // 但它同时会匹配 `"../shared/api/client-foo"` 这类无关模块。
  // 改为锚定到具体共享模块，并显式排除自引用（本文件即 shared/api/client.ts，已在上面 continue）。
  if (/\bnormalizeError\s*\(/.test(text) && !/from\s+"[^"]*shared\/api\/client"/.test(text)) {
    fail("normalize-error", `${relative(process.cwd(), file)} → 调用 normalizeError 但未从共享层导入`);
  }
}

// 规则 8：`.ui-stack` 的直接子组件不得自带 margin-block-end。
// 背景（实测事故）：父级 .ui-stack gap:16px 与子组件 margin-block-end:16px
// 叠加成 32px，导致全站块间距呈 [32,32,32,16] 锯齿，与设计令牌 16px 不符。
// 纵向节奏必须由单一机制（父级 gap）独占。
// 白名单：.ui-error-banner 的 12px 是刻意的小间距，且非 .ui-stack 直接子元素。
// 只检查唯一定义文件 ui-components.css：全量扫描会对每个不含该选择器的 CSS
// 误报「未找到声明块」（第一版就是这么翻车的）。
const STACK_CHILD_MARGIN_BAN = [".ui-page-header", ".ui-stat-row"];
const uiComponentsCss = join(SRC, "shared", "styles", "ui-components.css");
if (!existsSync(uiComponentsCss)) {
  fail("stack-gap", `缺少 ${relative(process.cwd(), uiComponentsCss)}，规则 8 无从检查`);
} else {
  const text = readFileSync(uiComponentsCss, "utf8");
  for (const sel of STACK_CHILD_MARGIN_BAN) {
    const re = new RegExp(`(^|\\})\\s*${sel.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "gm");
    const found = [...text.matchAll(re)];
    // 解析出 0 个声明块也算失败——说明选择器改名了，规则已失效（见 ENUM_BLOCK 注释）。
    if (found.length === 0) {
      fail("stack-gap", `ui-components.css 未找到 ${sel} 声明块，规则 8 覆盖不完整`);
      continue;
    }
    for (const m of found) {
      if (/margin-block-end\s*:\s*(var\(--space-\d|[\d.]+px)/.test(m[2])) {
        fail(
          "stack-gap",
          `ui-components.css → ${sel} 带 margin-block-end，会与 .ui-stack 的 gap 叠加成双倍间距`,
        );
      }
    }
  }
}

// 规则 9：CSS 自定义属性（令牌）不得「引用了但从未定义」。
// 背景（实测事故 2026-10-04）：ui-components.css 引用 var(--font-caption-2)，
// 但 tokens.css 只有 --font-caption 与 --font-nav-caption，没有 --font-caption-2。
// var() 引用不存在的自定义属性时，**整条声明作废且零报错**，静默回落浏览器默认
// （实测 font 简写整体失效、字号退回 13px，恰与父级继承值撞车而看不出异常）。
// 这类缺陷 tsc / vite / 现有 8 条规则全都抓不到，只能靠交叉比对声明与引用。
const cssFiles = walk(SRC).filter((f) => f.endsWith(".css"));
/**
 * 剥注释必须能跨行：块注释 /* ... *\/ 常整段跨多行（如 tokens.css 里
 * 「响应式断点媒体查询」那段就整块提到 @media (--bp-md) 的用法），
 * 只做单行 replace 的话，注释第二行起的 `var(--bp-*)` 会被当成真代码 →
 * 规则 9 首次运行就误报（实测 var(--bp-) 这种根本不可能的变量名 = 典型症状）。
 * 故先整块去注释，再按行处理。
 */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const definedVars = new Set();
for (const file of cssFiles) {
  for (const m of readFileSync(file, "utf8").matchAll(/(--[\w-]+)\s*:/g)) definedVars.add(m[1]);
}
for (const file of cssFiles) {
  const lines = stripComments(readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    const code = line;
    for (const m of code.matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (!definedVars.has(m[1])) {
        fail(
          "css-token",
          `${relative(process.cwd(), file)}:${i + 1} → 引用未定义令牌 var(${m[1]})，该声明会整条静默失效`,
        );
      }
    }
  });
}

// 规则 10：animation / animation-name 不得引用未定义的 @keyframes。
// 背景（实测事故 2026-10-04，同类）：antd-adapter.css 引用 ui-spring-in，
// 但全项目从未定义该 @keyframes → animation-name 匹配不到即整体不生效、零报错，
// 等于「声明了弹簧入场、实际没有任何弹层在动」。
// 值里含 var() 的（animation: ui-x var(--dur)）无法静态判定，此处跳过，
// 交由浏览器端 CSSOM 真值审计兜底。
const definedKf = new Set();
for (const file of cssFiles) {
  for (const m of readFileSync(file, "utf8").matchAll(/@keyframes\s+([\w-]+)/g)) definedKf.add(m[1]);
}
const KF_SKIP = new Set([
  "none", "infinite", "both", "forwards", "backwards", "normal", "reverse",
  "alternate", "alternate-reverse", "paused", "running",
]);
for (const file of cssFiles) {
  const lines = stripComments(readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    const code = line;
    if (!/^\s*(animation|animation-name)\s*:/.test(code)) return;
    if (/var\(/.test(code)) return; // 动态名，静态不可判
    const token = code.split(":").slice(1).join(":").trim().split(/[\s,]+/)[0];
    if (!token) return;
    if (KF_SKIP.has(token)) return;
    if (/^[\w-]+\(/.test(token)) return; // cubic-bezier / steps / linear(...)
    if (/^[-+]?[\d.]+m?s$/.test(token)) return; // 纯时长
    if (!definedKf.has(token)) {
      fail(
        "css-keyframes",
        `${relative(process.cwd(), file)}:${i + 1} → animation 引用未定义 @keyframes ${token}，动效零报错失效`,
      );
    }
  });
}
// 规则 10 自检：若全项目一个 @keyframes 都没有，说明本规则正则已失效
// （历史上踩过「正则永不匹配 → 整条规则静默失效 → 守卫一直报绿」）。
if (definedKf.size === 0) {
  fail("css-keyframes", "全项目未找到任何 @keyframes，规则 10 的解析正则可能已失效");
}

// 规则 11：页面与共享 UI 不得使用 JSX 内联 style。
// 统一样式必须进入令牌 / 共享 CSS，避免同一控件在不同页面出现不可追踪的局部变体。
// 测试 motion stub 是 React style 转发夹具，属于测试基础设施，明确排除。
for (const file of walk(SRC).filter((f) => f.endsWith(".tsx") && !f.includes(join("src", "test")))) {
  const text = readFileSync(file, "utf8");
  if (/<[A-Za-z][^>]*\bstyle\s*=/.test(text)) {
    fail("no-inline-style", `${relative(process.cwd(), file)} → 样式必须迁移到共享 CSS / 设计令牌`);
  }
}

if (failures.length) {
  console.error(`UI 守卫未通过（${failures.length} 项）：`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `UI 守卫通过：${pages().length} 个页面文件，12 条规则全过（含 StatusTag 状态覆盖 + normalizeError 去重 + 纵向节奏单一机制 + 令牌/关键帧 + 无内联样式/原生表格）。`,
);
