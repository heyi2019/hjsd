/** UI 组件库静态守卫（零依赖，构建前跑）。
 * 挡的是「构建期即可判定」的回归：计数被当金额渲染、页面绕过组件库各写一套、端口回退 8000。
 * 用法：npm run guard（已挂在 npm run check 之前）。
 *
 * 规则分两级：
 * - 构建阻断：会导致页面运行错误或产生错误数据格式的检查。
 * - 规范提示：用于架构/视觉一致性，输出 warning，但不阻断开发构建。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

// 全量文件列表只遍历一次（原 pages() 与规则 9/10/11/13/14 各自 walk(SRC) 重复整树扫描）。
const ALL_FILES = walk(SRC);

/** 页面文件：排除组件库本体，否则守卫会自己告自己。
 * 同时排除 *.test.tsx：测试夹具常用裸 <Button> / <Table> / <Tag> 模拟外部提交入口与
 * 表格渲染，它们不产出产品 UI，不应被「页面不得绕过组件库」系列规则管辖。
 * 规则 11 / 13 / 14 早已显式排除测试文件，此处统一口径（2026-11-02）。 */
const pages = () =>
  ALL_FILES.filter((f) => f.endsWith(".tsx") && !/\.test\.tsx$/.test(f) && !f.includes(join("shared", "ui")) && !f.includes(join("auth", "LoginPage")) && !f.includes(join("auth", "ChangePasswordPage")) && !f.includes(join("auth", "UserCenterPage")));

/** 计数语义的 label：必须显式 kind: "count"，否则被 MoneyText 渲染成 "1.00"。 */
const COUNT_LABELS = [
  "资金池数量", "订单总数",
  "待处理", "TH 未闭环", "在库 / 分期中", "在库账号", "已售", "客户总数",
  "启用中", "已停用", "合约数", "逾期合约", "归集总数", "待结算", "订单数",
];

const ADVISORY_RULES = new Set([
  "no-antd-statistic",
  "no-antd-tag",
  "no-raw-button",
  "no-raw-table",
  "normalize-error",
  "stack-gap",
  "no-inline-style",
  "style-alias",
  "responsive-fallback",
  "form-scope",
  "no-raw-select",
]);
const failures = [];
const advisories = [];
const fail = (rule, detail) => {
  const target = ADVISORY_RULES.has(rule) ? advisories : failures;
  target.push(`  [${rule}] ${detail}`);
};

