/**
 * 执行单个 react-deep 分片。
 *
 * 分片按业务边界维护，文件必须属于 vitest.config.ts 的 react-deep 项目。
 * 本地可逐片执行，CI 通过矩阵并行执行；原 test:full:deep 仍负责单进程全量深度回归。
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const SHARDS = {
  shell: [
    "src/app/AppShell.deep.test.tsx",
    "src/app/DashboardPage.deep.test.tsx",
  ],
  business: [
    "src/orders/CreateBusinessModal.deep.test.tsx",
    "src/orders/th/ThBusinessPanel.deep.test.tsx",
    "src/stocks/InventoryPanel.deep.test.tsx",
    "src/stocks/InventoryProfileModal.deep.test.tsx",
  ],
  governance: [
    "src/field-definitions/SettingsPage.deep.test.tsx",
    "src/field-definitions/panels/OrderTypesPanel.deep.test.tsx",
    "src/field-definitions/panels/PoolsPanel.deep.test.tsx",
    "src/pools/FundsPage.deep.test.tsx",
    "src/users/UsersPanel.deep.test.tsx",
  ],
  support: [
    "src/customers/CustomersPage.deep.test.tsx",
    "src/attachments/AttachmentPanel.deep.test.tsx",
    "src/audit/AuditPanel.deep.test.tsx",
    "src/quality/QualityPanel.deep.test.tsx",
    "src/rebates/RebatesPanel.deep.test.tsx",
    "src/reporting/ReportsPage.deep.test.tsx",
  ],
};

const shard = process.argv[2];
if (!shard || !Object.hasOwn(SHARDS, shard)) {
  console.error(`用法：npm run test:react-deep:shard -- <${Object.keys(SHARDS).join("|")}>`);
  process.exit(2);
}

const files = SHARDS[shard];
const missing = files.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`deep 分片 ${shard} 包含不存在的测试文件：\n${missing.join("\n")}`);
  process.exit(2);
}

const runner = process.platform === "win32" ? "npx.cmd" : "npx";
console.log(`react-deep 分片 ${shard}：${files.length} 个文件`);
const child = spawn(
  runner,
  ["vitest", "run", "--project=react-deep", "--retry=0", "--reporter=dot", ...files],
  { stdio: "inherit", env: process.env },
);

child.on("error", (error) => {
  console.error(`无法启动 react-deep 分片 ${shard}：${error.message}`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  if (code !== 0) {
    console.error(`react-deep 分片 ${shard} 失败：${code ?? signal}`);
    process.exitCode = code ?? 1;
  } else {
    console.log(`react-deep 分片 ${shard} 通过`);
  }
});
