import { useEffect, useState, type DragEvent } from "react";
import { FileCode2, FilePlus, FileText, FolderOpen, Keyboard, X } from "lucide-react";
import type { AppModule, Tab } from "../types";
import { TabbedLayout } from "../../shell/TabbedLayout";
import { useWorkbench } from "../../store/workbench";
import { t, useT } from "../../store/lang";
import { listNav, rowKey } from "../../shell/listNav";
import { Modal } from "../../shell/Modal";
import { EditorTab } from "./EditorTab";
import { ShortcutsHost, openShortcuts } from "./ShortcutsModal";
import type { ActionId } from "./keys";
import {
  answerSave, duplicateDoc, flushDrafts, getDoc, newDoc, onTabsChanged, openDialog, openDropped, openPath, removeRecent, restoreSession,
  useRecent, useSaveAsk,
} from "./store";
import { DefaultAppCard, takePendingFiles } from "./defaultApp";

/** Tab nhân bản (menu "Duplicate" của thanh tab: id `<gốc>~<uid>`) → mở tab mới với cùng nội dung rồi bỏ tab nhân bản. */
function TabView({ tab }: { tab: Tab }) {
  const missing = !getDoc(tab.id);
  useEffect(() => {
    if (!missing) return;
    const base = tab.id.split("~")[0];
    useWorkbench.getState().closeTab(tab.id);
    if (base !== tab.id) duplicateDoc(base);
  }, [missing, tab.id]);
  if (missing) return null;
  return <EditorTab tab={tab} />;
}

/** Hỏi khi đóng tab chưa lưu: Lưu / Không lưu / Huỷ. */
function SaveAskHost() {
  const ask = useSaveAsk();
  const tr = useT();
  if (!ask) return null;
  return (
    <Modal title={tr("editor.saveAskTitle")} width={440} onClose={() => answerSave("cancel")}>
      <div className="form">
        <div>{tr("editor.saveAskMsg", { name: ask.name })}</div>
        <div className="toolbar">
          <span className="grow" />
          <button onClick={() => answerSave("cancel")}><X />{tr("editor.cancel")}</button>
          <button className="danger" onClick={() => answerSave("discard")}>{tr("editor.dontSave")}</button>
          <button className="primary" autoFocus onClick={() => answerSave("save")}>{tr("editor.aSave")}</button>
        </div>
      </div>
    </Modal>
  );
}

function Home() {
  const tr = useT();
  const recent = useRecent();
  return (
    <div className="pdf-home">
      <div className="pdf-home-inner">
        <div className="pdf-home-head">
          <FileCode2 className="pdf-home-ic ed-home-ic" />
          <div>
            <h2>{tr("apps.editor.title")}</h2>
            <div className="muted">{tr("editor.homeHint")}</div>
          </div>
        </div>
        <div className="toolbar pdf-wrap">
          <button className="primary" onClick={() => newDoc()}><FilePlus />{tr("editor.aNew")}</button>
          <button onClick={() => void openDialog()}><FolderOpen />{tr("editor.aOpen")}</button>
          <button onClick={openShortcuts}><Keyboard />{tr("editor.aShortcuts")}</button>
        </div>
        {recent.length > 0 && (
          <div className="pdf-card">
            <div className="pdf-card-title"><span className="grow">{tr("editor.recent")}</span></div>
            <div className="side-list pdf-recent" onKeyDown={(e) => listNav(e, { row: ".pdf-recent-row" })}>
              {recent.map((r) => (
                <div key={r.path} className="side-item pdf-recent-row" tabIndex={0} title={r.path}
                  onClick={() => void openPath(r.path).then((ok) => { if (!ok) removeRecent(r.path); })}
                  onKeyDown={(e) => rowKey(e, { Enter: () => void openPath(r.path), Delete: () => removeRecent(r.path) })}>
                  <FileText />
                  <span className="grow ellipsis">{r.path.replace(/^.*[\\/]/, "")}</span>
                  <span className="muted small ellipsis">{r.path}</span>
                  <button className="icon-btn row-actions" title={tr("editor.removeRecent")} onClick={(e) => { e.stopPropagation(); removeRecent(r.path); }}><X /></button>
                </div>
              ))}
            </div>
          </div>
        )}
        <DefaultAppCard />
      </div>
    </div>
  );
}

