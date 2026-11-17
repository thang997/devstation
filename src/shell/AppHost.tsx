import { Component, Suspense, use, useMemo, useState, type ReactNode } from "react";
import { appById, loadApp } from "../apps/registry";
import type { AppId } from "../apps/types";
import { t, useT, type TKey } from "../store/lang";
import { ModalLayerContext } from "./Modal";

/**
 * Vỏ của một mini app: tự tải code khi mount lần đầu, chiếm toàn bộ vùng làm việc,
 * và có error boundary riêng để app này lỗi không kéo sập các app khác.
 */
export function AppHost({ id, active }: { id: AppId; active: boolean }) {
  const m = appById(id);
  const tr = useT();
  // Lớp modal riêng của app (xem ModalLayerContext): modal chỉ phủ vùng app, không chặn thanh tab app.
  const [layerEl, setLayerEl] = useState<HTMLDivElement | null>(null);
  const layer = useMemo(() => ({ el: layerEl }), [layerEl]);
  return (
    <div className="app-host" hidden={!active}>
      <ModalLayerContext.Provider value={layer}>
        <AppErrorBoundary title={m.title}>
          <Suspense fallback={<div className="empty">{tr("shell.loading")} {m.icon} {tr(`apps.${id}.title` as TKey)}…</div>}>
            <AppView id={id} />
          </Suspense>
        </AppErrorBoundary>
      </ModalLayerContext.Provider>
      <div className="app-modal-layer" ref={setLayerEl} />
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
        <div className="error-box">⚠ {this.props.title} {t("shell.crashed")} {this.state.error.message}</div>
        <button onClick={() => this.setState({ error: null })}>{t("shell.retry")}</button>
      </div>
    );
  }
}
