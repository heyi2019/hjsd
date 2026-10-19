import { readdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// ---- 复刻 test-full-sharded.mjs 的文件分类（保证覆盖一致）----
const fastFiles = new Set([
  "src/test/fixtures.test.ts",
  "src/accounts/inventory-export.test.ts",
  "src/accounts/inventory-logic.test.ts",
  "src/shared/api/catalog.test.ts",
  "src/shared/api/client.test.ts",
  "src/shared/lib/format.test.ts",
  "src/vite.config.test.ts",
]);
const quickFiles = new Set([
  "src/app/DashboardPage.test.tsx",
  "src/app/DashboardPage.interactions.test.tsx",
  "src/auth/LoginPage.test.tsx",
  "src/auth/UserCenterPage.test.tsx",
  "src/field-definitions/SettingsPage.test.tsx",
  "src/orders/CreateBusinessModal.test.tsx",
  "src/orders/CreateBusinessModal.distribution.test.tsx",
  "src/policy/PolicySettingsPanel.test.tsx",
  "src/reporting/ReportsPage.test.tsx",
  "src/shared/state/session.test.tsx",
]);
const reactFiles = [
  "src/accounts/InventoryDetail.test.tsx",
  "src/accounts/InventoryPanel.test.tsx",
  "src/accounts/InventoryPanel.filters.test.tsx",
  "src/accounts/InventoryPanel.write.test.tsx",
  "src/accounts/InventoryPanel.sale.test.tsx",
  "src/accounts/InventoryPanel.rebate.test.tsx",
  "src/accounts/InventoryProfileModal.test.tsx",
  "src/pools/FundsPage.test.tsx",
  "src/pools/FundsPage.write.test.tsx",
  "src/customers/CustomersPage.test.tsx",
  "src/customers/CustomersPage.write.test.tsx",
  "src/customers/CustomersPage.live-fields.test.tsx",
  "src/installments/InstallmentsPanel.test.tsx",
  "src/installments/InstallmentsPanel.actions.test.tsx",
  "src/orders/OrdersPage.test.tsx",
  "src/imports/ImportWorkbench.test.tsx",
  "src/rebates/RebatesPanel.test.tsx",
  "src/app/AppShell.test.tsx",
  "src/field-definitions/panels/SettingsPanels.test.tsx",
  "src/field-definitions/panels/GameTypeSettingsPanel.test.tsx",
  "src/field-definitions/panels/PoolsPanel.test.tsx",
  "src/reporting/DataCenterPanel.test.tsx",
  "src/users/UsersPanel.test.tsx",
  "src/reporting/ReportsPage.details.test.tsx",
  "src/shared/ui/DataTable.test.tsx",
  "src/shared/ui/EntryCard.test.tsx",
  "src/shared/ui/ErrorBanner.test.tsx",
  "src/shared/ui/FormDrawer.test.tsx",
  "src/shared/ui/MoneyText.test.tsx",
  "src/shared/ui/NestedFormSection.test.tsx",
  "src/shared/ui/PageHeader.test.tsx",
  "src/shared/ui/PermissionButton.test.tsx",
  "src/shared/ui/StatCard.test.tsx",
  "src/shared/ui/StatusTag.test.tsx",
];
const reactSet = new Set(reactFiles);

const testFilePattern = /\.(test|spec)\.(ts|tsx)$/;
const collectTestFiles = (directory, prefix = "src") => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const absolute = join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return collectTestFiles(absolute, relative);
    return testFilePattern.test(entry.name) ? [relative] : [];
  });

const allTestFiles = collectTestFiles(join(process.cwd(), "src"));
const covered = new Set([...fastFiles, ...quickFiles, ...reactFiles]);
const missing = allTestFiles.filter((f) => !covered.has(f));
if (missing.length > 0) {
  console.error("未覆盖的测试文件：", missing.join(", "));
  process.exit(1);
}

const projectOf = (file) =>
  fastFiles.has(file) ? "fast" : quickFiles.has(file) ? "quick" : reactSet.has(file) ? "react" : null;

const tasks = allTestFiles
  .filter((f) => covered.has(f))
  .map((file) => ({ file, project: projectOf(file) }));

const run = (project, file) => new Promise((resolve) => {
  const child = spawn(
    npm,
    ["run", `test:${project}`, "--", "--retry=0", "--maxWorkers=1", file],
    { stdio: ["ignore", "ignore", "inherit"], env: process.env },
  );
  child.on("close", (code) => resolve(code === 0));
});

const results = [];
let next = 0;
const startedAt = performance.now();
const concurrency = 2;
const worker = async () => {
  while (next < tasks.length) {
    const t = tasks[next++];
    const s = performance.now();
    const ok = await run(t.project, t.file);
    const ms = performance.now() - s;
    results.push({ file: t.file, project: t.project, ms, ok });
    console.log(`[${t.project}] ${ok ? "OK " : "FAIL"} ${t.file}  ${(ms / 1000).toFixed(1)}s`);
  }
};
await Promise.all(Array.from({ length: concurrency }, worker));

const total = (performance.now() - startedAt) / 1000;
const failed = results.filter((r) => !r.ok);
const byProject = (p) => results.filter((r) => r.project === p);
const sum = (arr) => arr.reduce((a, r) => a + r.ms, 0) / 1000;

console.log("\n================ 每文件耗时（秒，按 project 分组）================");
for (const p of ["fast", "quick", "react"]) {
  const arr = byProject(p).sort((a, b) => b.ms - a.ms);
  console.log(`\n-- ${p} (${arr.length} 文件, 合计 ${sum(arr).toFixed(1)}s) --`);
  for (const r of arr) {
    console.log(`  ${(r.ms / 1000).toFixed(1).padStart(7)}s  ${r.ok ? "OK " : "FAIL"}  ${r.file}`);
  }
}

const top = [...results].sort((a, b) => b.ms - a.ms).slice(0, 15);
console.log("\n================ 最慢 Top 15 ================");
for (const r of top) {
  console.log(`  ${(r.ms / 1000).toFixed(1).padStart(7)}s  ${r.ok ? "OK " : "FAIL"}  [${r.project}] ${r.file}`);
}

console.log(`\n总文件数：${results.length}  通过：${results.length - failed.length}  失败：${failed.length}`);
console.log(`总时间：${total.toFixed(1)} 秒（${concurrency} 并发）`);
if (failed.length > 0) {
  console.log("\n失败文件：");
  for (const r of failed) console.log(`  ${r.file}`);
  process.exitCode = 1;
}
