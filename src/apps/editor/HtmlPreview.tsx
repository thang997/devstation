import { memo, useEffect, useRef } from "react";
import { ExternalLink, Eye, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../store/lang";
import { useWorkbench } from "../../store/workbench";

/**
 * Xem trước HTML (bên phải ô soạn), cập nhật khi gõ (EditorTab đẩy nội dung sau ~300ms).
 * AN TOÀN: iframe `sandbox` KHÔNG có `allow-scripts` → không chạy `<script>` / `onclick=` nào (file HTML có thể chứa
 * mã lạ; chạy được trong app là chạm tới lệnh của app). Có `allow-same-origin` chỉ để đọc / khôi phục vị trí cuộn
 * khi vẽ lại — vô hại vì script đã bị chặn hẳn. Iframe thừa hưởng CSP của app → chỉ HTML + CSS tĩnh (ảnh data:),
 * tài nguyên ngoài (CDN, ảnh http, file cạnh bên) không tải; cần đầy đủ thì "Mở trong trình duyệt" (file đã lưu).
 */
export const HtmlPreview = memo(function HtmlPreview({ html, path, onClose }: { html: string; path?: string; onClose: () => void }) {
  const tr = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const scroll = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const f = frame.current;
    if (!f) return;
    try {
      const w = f.contentWindow;
      if (w) scroll.current = { x: w.scrollX, y: w.scrollY };
    } catch { /* chưa nạp */ }
    f.srcdoc = html;
  }, [html]);
  const restore = () => {
    try { frame.current?.contentWindow?.scrollTo(scroll.current.x, scroll.current.y); } catch { /* bỏ qua */ }
  };
  const openBrowser = () => {
    if (!path) return;
    void invoke("editor_open_in_browser", { path }).catch((e) => useWorkbench.getState().log(`✗ ${String(e)}`));
  };
  return (
    <div className="ed-preview">
      <div className="pane-title">
        <Eye /><span className="grow ellipsis" title={tr("editor.previewNote")}>{tr("editor.preview")} · <span className="ed-preview-note">{tr("editor.previewStatic")}</span></span>
        <button className="icon-btn" disabled={!path} onClick={openBrowser} title={path ? tr("editor.openInBrowser") : tr("editor.openInBrowserSaveFirst")}><ExternalLink /></button>
        <button className="icon-btn" onClick={onClose} title={tr("editor.closePreview")} aria-label={tr("editor.closePreview")}><X /></button>
      </div>
      <iframe ref={frame} className="ed-preview-frame" sandbox="allow-same-origin" title={tr("editor.preview")} onLoad={restore} />
    </div>
  );
});
