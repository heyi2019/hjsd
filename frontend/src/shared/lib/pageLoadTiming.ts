type Timing = {
  label: string;
  root: HTMLElement;
  startedAt: number;
  pending: number;
  failures: number;
  lastActivity: number;
  lastPaint: number;
  observer: MutationObserver;
  quietTimer?: number;
  deadlineTimer?: number;
  frame?: number;
};

const QUIET_MS = 200;
const MAX_WAIT_MS = 30_000;
let current: Timing | null = null;

function cancel(timing: Timing) {
  timing.observer.disconnect();
  window.clearTimeout(timing.quietTimer);
  window.clearTimeout(timing.deadlineTimer);
  if (timing.frame !== undefined) window.cancelAnimationFrame(timing.frame);
  if (current === timing) current = null;
}

function isVisible(element: Element, root: HTMLElement) {
  for (let node: Element | null = element; node && node !== root; node = node.parentElement) {
    if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("hidden") || node.classList.contains("page-slot--hidden")) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function hasVisibleLoading(root: HTMLElement) {
  return Array.from(root.querySelectorAll(".page-loading, .ant-spin-spinning, .ant-skeleton-active, [aria-busy='true']"))
    .some((element) => isVisible(element, root));
}

function schedule(timing: Timing) {
  window.clearTimeout(timing.quietTimer);
  timing.quietTimer = window.setTimeout(() => {
    if (current !== timing) return;
    if (timing.pending || timing.frame !== undefined || hasVisibleLoading(timing.root) || performance.now() - timing.lastActivity < QUIET_MS) {
      schedule(timing);
      return;
    }
    const elapsed = Math.max(timing.lastPaint, timing.lastActivity) - timing.startedAt;
    const failures = timing.failures ? `，${timing.failures} 个请求失败` : "";
    console.info(`[页面加载计时] ${timing.label}：${(elapsed / 1000).toFixed(3)} 秒${failures}`);
    cancel(timing);
  }, QUIET_MS);
}

function activity(timing: Timing) {
  if (current !== timing) return;
  timing.lastActivity = performance.now();
  if (timing.frame !== undefined) window.cancelAnimationFrame(timing.frame);
  timing.frame = window.requestAnimationFrame(() => {
    timing.frame = window.requestAnimationFrame(() => {
      if (current === timing) timing.lastPaint = performance.now();
      timing.frame = undefined;
    });
  });
  schedule(timing);
}

/** 页面进入后跟踪前台请求和界面更新，仅向浏览器控制台输出。 */
export function startPageLoadTiming(label: string, root: HTMLElement, startedAt = performance.now()) {
  if (current) cancel(current);
  const observer = new MutationObserver((mutations) => {
    if (mutations.some(({ target }) => {
      const element = target instanceof Element ? target : target.parentElement;
      return element && !element.closest(".page-slot--hidden");
    })) activity(timing);
  });
  const timing: Timing = {
    label, root, startedAt, pending: 0, failures: 0,
    lastActivity: performance.now(), lastPaint: performance.now(), observer,
  };
  current = timing;
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden", "aria-busy", "aria-hidden"] });
  timing.deadlineTimer = window.setTimeout(() => {
    if (current !== timing) return;
    console.warn(`[页面加载计时] ${label}：超过 30 秒仍未稳定`);
    cancel(timing);
  }, MAX_WAIT_MS);
  activity(timing);
  return () => cancel(timing);
}

/** 只跟踪计时窗口内的请求；切页后旧请求不会影响新页面。 */
export function trackPageLoadRequest() {
  const timing = current;
  if (!timing) return null;
  timing.pending += 1;
  activity(timing);
  let finished = false;
  return (failed: boolean) => {
    if (finished) return;
    finished = true;
    timing.pending -= 1;
    if (failed) timing.failures += 1;
    activity(timing);
  };
}