function EditorApp() {
  const tabs = useWorkbench((s) => s.apps.editor.tabs);
  const [drag, setDrag] = useState(false);

  // Mở lại phiên trước (tab + bản nháp chưa lưu), rồi file được mở từ Explorer (nếu có).
  useEffect(() => { void restoreSession().then(() => takePendingFiles()); }, []);
  // Tab đóng / đổi thứ tự → dọn doc + ghi phiên.
  useEffect(() => { onTabsChanged(new Set(tabs.map((x) => x.id))); }, [tabs]);
  // Tắt cửa sổ: ghi ngay bản nháp đang chờ (không hỏi — mở lại vẫn còn).
  useEffect(() => {
    window.addEventListener("beforeunload", flushDrafts);
    return () => window.removeEventListener("beforeunload", flushDrafts);
  }, []);
  // Ctrl+N / Ctrl+O / F1 khi chưa focus vào ô soạn (màn hình chính, thanh tab…). Ô soạn tự xử lý (preventDefault).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || useWorkbench.getState().activeApp !== "editor") return;
      if ((e.target as HTMLElement).closest("input, textarea, .cm-editor")) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === "n") { e.preventDefault(); newDoc(); }
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === "o") { e.preventDefault(); void openDialog(); }
      else if (e.key === "F1") { e.preventDefault(); openShortcuts(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
  return (
    <div className={`ed-app ${drag ? "file-drop" : ""}`}
      onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => { if (!hasFiles(e)) return; e.preventDefault(); setDrag(false); void openDropped(e.dataTransfer.files); }}>
      <TabbedLayout appId="editor" TabView={TabView} empty={<Home />} />
      <SaveAskHost />
      <ShortcutsHost />
    </div>
  );
}

/** Gửi hành động tới tab Editor đang mở (lệnh trong Ctrl+G). */
const toActive = (action: ActionId) => () => {
  const tabId = useWorkbench.getState().apps.editor.activeTabId;
  if (tabId) window.dispatchEvent(new CustomEvent("ds-editor-action", { detail: { tabId, action } }));
};

const app: AppModule = {
  View: EditorApp,
  commands: () => [
    { id: "editor.new", title: t("editor.aNew"), group: "Editor", hint: "Ctrl+N", run: () => void newDoc() },
    { id: "editor.open", title: t("editor.aOpen"), group: "Editor", hint: "Ctrl+O", run: () => void openDialog() },
    { id: "editor.save", title: t("editor.aSave"), group: "Editor", hint: "Ctrl+S", run: toActive("save") },
    { id: "editor.format", title: t("editor.aFormat"), group: "Editor", hint: "Ctrl+Shift+F", run: toActive("format") },
    { id: "editor.minify", title: t("editor.aMinify"), group: "Editor", hint: "Ctrl+Shift+M", run: toActive("minify") },
    { id: "editor.validate", title: t("editor.aValidate"), group: "Editor", hint: "Ctrl+Alt+V", run: toActive("validate") },
    { id: "editor.b64d", title: t("editor.aB64Decode"), group: "Editor", hint: "Ctrl+Alt+B", run: toActive("b64decode") },
    { id: "editor.b64e", title: t("editor.aB64Encode"), group: "Editor", hint: "Ctrl+Alt+Shift+B", run: toActive("b64encode") },
    { id: "editor.jwt", title: t("editor.aJwtDecode"), group: "Editor", hint: "Ctrl+Alt+J", run: toActive("jwtDecode") },
    { id: "editor.keys", title: t("editor.aShortcuts"), group: "Editor", hint: "F1", run: openShortcuts },
  ],
};
export default app;
