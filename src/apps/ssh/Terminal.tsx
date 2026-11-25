import { memo, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { ssh, errText, type ConnectCfg } from "./api";
import { t } from "../../store/lang";

/** Terminal SSH: mở ConPTY qua ssh.exe, nối hai chiều với xterm. */
// memo: tab cha vẽ lại (trạng thái, cd…) không vẽ lại terminal; mọi thứ chạy trong effect một lần.
/** Không nhận được byte nào từ server sau ngần này → coi là không kết nối được (máy tắt / firewall chặn / sai địa chỉ). */
export const CONNECT_TIMEOUT_S = 10;

export const SshTerminal = memo(function SshTerminal({ cfg, onStatus, onCd, onTimeout }: {
  cfg: Omit<ConnectCfg, "cols" | "rows">;
  onStatus?: (s: string) => void;
  onCd?: (arg: string) => void;
  /** Hết CONNECT_TIMEOUT_S giây mà server chưa trả lời gì (phiên đã bị dừng). */
  onTimeout?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const onCdRef = useRef(onCd);
  onCdRef.current = onCd;
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

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
    // Vẽ bằng WebGL (GPU) thay cho renderer DOM mặc định — output nhiều / cuộn nhanh mượt hơn hẳn.
    // Máy không có WebGL hoặc mất context (GPU reset, ngủ máy) → về renderer DOM.
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch { /* không có WebGL → DOM renderer */ }
    try { fit.fit(); } catch { /* chưa có kích thước */ }

    // Nhả các phím tắt CẤP APP ra ngoài (không gửi vào shell) để Shell xử lý khi đang focus terminal:
    // Ctrl+G (launcher), Ctrl+1..9, Ctrl+B, Ctrl+`, Ctrl+Tab, Ctrl+PageUp/Down, Ctrl+Shift+W.
    // Các phím khác (Ctrl+C, Ctrl+W xoá từ, Ctrl+L...) vẫn thuộc về terminal.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return true;
      const k = e.key.toLowerCase();
      const appShortcut =
        k === "g" || e.code === "KeyG" || k === "b" ||
        e.key === "`" || e.key === "Tab" || e.key === "PageUp" || e.key === "PageDown" ||
        /^Digit[1-9]$/.test(e.code) ||
        (e.shiftKey && k === "w");
      return !appShortcut; // false = xterm bỏ qua, để sự kiện lọt ra Shell
    });

    let sid: string | null = null;
    let alive = true;
    let closed = false; // phiên đã đóng/lỗi → nhấn R để kết nối lại
    const unlisteners: Array<() => void> = [];
    /** Lượt mở phiên hiện tại — kết quả của lượt cũ (đã timeout / mở lại) bị bỏ qua. */
    let attempt = 0;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const stopWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = undefined; } };

    /** Mở (hoặc mở lại) một phiên ssh cho terminal này.
     * "connected" chỉ khi server đã gửi byte đầu tiên (banner, hỏi mật khẩu, dấu nhắc…) — chạy được ssh.exe chưa phải
     * là kết nối được. Hết CONNECT_TIMEOUT_S giây im lặng → dừng phiên, báo lỗi, gọi onTimeout (tab hỏi có đóng không). */
    const openSession = async () => {
      closed = false;
      const my = ++attempt;
      let gotData = false;
      stopWatchdog();
      onStatus?.("connecting");
      watchdog = setTimeout(() => {
        watchdog = undefined;
        if (!alive || my !== attempt || gotData || closed) return;
        attempt++; // phiên đang treo không còn là phiên hiện tại
        if (sid) void ssh.disconnect(sid).catch(() => {});
        sid = null;
        closed = true;
        term.write(`\r\n\x1b[31m${t("ssh.connectTimeout", { s: CONNECT_TIMEOUT_S })}\x1b[0m\r\n\x1b[90m[${t("ssh.pressRToRetry")}]\x1b[0m\r\n`);
        onStatus?.("timeout");
        onTimeoutRef.current?.();
      }, CONNECT_TIMEOUT_S * 1000);
      try {
        const id = await ssh.connect({ ...cfg, cols: term.cols, rows: term.rows }, (bytes) => {
          if (!alive || my !== attempt) return;
          if (!gotData) { gotData = true; stopWatchdog(); onStatus?.("connected"); }
          term.write(bytes);
        });
        if (!alive || my !== attempt) { void ssh.disconnect(id).catch(() => {}); return; }
        sid = id;
        void ssh.resize(id, term.cols, term.rows).catch(() => {});
        term.focus();
      } catch (e) {
        if (my !== attempt) return;
        stopWatchdog();
        sid = null;
        closed = true;
        term.write(`\r\n\x1b[31m${errText(e)}\x1b[0m\r\n\x1b[90m[${t("ssh.pressRToRetry")}]\x1b[0m\r\n`);
        onStatus?.("error");
      }
    };

    (async () => {
      unlisteners.push(await listen<{ id: string; arg: string }>("ssh-cd", (ev) => {
        if (ev.payload.id === sid) onCdRef.current?.(ev.payload.arg);
      }));
      unlisteners.push(await listen<{ id: string }>("ssh-closed", (ev) => {
        if (ev.payload.id === sid) {
          stopWatchdog();
          sid = null;
          closed = true;
          term.write(`\r\n\x1b[90m[${t("ssh.sessionClosedPressRToReconnect")}]\x1b[0m\r\n`);
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
    // Gộp theo khung hình (kéo thanh chia bắn ResizeObserver liên tục); bỏ qua khi khung ~0 (tab ẩn);
    // chỉ báo server khi cột/hàng THỰC SỰ đổi (mỗi lần đổi, shell/vim vẽ lại toàn màn → giật).
    let raf = 0;
    let sent = "";
    const doResize = () => {
      raf = 0;
      if (el.clientWidth < 20 || el.clientHeight < 20) return;
      try { fit.fit(); } catch { /* ẩn */ }
      const key = `${term.cols}x${term.rows}`;
      if (sid && key !== sent) {
        sent = key;
        void ssh.resize(sid, term.cols, term.rows).catch(() => {});
      }
    };
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(doResize); });
    ro.observe(el);

    return () => {
      alive = false;
      stopWatchdog();
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      unlisteners.forEach((u) => u());
      if (sid) void ssh.disconnect(sid).catch(() => {});
      term.dispose();
    };
    // Chỉ chạy một lần cho mỗi tab (cfg cố định theo tab).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="xterm-host" ref={box} />;
});
