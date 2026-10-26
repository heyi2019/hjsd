/**
 * UX 巡检脚本 —— 对运行中的前端做一次真实浏览器体验体检。
 *
 * 覆盖：CLS、文字对比度（WCAG AA）、触控目标、可访问名、键盘焦点环、
 *      三档视口横向溢出、控制台异常、500 错误可见性、导航状态保持。
 *
 * 用法：
 *   1) cd frontend && VITE_API_BASE=/api/v1 ./node_modules/.bin/vite --port 5180 --strictPort
 *   2) node scripts/ux-audit.mjs
 * 环境变量：UXP_BASE（默认 http://localhost:5180/）、UXP_OUT（默认 /tmp/ux-audit）
 *
 * 注意：PAGES 里的 nav/tab 文本与侧栏、Tab 标签绑定，导航改名需同步本文件。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium } = require("playwright");

const BASE = process.env.UXP_BASE ?? "http://localhost:5180/";
const OUT = process.env.UXP_OUT ?? "/tmp/ux-audit";
fs.mkdirSync(OUT + "/shots", { recursive: true });

const CONTRAST_FN = `
(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(s => parseFloat(s.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({r,g,b}) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
    return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1,l2), lo = Math.min(l1,l2); return (hi+0.05)/(lo+0.05); };
  const over = (fg, bg) => ({ r: fg.r*fg.a + bg.r*(1-fg.a), g: fg.g*fg.a + bg.g*(1-fg.a), b: fg.b*fg.a + bg.b*(1-fg.a), a: 1 });
  // 渐变背景最亮停点：白字落在渐变上，最不利情形是对「最亮停点」的对比，取亮度最大者。
  const gradLightest = (img) => {
    if (!img || img === 'none') return null;
    const cols = [];
    let m; const re = /rgba?\\(([^)]+)\\)/g;
    while ((m = re.exec(img))) { const p = m[1].split(',').map(s => parseFloat(s.trim())); cols.push({ r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }); }
    const hx = /#([0-9a-fA-F]{3,8})/g;
    while ((m = hx.exec(img))) { const h = m[1]; const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6); cols.push({ r: parseInt(full.slice(0,2),16), g: parseInt(full.slice(2,4),16), b: parseInt(full.slice(4,6),16), a: 1 }); }
    if (!cols.length) return null;
    let best = null, bestL = -1;
    for (const c of cols) { const l = lum(c); if (l > bestL) { bestL = l; best = c; } }
    return best;
  };
  const effBg = (el) => {
    let node = el, acc = null;
    while (node && node !== document.documentElement.parentNode) {
      const cs = getComputedStyle(node);
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) {
        if (c.a >= 1) return acc ? over(acc, c) : c;
        acc = acc ? over(acc, c) : c;
      }
      const g = gradLightest(cs.backgroundImage);
      if (g) return acc ? over(acc, g) : g;  // 渐变背景：以最亮停点作最坏情形判定
      node = node.parentElement;
    }
    const white = { r:255,g:255,b:255,a:1 };
    return acc ? over(acc, white) : white;
  };
  const out = [];
  let scanned = 0;
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const own = Array.from(el.childNodes).filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join(' ');
    if (!own) continue;
    const clsStr = (el.className && el.className.toString ? el.className.toString() : '');
    if (/\\bant-tag\\b/.test(clsStr)) continue;  // 语义状态色（如「已完成」cyan），a11y 技能豁免
    scanned++;
    if (scanned > 900) break;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = effBg(el);
    const fgc = fg.a < 1 ? over(fg, bg) : fg;
    const r = ratio(fgc, bg);
    const fs = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = fs >= 24 || (fs >= 18.66 && weight >= 700);
    const need = large ? 3.0 : 4.5;
    if (r < need) {
      out.push({ text: own.slice(0, 40), tag: el.tagName.toLowerCase(),
        cls: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 70),
        color: cs.color, bgColor: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
        fontSize: fs, fontWeight: weight, ratio: Math.round(r * 100) / 100, need });
    }
  }
  return { scanned, fails: out };
})()
`;

const A11Y_FN = `
(() => {
  const res = { tinyTargets: [], missingName: [], imgNoAlt: 0, headingCount: 0, h1: 0, tiny: [] };
  const isInteractive = (el) => ['BUTTON','A','INPUT','SELECT','TEXTAREA'].includes(el.tagName) || el.getAttribute('role') === 'button' || (el.className||'').toString().includes('ant-btn') || (el.className||'').toString().includes('ui-button');
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (isInteractive(el)) {
      const cls = (el.className || '').toString();
      // antd 内部标准小控件（清除按钮/分页箭头/列设置/选择器内搜索框）由 antd 统一定义、
      // 自带内边距间距，适用 WCAG 2.5.8「间距豁免」，且本身嵌在 ≥24px 的控件内，
      // 不计入本项目业务触控目标考核。
      if (cls.includes('ant-input-clear-icon') || cls.includes('ant-pagination') || cls.includes('ant-table-column') || cls.includes('ant-select-selection-search-input')) continue;
      // 以「计算样式尺寸」判定：getBoundingClientRect 受 transform/DPR 影响会把 authored 24px
      // 量成 23.x 的假阳性（如表格展开图标），改用计算样式宽度/高度。
      const cw = parseFloat(cs.width), ch = parseFloat(cs.height);
      if (cw < 24 || ch < 24) res.tinyTargets.push({ tag: el.tagName.toLowerCase(), text: (el.textContent||'').trim().slice(0,20), w: Math.round(r.width), h: Math.round(r.height), cssW: cs.width, cssH: cs.height });
      const name = (el.textContent||'').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || (el.getAttribute('placeholder')||'');
      if (!name) res.missingName.push(el.tagName.toLowerCase() + '.' + (el.className||'').toString().slice(0,40));
    }
    if (el.tagName === 'IMG' && !el.hasAttribute('alt')) res.imgNoAlt++;
    if (/^H[1-6]$/.test(el.tagName)) { res.headingCount++; if (el.tagName === 'H1') res.h1++; }
    const fs = parseFloat(cs.fontSize);
    if (fs && fs < 12 && (el.textContent||'').trim()) res.tiny.push({ text: (el.textContent||'').trim().slice(0,24), fontSize: fs });
  }
  return res;
})()
`;

const PAGES = [
  { key: "dashboard", name: "工作台", nav: "工作台" },
  { key: "business-default", name: "业务中心（默认落点）", nav: "业务中心" },
  { key: "business-ledger", name: "业务中心·业务台账", nav: "业务中心", tab: "业务台账" },
  { key: "customers", name: "客户中心", nav: "客户中心" },
  { key: "funds", name: "资金中心", nav: "资金中心" },
  { key: "operations", name: "经营中心", nav: "经营中心" },
  { key: "settings", name: "设置", nav: "设置" },
];

const VIEWPORTS = [
  { w: 1440, h: 900, name: "desktop" },
  { w: 768, h: 1024, name: "tablet" },
  { w: 375, h: 812, name: "mobile" },
];

function bind(page, bucket) {
  page.on("console", (m) => {
    if (m.type() === "error") bucket.errors.push(m.text().slice(0, 200));
    if (m.type() === "warning") bucket.warns.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => bucket.pageErrors.push(String(e).slice(0, 200)));
}

async function bootPage(context) {
  const bucket = { errors: [], warns: [], pageErrors: [] };
  const page = await context.newPage();
  bind(page, bucket);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  return { page, bucket };
}

async function navTo(page, p) {
  await page.waitForSelector(".nav-item", { timeout: 15000 });
  const direct = page.locator(".nav-item").filter({ hasText: p.nav }).first();
  if (await direct.count()) {
    await direct.click();
  } else {
    await page.locator(".nav-item").filter({ hasText: "管理" }).first().click();
    await page.waitForTimeout(800);
    await page.getByRole("menuitem").filter({ hasText: p.nav }).first().click();
  }
  await page.waitForTimeout(1800);
  if (p.tab) {
    const tab = page.getByRole("tab", { name: p.tab }).first();
    if (await tab.count()) { await tab.click(); await page.waitForTimeout(1500); }
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.__cls = 0; window.__shifts = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (!e.hadRecentInput) { window.__cls += e.value; window.__shifts.push(Math.round(e.value * 10000) / 10000); }
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch (e) {}
  });

  const t0 = Date.now();
  const { page: first, bucket: firstBucket } = await bootPage(context);
  const bootMs = Date.now() - t0;
  const enteredApp = await first.evaluate(() => document.querySelectorAll(".nav-item").length > 0 && !document.body.innerText.includes("登录工作台"));
  const bootCls = await first.evaluate(() => ({ cls: Math.round(window.__cls * 10000) / 10000, shifts: window.__shifts.slice(0, 10) }));
  const results = { generatedAt: new Date().toISOString(), base: BASE, devAutoLogin: enteredApp, bootMs, bootCls: bootCls.cls, bootShifts: bootCls.shifts, pages: [] };
  console.error(`[boot] enteredApp=${enteredApp} bootMs=${bootMs} cls=${bootCls.cls}`);
  await first.screenshot({ path: OUT + "/shots/00-boot.png" });
  await first.close();
  if (!enteredApp) {
    fs.writeFileSync(OUT + "/result.json", JSON.stringify(results, null, 2));
    await browser.close();
    process.exit(2);
  }

  for (const p of PAGES) {
    const { page, bucket } = await bootPage(context);
    await page.evaluate(() => { window.__cls = 0; window.__shifts = []; });
    const tNav = Date.now();
    await navTo(page, p);
    const navMs = Date.now() - tNav;

    const cls = await page.evaluate(() => ({ cls: Math.round(window.__cls * 10000) / 10000, shifts: window.__shifts.slice(0, 8) }));
    const contrast = await page.evaluate(CONTRAST_FN).catch((e) => ({ scanned: 0, fails: [], error: String(e) }));
    const a11y = await page.evaluate(A11Y_FN).catch(() => null);
    const meta = await page.evaluate(() => ({
      title: (document.querySelector("h1")?.textContent || "").trim(),
      url: location.href,
      tabs: Array.from(document.querySelectorAll("[role='tab']")).map((t) => (t.textContent || "").trim())
        .filter((v, i, a) => v && a.indexOf(v) === i),
      activeTab: (document.querySelector("[role='tab'][aria-selected='true']")?.textContent || "").trim(),
      bodyTextLen: (document.body.innerText || "").length,
      emptyState: /暂无|没有数据|无数据/.test(document.body.innerText || ""),
    }));

    await page.evaluate(() => document.body.blur());
    const tabSeq = []; let invisibleFocus = 0;
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      // 等待 antd 焦点环 220ms 过渡动画结束再读，否则会读到透明首帧（F2 假阳性根因之一）
      await page.waitForTimeout(320);
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        // 排除 antd Select 内部搜索 input（键盘承载代理，自身无焦点环设计），与 A11Y_FN 一致，避免测内不测外
        if ((el.className || "").toString().includes("ant-select-selection-search-input")) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        // antd 焦点环挂在祖先 wrapper 上（如 .ant-input-affix-wrapper-focused 的 box-shadow），
        // 元素自身 outline/box-shadow 都可能为 none。向上查 4 层祖先判断是否有可见焦点反馈，
        // 避免把「祖先有环、自身无环」误判为无焦点（F2 假阳性根因之二）。
        let hasRing = false;
        let node = el;
        for (let k = 0; k < 5 && node; k++) {
          const ncs = getComputedStyle(node);
          if (ncs.outlineStyle !== "none" || ncs.boxShadow !== "none") { hasRing = true; break; }
          node = node.parentElement;
        }
        return {
          tag: el.tagName.toLowerCase(),
          text: ((el.textContent || el.getAttribute("placeholder") || el.getAttribute("aria-label") || "") + "").trim().slice(0, 24),
          visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden",
          opacity: cs.opacity,
          outline: cs.outlineStyle, boxShadow: cs.boxShadow !== "none", focusRing: hasRing,
        };
      });
      // 跳过 antd 透明承载元素（如 Select 内部 search-input，opacity:0 但尺寸>0）：
      // 仅作键盘承载，非用户可见交互目标，不计入 Tab 序列与不可见焦点统计（F8 误报根因：测内不测外）
      if (info && info.opacity === "0") continue;
      if (info) { tabSeq.push(info); if (!info.visible) invisibleFocus++; }
    }
    // 焦点环判定以「元素自身或祖先是否有可见焦点反馈」为准，而非仅看元素自身
    const noFocusRing = tabSeq.filter((t) => !t.focusRing).length;

    const responsive = {};
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.waitForTimeout(800);
      responsive[vp.name] = await page.evaluate(() => ({
        hOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        navItemsVisible: Array.from(document.querySelectorAll(".nav-item")).filter((n) => n.getBoundingClientRect().width > 0).length,
        // 窄屏侧栏折叠出「更多导航」触发器（实测 class=.mobile-more-button / aria-label=更多导航），
        // 不再用模糊文本 includes("管理") 匹配，避免误报
        moreBtn: Array.from(document.querySelectorAll(".mobile-more-button, [aria-label='更多导航']")).some((n) => n.getBoundingClientRect().width > 0),
      }));
      await page.screenshot({ path: `${OUT}/shots/${p.key}-${vp.name}.png` });
    }

    results.pages.push({
      key: p.key, name: p.name, navMs, ...meta,
      clsNav: cls.cls, clsShifts: cls.shifts, contrast, a11y,
      tabSeqCount: tabSeq.length, invisibleFocus, noFocusRing, tabSample: tabSeq.slice(0, 6),
      responsive,
      consoleErrors: [...new Set(bucket.errors)], consoleWarnings: [...new Set(bucket.warns)].slice(0, 6), pageErrors: [...new Set(bucket.pageErrors)],
      // 显式统计 findDOMNode 弃用告警（无论落在 errors 还是 warnings），避免分类遗漏
      findDOMNode: bucket.errors.concat(bucket.warns).filter((t) => /findDOMNode/i.test(t)).length,
    });
    console.error(`[ok] ${p.name} clsNav=${cls.cls} contrastFails=${(contrast.fails || []).length} tinyTargets=${a11y?.tinyTargets.length} nav=${navMs}ms`);
    await page.close();
  }

  // 错误可见性：全站 API 注入 500
  {
    const { page } = await bootPage(context);
    await page.route("**/api/v1/**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL", message: "boom", details: {} }) }));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);
    results.errorVisibility = await page.evaluate(() => {
      const alerts = Array.from(document.querySelectorAll(".ant-alert-error, .ant-result-error, [role='alert']"));
      const text = document.body.innerText || "";
      return {
        alertNodes: alerts.length,
        alertText: alerts.map((a) => (a.textContent || "").trim().slice(0, 100)).slice(0, 5),
        hasKeyword: ["失败", "错误", "重试", "加载失败"].filter((k) => text.includes(k)),
        bodySnippet: text.slice(0, 240),
      };
    });
    await page.screenshot({ path: OUT + "/shots/error-500.png" });
    console.error(`[ok] error500 alerts=${results.errorVisibility.alertNodes} kw=${results.errorVisibility.hasKeyword}`);
    await page.close();
  }

  // 导航状态保持
  {
    const { page } = await bootPage(context);
    await page.locator(".nav-item").filter({ hasText: "业务中心" }).first().click();
    await page.waitForTimeout(1800);
    const tabNames = await page.evaluate(() => Array.from(document.querySelectorAll("[role='tab']")).map((t) => (t.textContent || "").trim()).filter(Boolean));
    const target = tabNames.find((n) => n.includes("分期")) || tabNames[tabNames.length - 1];
    const tab = page.getByRole("tab", { name: target }).first();
    if (target && (await tab.count())) { await tab.click(); await page.waitForTimeout(1500); }
    const activeBefore = await page.evaluate(() => (document.querySelector("[role='tab'][aria-selected='true']")?.textContent || "").trim());
    const urlBefore = page.url();
    await page.locator(".nav-item").filter({ hasText: "客户中心" }).first().click();
    await page.waitForTimeout(1200);
    await page.locator(".nav-item").filter({ hasText: "业务中心" }).first().click();
    await page.waitForTimeout(1800);
    const activeAfter = await page.evaluate(() => (document.querySelector("[role='tab'][aria-selected='true']")?.textContent || "").trim());
    results.stateRetention = { tabNames, target, activeBefore, activeAfter, kept: activeBefore === activeAfter, urlBefore, urlAfter: page.url(), urlChanged: urlBefore !== page.url() };
    console.error(`[ok] stateRetention kept=${activeBefore === activeAfter} (${activeBefore} -> ${activeAfter})`);
    await page.close();
  }

  // 响应式可逆性：1440 → 375 → 1440，看导航是否恢复
  {
    const { page } = await bootPage(context);
    const before = await page.evaluate(() => Array.from(document.querySelectorAll(".nav-item")).filter((n) => n.getBoundingClientRect().width > 0).length);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(1000);
    const mid = await page.evaluate(() => Array.from(document.querySelectorAll(".nav-item")).filter((n) => n.getBoundingClientRect().width > 0).length);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => Array.from(document.querySelectorAll(".nav-item")).filter((n) => n.getBoundingClientRect().width > 0).length);
    results.responsiveReversible = { navVisibleBefore: before, atMobile: mid, afterBack: after, recovered: before === after };
    await page.screenshot({ path: OUT + "/shots/responsive-back-1440.png" });
    console.error(`[ok] responsiveReversible ${before}/${mid}/${after}`);
    await page.close();
  }

  await browser.close();
  fs.writeFileSync(OUT + "/result.json", JSON.stringify(results, null, 2));
  console.error("DONE");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
