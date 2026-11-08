import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 仅在出错时用于日志标识（页面键），方便定位是哪个页面崩溃。 */
  name?: string;
}
interface State {
  error: Error | null;
}

/**
 * 模块加载类失败：动态 import 的 chunk 请求失败 / 被中断。
 * `React.lazy` 会把首次失败缓存为终态（status=rejected），进程内不会自行重试，
 * 所以这类错误**无法靠重置 state 恢复**；接口变更后的
 * chunk 也会落到同一分支。判定只认模块相关字样，避免把普通 `Failed to fetch`
 *（接口 500/断网）误当成模块失败而整页重载。
 */
const MODULE_LOAD_ERROR =
  /dynamically imported module|loading dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError/i;

export function isModuleLoadError(error: Error | null | undefined): boolean {
  if (!error) return false;
  return MODULE_LOAD_ERROR.test(`${error.name}: ${error.message}`);
}

/**
 * 页面级错误边界：单个页面渲染抛错时只在此边界内显示降级 UI，
 * 不向上冒泡到 AppShell 导致整个应用外壳（侧栏/顶栏）白屏。
 * 与 AppShell 的 keep-alive 配合：崩溃的页面 slot 被本边界接住，
 * 其它已挂载页面不受影响，用户可切走再切回或点「重试」恢复。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.name ?? "page"}]`, error, info.componentStack);
  }

  private handleRetry = (): void => {
    // 模块加载失败是进程内不可恢复的：React.lazy 缓存了 rejected promise，只清 state
    // 会在下次 render 立刻再抛同一个错，用户被永久困在降级卡里（点几次都一样）。
    // 整页重载是唯一有效路径——生产重新取 chunk，开发让 vite 重建模块图。
    if (isModuleLoadError(this.state.error)) {
      window.location.reload();
      return;
    }
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      const moduleError = isModuleLoadError(error);
      return (
        <div className="page-error-boundary" role="alert">
          <div className="page-error-boundary__title">页面渲染出错</div>
          <p className="page-error-boundary__msg">
            {import.meta.env.DEV
              ? (error.message || "未知错误")
              : moduleError
                ? "页面资源已更新或加载中断，请点「重新加载」获取最新版本。"
                : "页面出现意外错误，请点「重试」恢复；若反复出现请联系管理员。"}
          </p>
          <button
            type="button"
            className="ui-button ui-button--primary"
            onClick={this.handleRetry}
          >
            {moduleError ? "重新加载" : "重试"}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
