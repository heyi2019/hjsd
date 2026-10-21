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
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="page-error-boundary" role="alert">
          <div className="page-error-boundary__title">页面渲染出错</div>
          <p className="page-error-boundary__msg">
            {import.meta.env.DEV
              ? (this.state.error.message || "未知错误")
              : "页面出现意外错误，请点「重试」恢复；若反复出现请联系管理员。"}
          </p>
          <button
            type="button"
            className="ui-button ui-button--primary"
            onClick={this.handleRetry}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
