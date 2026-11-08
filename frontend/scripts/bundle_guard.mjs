import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, "../dist");
const assetsDir = path.join(distDir, "assets");
const MAX_CHUNK_BYTES = 600 * 1024;
const MAX_ENTRY_BYTES = 450 * 1024;
const MAX_INITIAL_RAW_BYTES = 950 * 1024;
const MAX_INITIAL_GZIP_BYTES = 350 * 1024;

const fail = (message) => {
  console.error(`Bundle 守卫未通过：${message}`);
  process.exit(1);
};

if (!fs.existsSync(path.join(distDir, "index.html")) || !fs.existsSync(assetsDir)) {
  fail("缺少 dist 构建产物，请先执行 npm run build（不含 bundle_guard）或 vite build");
}

const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
const entryMatch = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
if (!entryMatch) fail("index.html 未找到模块入口");

const assetFile = (assetPath) => path.join(distDir, assetPath.replace(/^\//, ""));
const assetBytes = (assetPath) => fs.statSync(assetFile(assetPath)).size;
const assetGzipBytes = (assetPath) => gzipSync(fs.readFileSync(assetFile(assetPath))).length;
const entryAsset = entryMatch[1];
const preloadAssets = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map((match) => match[1]);
const initialAssets = [entryAsset, ...preloadAssets];
const initialRawBytes = initialAssets.reduce((total, asset) => total + assetBytes(asset), 0);
const initialGzipBytes = initialAssets.reduce((total, asset) => total + assetGzipBytes(asset), 0);

const jsFiles = fs.readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
const oversized = jsFiles
  .map((name) => ({ name, bytes: fs.statSync(path.join(assetsDir, name)).size }))
  .filter(({ bytes }) => bytes > MAX_CHUNK_BYTES)
  .sort((a, b) => b.bytes - a.bytes);

if (assetBytes(entryAsset) > MAX_ENTRY_BYTES) {
  fail(`首屏入口 ${entryAsset} 为 ${(assetBytes(entryAsset) / 1024).toFixed(1)}KB，超过 ${MAX_ENTRY_BYTES / 1024}KB`);
}
if (initialRawBytes > MAX_INITIAL_RAW_BYTES) {
  fail(`首屏入口及预加载原始合计 ${(initialRawBytes / 1024).toFixed(1)}KB，超过 ${MAX_INITIAL_RAW_BYTES / 1024}KB`);
}
if (initialGzipBytes > MAX_INITIAL_GZIP_BYTES) {
  fail(`首屏入口及预加载 gzip 合计 ${(initialGzipBytes / 1024).toFixed(1)}KB，超过 ${MAX_INITIAL_GZIP_BYTES / 1024}KB`);
}
if (oversized.length > 0) {
  fail(`存在超过 ${MAX_CHUNK_BYTES / 1024}KB 的 JS chunk：${oversized.map(({ name, bytes }) => `${name} ${(bytes / 1024).toFixed(1)}KB`).join(", ")}`);
}

console.log(
  `Bundle 守卫通过：入口 ${(assetBytes(entryAsset) / 1024).toFixed(1)}KB，` +
  `首屏原始 ${(initialRawBytes / 1024).toFixed(1)}KB / gzip ${(initialGzipBytes / 1024).toFixed(1)}KB，` +
  `${jsFiles.length} 个 JS chunk 均未超过 ${MAX_CHUNK_BYTES / 1024}KB。`,
);
