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
export const CONNECT_TIMEOUT_S = 5;
/** Sau dấu nhắc mật khẩu/passphrase: người dùng đang gõ → chờ lâu hơn rồi mới coi là treo. */
const PROMPT_WAIT_S = 45;
/** Dấu nhắc nhập (mật khẩu, passphrase, OTP, xác nhận host key) — CHƯA phải đã vào được server. */
const PROMPT_RE = /(password|passphrase.*|verification code|one-time password|otp)\s*:\s*$|\(yes\/no(\/\[fingerprint\])?\)\?\s*$/i;
/** Lỗi kết nối do ssh in ra trước khi vào được server (kể cả qua jump host). */
const FAIL_RE = /ssh: connect to host .*?(timed out|refused|no route to host|unreachable)[^\r\n]*|ssh: could not resolve hostname[^\r\n]*|connection timed out during banner exchange[^\r\n]*|kex_exchange_identification:[^\r\n]*|connection closed by [^\r\n]*|connection reset by [^\r\n]*|host key verification failed[^\r\n]*|permission denied \([^)]*\)[^\r\n]*|too many authentication failures[^\r\n]*/i;

export const SshTerminal = memo(function SshTerminal({ cfg, onStatus, onCd, onTimeout, onCommand }: {
  cfg: Omit<ConnectCfg, "cols" | "rows">;
  onStatus?: (s: string) => void;
  onCd?: (arg: string) => void;
  /** Không vào được server: hết CONNECT_TIMEOUT_S giây im lặng (reason rỗng) hoặc ssh báo lỗi kết nối (reason = dòng lỗi). Phiên đã dừng. */
  onTimeout?: (reason: string) => void;
  /** Người dùng vừa chạy một lệnh ở dấu nhắc shell (event `ssh-cmd` từ Rust) — ghi lịch sử lệnh. */
  onCommand?: (cmd: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const onCdRef = useRef(onCd);
  onCdRef.current = onCd;
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

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
    /** Đang mở phiên, chưa vào được server. */
    let connecting = false;
    /** Dòng lỗi kết nối đã bắt được (chờ in hết rồi báo). */
    let pendingFail = "";
    let failNow: ((reason: string) => void) | null = null;

    /** Mở (hoặc mở lại) một phiên ssh cho terminal này.
     * "connected" chỉ khi server đã gửi byte đầu tiên (banner, hỏi mật khẩu, dấu nhắc…) — chạy được ssh.exe chưa phải
     * là kết nối được. Hết CONNECT_TIMEOUT_S giây im lặng → dừng phiên, báo lỗi, gọi onTimeout (tab hỏi có đóng không). */
    const openSession = async () => {
      closed = false;
      const my = ++attempt;
      /** Đã thấy output "thật" của server (không phải dấu nhắc nhập / lỗi kết nối). */
      let gotData = false;
      /** Output gần nhất lúc chưa vào được (dò dấu nhắc / lỗi; dấu nhắc có thể bị chia nhiều mẩu). */
      let pre = "";
      connecting = true;
      pendingFail = "";
      const dec = new TextDecoder();
      stopWatchdog();
      onStatus?.("connecting");
      const fail = (reason: string) => {
        stopWatchdog();
        if (!alive || my !== attempt || gotData || closed) return;
        connecting = false;
        attempt++; // phiên này không còn là phiên hiện tại
        if (sid) void ssh.disconnect(sid).catch(() => {});
        sid = null;
        closed = true;
        const msg = reason || t("ssh.connectTimeout", { s: CONNECT_TIMEOUT_S });
        term.write(`\r\n\x1b[31m${reason ? t("ssh.connectFailed") : msg}\x1b[0m\r\n\x1b[90m[${t("ssh.pressRToRetry")}]\x1b[0m\r\n`);
        onStatus?.(reason ? "error" : "timeout");
        onTimeoutRef.current?.(reason);
      };
      failNow = fail;
      const arm = (secs: number) => { stopWatchdog(); watchdog = setTimeout(() => { watchdog = undefined; fail(""); }, secs * 1000); };
      arm(CONNECT_TIMEOUT_S);
      try {
        const id = await ssh.connect({ ...cfg, cols: term.cols, rows: term.rows }, (bytes) => {
          if (!alive || my !== attempt) return;
          term.write(bytes);
          if (gotData) return;
          // Chưa vào được: phân loại output. Lỗi kết nối → dừng + hỏi đóng tab; dấu nhắc nhập → chờ người gõ
          // (qua jump host: dấu nhắc của jump chưa có nghĩa là server đích trả lời); còn lại = đã vào server.
          // Bỏ mã điều khiển (CSI, OSC đặt tiêu đề cửa sổ của ConPTY…) — mẩu chỉ có mã điều khiển/khoảng trắng
          // (ConPTY gửi ngay khi chạy ssh.exe) không phải là server trả lời.
          const chunk = dec.decode(bytes, { stream: true })
            .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
            .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
            .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78]/g, "");
          if (!chunk.trim()) return;
          pre = (pre + chunk).slice(-2000);
          const bad = pre.match(FAIL_RE);
          if (bad) { pendingFail = bad[0].trim(); setTimeout(() => fail(pendingFail), 300); return; } // chờ chút để in hết các dòng lỗi
          const lastLine = pre.split(/\r?\n/).filter((l) => l.trim()).pop() ?? "";
          if (PROMPT_RE.test(lastLine)) { arm(PROMPT_WAIT_S); return; }
          if (/^\s*(warning: permanently added|\*\*.*\*\*)/i.test(lastLine)) return; // thông báo của ssh, chưa phải server
          gotData = true;
          connecting = false;
          stopWatchdog();
          onStatus?.("connected");
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
      unlisteners.push(await listen<{ id: string; cmd: string }>("ssh-cmd", (ev) => {
        if (ev.payload.id === sid) onCommandRef.current?.(ev.payload.cmd);
      }));
      unlisteners.push(await listen<{ id: string }>("ssh-closed", (ev) => {
        if (ev.payload.id === sid && connecting && failNow) {
          // ssh thoát trước khi vào được server → báo lỗi (dòng lỗi đã bắt được, không thì câu chung) + hỏi đóng tab.
          failNow(pendingFail || t("ssh.connectClosedEarly"));
          return;
        }
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
