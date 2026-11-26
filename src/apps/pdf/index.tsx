import { useEffect, useState, type DragEvent } from "react";
import { BadgeCheck, FileText, TriangleAlert, FolderOpen, Settings, Star, Trash2, Unlink, X } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import type { AppModule } from "../types";
import { TabbedLayout } from "../../shell/TabbedLayout";
import { useWorkbench } from "../../store/workbench";
import { t, useT } from "../../store/lang";
import { listNav, rowKey } from "../../shell/listNav";
import { confirmDialog } from "../../shell/confirm";
import { pdfApi, type DefaultStatus } from "./api";
import { PdfTab } from "./PdfView";
import { TrustManagerModal } from "./SigDetails";
import { clearRecent, openDroppedFiles, openPdfDialog, openPdfPath, pruneDocs, removeRecent, setDefaultPdfApp, takePending, useRecent } from "./store";

// Đóng tab → bỏ byte của file khỏi RAM.
useWorkbench.subscribe((s, prev) => {
  if (s.apps.pdf.tabs !== prev.apps.pdf.tabs) pruneDocs(new Set(s.apps.pdf.tabs.map((x) => x.id)));
});

// File mở từ Explorer: lấy hàng đợi khi module nạp + mỗi khi cửa sổ khác báo có file mới.
if (isTauri()) {
  void takePending();
  // Chỉ khi được báo đích danh (cửa sổ này chứa app PDF) — không nghe toàn cục kẻo mọi cửa sổ PDF tranh nhau lấy file.
  window.addEventListener("ds-pdf-pending", () => void takePending());
  void import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().listen("pdf-pending", () => void takePending())).catch(() => {});
}

/** Thẻ "app PDF mặc định" (Windows). */
function DefaultCard() {
  const tr = useT();
  const [st, setSt] = useState<DefaultStatus | null>(null);
  const reload = () => void pdfApi.defaultStatus().then(setSt).catch(() => setSt(null));
  useEffect(() => {
    reload();
    // Người dùng chọn xong trong hộp thoại Windows rồi quay lại app → đọc lại trạng thái.
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, []);
  if (!st?.supported) return null;
  const register = async () => {
    const r = await setDefaultPdfApp();
    if (r) setSt(r); else reload();
  };
  const unregister = async () => {
    if (!(await confirmDialog({ title: tr("pdf.unregisterTitle"), message: tr("pdf.unregisterConfirm"), confirmLabel: tr("pdf.unregister") }))) return;
    try { await pdfApi.unregisterDefault(); reload(); }
    catch (e) { useWorkbench.getState().log(`✗ ${String(e)}`); }
  };
  return (
    <div className="pdf-card">
      <div className="pdf-card-title"><Star />{tr("pdf.defaultTitle")}</div>
      <div className="muted small">
        {st.isDefault ? tr("pdf.defaultIs") : st.registered ? tr("pdf.defaultRegisteredNot") : tr("pdf.defaultNot")}
      </div>
      <div className="toolbar pdf-wrap">
        {!st.isDefault && <button className="primary" onClick={() => void register()}><Star />{tr("pdf.setDefault")}</button>}
        {st.registered && <button onClick={() => void pdfApi.openSettings()}><Settings />{tr("pdf.openDefaultApps")}</button>}
        {st.registered && <button onClick={() => void unregister()}><Unlink />{tr("pdf.unregister")}</button>}
      </div>
      {!st.isDefault && <div className="muted small">{tr("pdf.defaultHint")}</div>}
      {st.dev && <div className="small pdf-dev-note"><TriangleAlert />{tr("pdf.defaultDev")}</div>}
    </div>
  );
}

function Home() {
  const tr = useT();
  const recent = useRecent();
  const [trustOpen, setTrustOpen] = useState(false);
  return (
    <div className="pdf-home">
      <div className="pdf-home-inner">
        <div className="pdf-home-head">
          <FileText className="pdf-home-ic" />
          <div>
            <h2>{tr("apps.pdf.title")}</h2>
            <div className="muted">{tr("pdf.homeHint")}</div>
          </div>
        </div>
        <div className="toolbar pdf-wrap">
          <button className="primary" onClick={() => void openPdfDialog()}><FolderOpen />{tr("pdf.openFile")}</button>
          <button onClick={() => setTrustOpen(true)}><BadgeCheck />{tr("pdf.trustManager")}</button>
        </div>
        {recent.length > 0 && (
          <div className="pdf-card">
            <div className="pdf-card-title">
              <span className="grow">{tr("pdf.recent")}</span>
              <button className="icon-btn" title={tr("pdf.clearRecent")} aria-label={tr("pdf.clearRecent")} onClick={clearRecent}><Trash2 /></button>
            </div>
            <div className="side-list pdf-recent" onKeyDown={(e) => listNav(e, { row: ".pdf-recent-row" })}>
              {recent.map((r) => (
                <div key={r.path} className="side-item pdf-recent-row" tabIndex={0} title={r.path}
                  onClick={() => void openPdfPath(r.path).catch(() => removeRecent(r.path))}
                  onKeyDown={(e) => rowKey(e, { Enter: () => void openPdfPath(r.path).catch(() => removeRecent(r.path)), Delete: () => removeRecent(r.path) })}>
                  <FileText />
                  <span className="ellipsis grow">{r.name}</span>
                  <span className="muted small ellipsis pdf-recent-dir">{r.path.slice(0, r.path.length - r.name.length - 1)}</span>
                  <button className="icon-btn row-actions" title={tr("pdf.removeRecent")} aria-label={tr("pdf.removeRecent")} onClick={(e) => { e.stopPropagation(); removeRecent(r.path); }}><X /></button>
                </div>
              ))}
            </div>
          </div>
        )}
        <DefaultCard />
        <div className="muted small">{tr("pdf.dropHint")}</div>
      </div>
      {trustOpen && <TrustManagerModal onClose={() => setTrustOpen(false)} />}
    </div>
  );
}

function PdfApp() {
  const [drag, setDrag] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useWorkbench.getState().activeApp !== "pdf") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); void openPdfDialog(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
  return (
    <div className={`pdf-app ${drag ? "file-drop" : ""}`}
      onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => { if (!hasFiles(e)) return; e.preventDefault(); setDrag(false); void openDroppedFiles(e.dataTransfer.files); }}>
      <TabbedLayout appId="pdf" TabView={PdfTab} empty={<Home />} />
    </div>
  );
}

const app: AppModule = {
  View: PdfApp,
  commands: () => [
    { id: "pdf.open", title: t("pdf.openFile"), group: "PDF", hint: "Ctrl+O", run: () => void openPdfDialog() },
    { id: "pdf.default", title: t("pdf.setDefault"), group: "PDF", run: () => void setDefaultPdfApp() },
  ],
};
export default app;
