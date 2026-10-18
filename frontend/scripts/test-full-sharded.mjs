import { readdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const extraArgs = process.argv.slice(2);

const fastCommand = ["run", "test:fast", "--", "--reporter=dot", ...extraArgs];
const quickCommand = ["run", "test:quick", "--", "--reporter=dot", ...extraArgs];

const reactShards = [
  {
    name: "inventory-funds",
    files: [
      "src/accounts/InventoryDetail.test.tsx",
      "src/accounts/InventoryPanel.test.tsx",
      "src/accounts/InventoryPanel.filters.test.tsx",
      "src/accounts/InventoryPanel.write.test.tsx",
      "src/accounts/InventoryPanel.sale.test.tsx",
      "src/accounts/InventoryPanel.rebate.test.tsx",
      "src/accounts/InventoryProfileModal.test.tsx",
      "src/pools/FundsPage.test.tsx",
      "src/pools/FundsPage.write.test.tsx",
    ],
  },
  {
    name: "customers",
    files: [
      "src/customers/CustomersPage.test.tsx",
      "src/customers/CustomersPage.write.test.tsx",
      "src/customers/CustomersPage.live-fields.test.tsx",
    ],
  },
  {
    name: "sales-workflows",
    files: [
      "src/installments/InstallmentsPanel.test.tsx",
      "src/installments/InstallmentsPanel.actions.test.tsx",
      "src/orders/OrdersPage.test.tsx",
    ],
  },
  {
    name: "imports-rebates",
    files: [
      "src/imports/ImportWorkbench.test.tsx",
      "src/rebates/RebatesPanel.test.tsx",
    ],
  },
  {
    name: "reporting-settings",
    files: [
      "src/app/AppShell.test.tsx",
      "src/field-definitions/panels/SettingsPanels.test.tsx",
      "src/reporting/DataCenterPanel.test.tsx",
      "src/users/UsersPanel.test.tsx",
      "src/reporting/ReportsPage.details.test.tsx",
    ],
  },
  {
    name: "shared-ui",
    files: [
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
    ],
  },
];

const testFilePattern = /\.(test|spec)\.(ts|tsx)$/;
const collectTestFiles = (directory, prefix = "src") => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const absolute = join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return collectTestFiles(absolute, relative);
    return testFilePattern.test(entry.name) ? [relative] : [];
  });

const allTestFiles = collectTestFiles(join(process.cwd(), "src"));
const coveredReactFiles = new Set(reactShards.flatMap((shard) => shard.files));
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

const missingReactFiles = allTestFiles.filter((file) => (
  !fastFiles.has(file) && !quickFiles.has(file) && !coveredReactFiles.has(file)
));
if (missingReactFiles.length > 0) {
  console.error("未分片的 React 测试文件：", missingReactFiles.join(", "));
  process.exit(1);
}

const run = (name, args) => new Promise((resolve, reject) => {
  const child = spawn(npm, args, { stdio: "inherit", env: process.env });
  child.on("error", reject);
  child.on("close", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`${name} 退出：${code ?? signal}`));
  });
});

const jobs = [
  ["fast", fastCommand],
  ["quick", quickCommand],
  ...reactShards.map(({ name, files }) => [
    `react-${name}`,
    ["run", "test:react", "--", "--retry=0", "--reporter=dot", "--maxWorkers=1", ...extraArgs, ...files],
  ]),
];

const startedAt = performance.now();
const concurrency = 2;
console.log(`先单独运行 fast 与 quick，再以最多 ${concurrency} 个并发运行 React 分片：${reactShards.map(({ name }) => name).join("、")}`);
const failures = [];
for (const [name, args] of jobs.slice(0, 2)) {
  try {
    await run(name, args);
  } catch (error) {
    failures.push({ name, error });
  }
}

let nextJob = 2;
const worker = async () => {
  while (nextJob < jobs.length) {
    const index = nextJob;
    nextJob += 1;
    const [name, args] = jobs[index];
    try {
      await run(name, args);
    } catch (error) {
      failures.push({ name, error });
    }
  }
};
await Promise.all(Array.from({ length: concurrency }, worker));

if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`${name} 失败：${error.message}`);
  process.exitCode = 1;
} else {
  console.log(`完整分片回归通过，总耗时 ${((performance.now() - startedAt) / 1000).toFixed(2)} 秒`);
}
