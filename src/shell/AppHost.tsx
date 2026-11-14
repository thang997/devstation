import { Component, Suspense, use, type ReactNode } from "react";
import { appById, loadApp } from "../apps/registry";
import type { AppId } from "../apps/types";

/**
 * Vỏ của một mini app: tự tải code khi mount lần đầu, chiếm toàn bộ vùng làm việc,
 * và có error boundary riêng để app này lỗi không kéo sập các app khác.
 */
export function AppHost({ id, active }: { id: AppId; active: boolean }) {
  const m = appById(id);
  return (
    <div className="app-host" hidden={!active}>
      <AppErrorBoundary title={m.title}>
        <Suspense fallback={<div className="empty">Đang tải {m.icon} {m.title}…</div>}>
          <AppView id={id} />
        </Suspense>
      </AppErrorBoundary>
    </div>
  );
}

function AppView({ id }: { id: AppId }) {
  const { View } = use(loadApp(id));
  return <View />;
}

class AppErrorBoundary extends Component<{ title: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="welcome">
        <div className="error-box">⚠ {this.props.title} gặp lỗi: {this.state.error.message}</div>
        <button onClick={() => this.setState({ error: null })}>Thử lại</button>
      </div>
    );
  }
}
