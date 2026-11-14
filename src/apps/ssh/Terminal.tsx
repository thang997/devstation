import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { ssh, errText, type ConnectCfg } from "./api";
import { t } from "../../store/lang";

/** Giải base64 (chuỗi) về bytes để ghi nguyên vẹn vào xterm. */
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Terminal SSH: mở ConPTY qua ssh.exe, nối hai chiều với xterm. */
export function SshTerminal({ cfg, onStatus, onCd }: { cfg: Omit<ConnectCfg, "cols" | "rows">; onStatus?: (s: string) => void; onCd?: (arg: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const onCdRef = useRef(onCd);
  onCdRef.current = onCd;

  useEffect(() => {
    const el = box.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Ubuntu Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      theme: { background: "#010409", foreground: "#e6edf3", cursor: "#58a6ff", selectionBackground: "#1f6feb55" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try { fit.fit(); } catch { /* chưa có kích thước */ }

    // Nhả các phím tắt CẤP APP ra ngoài (không gửi vào shell) để Shell xử lý khi đang focus terminal:
    // Ctrl+K (launcher), Ctrl+1..9, Ctrl+B, Ctrl+`, Ctrl+Tab, Ctrl+PageUp/Down, Ctrl+Shift+W.
    // Các phím khác (Ctrl+C, Ctrl+W xoá từ, Ctrl+L...) vẫn thuộc về terminal.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return true;
      const k = e.key.toLowerCase();
      const appShortcut =
        k === "k" || k === "b" ||
        e.key === "`" || e.key === "Tab" || e.key === "PageUp" || e.key === "PageDown" ||
        /^Digit[1-9]$/.test(e.code) ||
        (e.shiftKey && k === "w");
      return !appShortcut; // false = xterm bỏ qua, để sự kiện lọt ra Shell
    });

    let sid: string | null = null;
    let alive = true;
    let closed = false; // phiên đã đóng/lỗi → nhấn R để kết nối lại
    const unlisteners: Array<() => void> = [];

    /** Mở (hoặc mở lại) một phiên ssh cho terminal này. */
    const openSession = async () => {
      closed = false;
      try {
        onStatus?.("connecting");
        const id = await ssh.connect({ ...cfg, cols: term.cols, rows: term.rows });
        if (!alive) { void ssh.disconnect(id); return; }
        sid = id;
        onStatus?.("connected");
        void ssh.resize(id, term.cols, term.rows).catch(() => {});
        term.focus();
      } catch (e) {
        sid = null;
        closed = true;
        term.write(`\r\n\x1b[31m${errText(e)}\x1b[0m\r\n\x1b[90m[${t("press R to retry", "nhấn R để thử lại")}]\x1b[0m\r\n`);
        onStatus?.("error");
      }
    };

    (async () => {
      unlisteners.push(await listen<{ id: string; data: string }>("ssh-data", (ev) => {
        if (ev.payload.id === sid) term.write(b64ToBytes(ev.payload.data));
      }));
      unlisteners.push(await listen<{ id: string; arg: string }>("ssh-cd", (ev) => {
        if (ev.payload.id === sid) onCdRef.current?.(ev.payload.arg);
      }));
      unlisteners.push(await listen<{ id: string }>("ssh-closed", (ev) => {
        if (ev.payload.id === sid) {
          sid = null;
          closed = true;
          term.write(`\r\n\x1b[90m[${t("session closed — press R to reconnect", "phiên đã đóng — nhấn R để kết nối lại")}]\x1b[0m\r\n`);
          onStatus?.("closed");
        }
      }));
      // Gõ phím: khi đang mở thì gửi cho ssh; khi đã đóng thì R = kết nối lại (phím khác bỏ qua).
      term.onData((d) => {
        if (closed) {
          if (d === "r" || d === "R") { term.write("\r\n"); void openSession(); }
          return;
        }
        if (sid) void ssh.send(sid, d).catch(() => {});
      });
      await openSession();
    })();

    // Vừa vào & khi đổi kích thước: fit rồi báo server đổi cột/hàng.
    const doResize = () => {
      try { fit.fit(); } catch { /* ẩn */ }
      if (sid) void ssh.resize(sid, term.cols, term.rows).catch(() => {});
    };
    const ro = new ResizeObserver(() => doResize());
    ro.observe(el);

    return () => {
      alive = false;
      ro.disconnect();
      unlisteners.forEach((u) => u());
      if (sid) void ssh.disconnect(sid).catch(() => {});
      term.dispose();
    };
    // Chỉ chạy một lần cho mỗi tab (cfg cố định theo tab).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="xterm-host" ref={box} />;
}
