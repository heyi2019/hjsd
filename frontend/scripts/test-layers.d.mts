/** test-layers.mjs 的类型声明。
 *
 * 该 .mjs 是分层清单的单一事实源（vitest.config.ts / test-full-sharded.mjs /
 * manifest-parity.test.ts 共用）。tsconfig.json 开了 strict 且 allowJs=false，
 * 从 tests/frontend/** 以相对路径导入 .mjs 会触发 TS7016；补同名 .d.mts 是
 * TypeScript 对 .mjs 的标准声明解析路径（.mjs ↔ .d.mts），无需放宽 strict，
 * 也不把 .mjs 纳入 include（那会改变构建产物与 UI 守卫的扫描面）。
 *
 * 清单内容仍只在 test-layers.mjs 维护，本文件只声明形状，禁止复制常量值。
 */
export declare const fastTests: string[];
export declare const quickTests: string[];
export declare const globToRegExp: (pattern: string) => RegExp;
export declare const matchesAny: (file: string, patterns: string[]) => boolean;
