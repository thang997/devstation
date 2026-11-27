/**
 * Thẻ "App mặc định" của Editor: từng đuôi file văn bản (.txt, .json, .xml…) hiện app đang mở nó; bấm "Đặt mặc định"
 * → Rust ghi đăng ký + mở hộp thoại "How do you want to open …?" của Windows (OpenWith.exe) cho đuôi đó.
 * Windows bắt chọn RIÊNG từng đuôi (không chọn gộp được) và không cho app tự đặt (UserChoice có hash) — giống app PDF:
 * đóng hộp thoại mà chưa thành mặc định → mở Settings → Default apps + hướng dẫn.
 */
import { useEffect, useState } from "react";
import { Settings, Star, TriangleAlert, Unlink } from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useT } from "../../store/lang";
import { useWorkbench } from "../../store/workbench";
import { confirmDialog } from "../../shell/confirm";
import { Spinner } from "../../shell/Loading";
import { openPath } from "./store";

interface ExtStatus { ext: string; isDefault: boolean; current: string }
interface TextDefaultStatus { supported: boolean; registered: boolean; dev: boolean; exts: ExtStatus[] }

const status = () => invoke<TextDefaultStatus>("editor_default_status");

/** File mở từ Explorer đang chờ (hàng đợi Rust). */
export async function takePendingFiles() {
  if (!isTauri()) return;
  const list = await invoke<string[]>("editor_take_pending").catch(() => [] as string[]);
  for (const p of list) await openPath(p);
}

// Rust / fileOpen.ts báo có file mới cho cửa sổ này.
if (isTauri()) {
  window.addEventListener("ds-editor-pending", () => void takePendingFiles());
  void import("@tauri-apps/api/webviewWindow")
    .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().listen("editor-pending", () => void takePendingFiles()))
    .catch(() => {});
}

export function DefaultAppCard() {
  const tr = useT();
  const [st, setSt] = useState<TextDefaultStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [guide, setGuide] = useState<string | null>(null);
  const reload = () => void status().then((s) => { setSt(s); if (guide && s.exts.find((e) => e.ext === guide)?.isDefault) setGuide(null); }).catch(() => setSt(null));
  useEffect(() => {
    if (!isTauri()) return;
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide]);
  if (!st?.supported) return null;
  const log = useWorkbench.getState().log;

  const setDefault = async (ext: string) => {
    if (busy) return;
    setBusy(ext);
    try {
      const s = await invoke<TextDefaultStatus>("editor_register_default", { ext });
      setSt(s);
      if (s.exts.find((e) => e.ext === ext)?.isDefault) {
        setGuide(null);
        log(`✓ ${tr("editor.defaultDone", { ext })}`);
      } else {
        setGuide(ext);
        log(`⚠ ${tr("editor.defaultNotChosen", { ext })}`);
        await invoke("pdf_open_settings").catch(() => {});
      }
    } catch (e) {
      log(`✗ ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const unregister = async () => {
    if (!(await confirmDialog({ title: tr("editor.unregisterTitle"), message: tr("editor.unregisterConfirm"), confirmLabel: tr("editor.unregister") }))) return;
    try { await invoke("editor_unregister_default"); reload(); } catch (e) { log(`✗ ${String(e)}`); }
  };

  return (
    <div className="pdf-card">
      <div className="pdf-card-title"><Star /><span className="grow">{tr("editor.defaultTitle")}</span></div>
      <div className="muted small">{tr("editor.defaultHint")}</div>
      <div className="ed-exts">
        {st.exts.map((e) => (
          <div key={e.ext} className={`ed-ext ${e.isDefault ? "on" : ""}`}>
            <b className="mono">{e.ext}</b>
            <span className="muted small ellipsis grow" title={e.current}>{e.isDefault ? tr("editor.isDefaultShort") : e.current || tr("editor.noApp")}</span>
            {!e.isDefault && (
              <button disabled={!!busy} onClick={() => void setDefault(e.ext)} title={tr("editor.setDefaultFor", { ext: e.ext })}>
                {busy === e.ext ? <Spinner /> : <Star />}{tr("editor.setDefault")}
              </button>
            )}
          </div>
        ))}
      </div>
      {guide && (
        <div className="pdf-guide small">
          <div><b>{tr("editor.defaultGuideTitle")}</b></div>
          <ol>
            <li>{tr("pdf.defaultGuide1")}</li>
            <li>{tr("editor.defaultGuide2", { ext: guide })}</li>
            <li>{tr("pdf.defaultGuide3")}</li>
          </ol>
          <div className="muted">{tr("pdf.defaultGuideAfter")}</div>
        </div>
      )}
      <div className="toolbar pdf-wrap">
        <button onClick={() => void invoke("pdf_open_settings")}><Settings />{tr("pdf.openDefaultApps")}</button>
        {st.registered && <button onClick={() => void unregister()}><Unlink />{tr("editor.unregister")}</button>}
      </div>
      {st.dev && <div className="small pdf-dev-note"><TriangleAlert />{tr("pdf.defaultDev")}</div>}
    </div>
  );
}