// 规则 1：计数型指标必须显式 kind: "count"
for (const file of pages()) {
  const text = readFileSync(file, "utf8");
  for (const label of COUNT_LABELS) {
    const pattern = new RegExp(`label: "${label}",[\\s\\S]{0,160}?amount:`, "g");
    for (const hit of text.matchAll(pattern)) {
      const segment = text.slice(hit.index, hit.index + hit[0].length);
      if (!/kind:\s*("count"|'count'|\{"count"\})/.test(segment)) {
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
  // 禁止裸 <Table>：注意「标签后紧跟空格/尖括号」的写法会被 JSX 多行排版绕过
  // （`<Table` 换行接属性时其后是换行符，旧正则 `[ >]` 不匹配）——2026-11 实测
  // 三处裸表因此从未被本规则拦到。改用「标签名后不得紧跟标识符字符」判定。
  ["no-raw-table", (t) => /<Table(?![\w.])/.test(t), "须用 DataTable 统一列表壳"],
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
  "OrderStatus", "InstallmentStatus", "AccountStatus", "PoolStatus", "DepositStatus",
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
const cssFiles = ALL_FILES.filter((f) => f.endsWith(".css"));
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
// 排除条件必须同时覆盖两种写法：src/test/ 目录下的公共夹具，以及任意 *.test.tsx
// 内的用例内联夹具（撑高 2000px 测滚动、透传 style 的 mock 组件）。此前只排了目录，
// 与规则 13/14 的排除口径不一致，导致测试文件被产品规则拦下（2026-11-02 修正）。
//
// 显式豁免（2026-11-02 用户裁决「让守卫放过它」）：按「文件 → {上限, 理由}」登记。
// **上限是硬约束**——豁免不是放开：命中数一旦超过声明上限即报错，防止一个口子
// 演变成整页内联样式。登记的理由只允许是「静态 CSS 类无法表达的字段级动态值」；
// 「写起来快」「懒得提类名」不构成理由。视觉定稿后应回收到 CSS 并删除条目。
const INLINE_STYLE_ALLOWLIST = new Map([
  [
    "src/pools/StudioExpensePanel.tsx",
    {
      max: 2,
      reason:
        "工作室收支登记弹窗视觉稿落地（2026-11-02 用户指定）：金额控件宽度与标签列宽需按字段实时取值，"
        + "静态类名无法表达；其余样式一律落 StudioExpensePanel.css，本豁免不含页面复选/筛选区。",
    },
  ],
]);
for (const [rel, entry] of INLINE_STYLE_ALLOWLIST) {
  // 自检：路径写错或文件改名会让豁免静默失效（守卫报绿但实际没放行）。
  if (!existsSync(join(process.cwd(), rel))) {
    fail("no-inline-style", `豁免清单指向的文件不存在：${rel}（${entry.reason}）`);
  }
}
for (const file of ALL_FILES.filter((f) => f.endsWith(".tsx") && !f.includes(join("src", "test")) && !/\.test\.tsx$/.test(f))) {
  const text = stripComments(readFileSync(file, "utf8"));
  const rel = relative(process.cwd(), file).replaceAll("\\", "/");
  const hits = [...text.matchAll(/<[A-Za-z][^>]*\bstyle\s*=/g)].length;
  if (hits === 0) continue;
  const allowance = INLINE_STYLE_ALLOWLIST.get(rel);
  if (allowance && hits <= allowance.max) continue;
  const quota = allowance ? `（豁免上限 ${allowance.max} 处，实有 ${hits} 处）` : "";
  fail("no-inline-style", `${rel} → 样式必须迁移到共享 CSS / 设计令牌${quota}`);
}

// 规则 12：前端样式只能使用当前品牌语义，禁止保留旧视觉别名或开发兜底入口。
// 旧的 violet 命名曾作为兼容别名长期存在，实际颜色已经是品牌蓝；继续保留会让
// 令牌语义与业务设计不一致，也会让下一轮重构误把旧别名当成可用 API。
const styleSource = cssFiles.map((file) => stripComments(readFileSync(file, "utf8"))).join("\n");
if (/\bviolet\b/i.test(styleSource)) {
  fail("style-alias", "样式仍保留 violet 旧视觉别名，应统一为品牌语义令牌");
}
const mainSource = readFileSync(join(SRC, "main.tsx"), "utf8");
if (mainSource.includes("responsive-overrides.css")) {
  fail("responsive-fallback", "main.tsx 仍加载开发服务器响应式兼容兜底，应归并到正式样式");
}

// 规则 13：录入表单必须接入「设置-表单字段」配置体系。
// 背景（2026-10-27）：12 个业务弹窗（订单 5 / 库存 4 / 工作室 3）漏接表单字段配置，
// 字段全部前端硬编码，用户无法在设置页配置——根因是新增表单时没有强制提醒动作。
// 判定：文件含 antd Form + onFinish（录入表单特征），但未从 ConfigurableField
// 体系消费任何配置能力。两条等价接线路径都认可：
//   a) <FieldConfigScope scope=...> 包裹（含 CfgItem / CustomFieldSection）
//   b) useOrderFormConfig(scope) 直取配置（CreateBusinessModal / SALE 等原范式）
// 白名单 = 刻意不接的系统表单/配置管理界面，逐项带理由；新增录入表单
// 要么接线、要么显式加入白名单并写明理由——不允许静默漏接。
const CONFIG_MODULE_RE = /from\s+"[^"]*ConfigurableField"/;
const WIRED_RE = /FieldConfigScope|useOrderFormConfig/;
const FORM_SCOPE_WHITELIST = new Map([
  ["src/auth/LoginPage.tsx", "登录表单，非业务数据录入"],
  ["src/auth/ChangePasswordPage.tsx", "改密表单，非业务数据录入"],
  ["src/auth/UserCenterPage.tsx", "用户中心，非业务数据录入"],
  ["src/field-definitions/panels/OrderFormFieldsPanel.tsx", "表单字段配置界面本身（即守卫所保护的设置页）"],
  ["src/field-definitions/panels/useOrderFormFieldsPanelController.tsx", "同上：字段配置界面的编辑表单 JSX 拆分到 controller 后仍是同一界面，非业务录入"],
  ["src/field-definitions/panels/OrderTypeRoutesPanel.tsx", "配置管理界面本身"],
  ["src/policy/PolicyResolveModal.tsx", "政策试算弹窗，非业务数据录入"],
  ["src/policy/PolicyVersionEditorModal.tsx", "政策版本编辑，配置管理"],
  ["src/users/TeamsPanel.tsx", "团队管理，系统表单"],
  ["src/users/UsersPanel.tsx", "用户管理，系统表单"],
  ["src/customer-center/CustomerEditModal.tsx", "客户编辑弹窗，由 CustomerPanel.tsx 逐字拆出（原与新建弹窗共驻同一文件、搭 FieldConfigScope 顺风车）；扩展字段已通过 activeDefs（orderFormFieldsApi.list CUSTOMER）接入配置体系，基础字段维持裸 Form.Item 以直接回写已建档联系方式；FieldConfigScope/CfgItem 统一接线改造另案。类比 useOrderFormFieldsPanelController 拆分条目"],
  ["src/customer-center/CustomerMergeModal.tsx", "客户合并确认表单：目标客户为运行时动态选择、合并原因仅记操作日志，非客户档案可配置字段，与 InventoryDeleteDialog 同属系统级确认输入"],
]);
let wiredCount = 0;
for (const file of ALL_FILES.filter((f) => f.endsWith(".tsx") && !f.includes(join("src", "test")) && !/\.test\.tsx$/.test(f))) {
  const rel = relative(process.cwd(), file).replaceAll("\\", "/");
  const text = readFileSync(file, "utf8");
  // 业务表单统一使用共享 BusinessRegistrationForm；保留对原生 antd Form 的识别以覆盖
  // 登录、查询等非业务表单和 Form.List/Form.Item 的宿主文件。
  if (!(/<(?:Form|BusinessRegistrationForm)[\s>]/.test(text) && /onFinish=/.test(text))) continue;
  if (WIRED_RE.test(text) && CONFIG_MODULE_RE.test(text)) {
    wiredCount++;
    continue;
  }
  if (FORM_SCOPE_WHITELIST.has(rel)) continue;
  fail(
    "form-scope",
    `${rel} → 录入表单未接入「设置-表单字段」配置体系（须 FieldConfigScope / useOrderFormConfig；确属系统表单则加入 ui_guards.mjs 白名单并写明理由）`,
  );
}
// 规则 13 自检：全项目 0 个已接线表单 = 判定正则已失效（守卫假绿）。
if (wiredCount === 0) {
  fail("form-scope", "全项目未找到任何已接线表单，规则 13 的判定正则可能已失效");
}

// 规则 14：业务代码统一使用共享 Select，禁止重新直接引入 Ant Design Select。
// 共享组件本体是唯一允许接触底层 antd Select 的位置；测试夹具可按测试自身需要使用原生组件。
const sharedSelectFile = join(SRC, "shared", "ui", "Select.tsx");
const rawAntdSelectRe = /import\s*\{[\s\S]*?\bSelect(?:\s+as\s+\w+)?\s*[,}][\s\S]*?\}\s*from\s+"antd"/;
for (const file of ALL_FILES.filter((f) => f.endsWith(".tsx") && !f.includes(join("src", "test")) && !/\.test\.tsx$/.test(f))) {
  if (file === sharedSelectFile) continue;
  const text = readFileSync(file, "utf8");
  if (rawAntdSelectRe.test(text)) {
    fail("no-raw-select", `${relative(process.cwd(), file)} → 请从 shared/ui 引用 Select，不要直接引用 antd Select`);
  }
}

if (advisories.length) {
  console.warn(`UI 守卫提示（${advisories.length} 项，不阻断构建）：`);
  console.warn(advisories.join("\n"));
}
if (failures.length) {
  console.error(`UI 构建守卫未通过（${failures.length} 项）：`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `UI 守卫通过：${pages().length} 个页面文件，构建阻断规则与规范提示规则均完成检查。`,
);
