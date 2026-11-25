import { useSyncExternalStore } from "react";

/**
 * Lịch sử lệnh SSH theo host (`user@host:port`, tab exec thêm `#container`) + ghi chú "lệnh này làm gì".
 * - Lệnh: Rust phát `ssh-cmd` khi Enter ở dấu nhắc shell → `addCommand`. Mới nhất trước; lệnh trùng thì đưa lên đầu, tăng `n`.
 * - Ghi chú gắn theo NỘI DUNG lệnh của host (áp dụng cho cả lịch sử trên server), xoá lệnh khỏi lịch sử không xoá ghi chú.
 * Lưu localStorage (ghi trễ), đồng bộ giữa các cửa sổ qua sự kiện `storage`.
 */
export interface CmdEntry {
  cmd: string;
  /** Lần chạy gần nhất (ms). */
  ts: number;
  /** Số lần đã chạy. */
  n: number;
}

const KEY_H = "devstation.ssh.cmdHistory";
const KEY_N = "devstation.ssh.cmdNotes";
const MAX_PER_HOST = 1000;

type Hist = Record<string, CmdEntry[]>;
type Notes = Record<string, Record<string, string>>;

const read = <T,>(k: string): T => {
  try { return (JSON.parse(localStorage.getItem(k) || "{}") as T) || ({} as T); } catch { return {} as T; }
};

let hist: Hist = read<Hist>(KEY_H);
let notes: Notes = read<Notes>(KEY_N);
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      localStorage.setItem(KEY_H, JSON.stringify(hist));
      localStorage.setItem(KEY_N, JSON.stringify(notes));
    } catch { /* đầy bộ nhớ → bỏ qua */ }
  }, 300);
}
window.addEventListener("storage", (e) => {
  if (e.key === KEY_H) { hist = read<Hist>(KEY_H); emit(); }
  else if (e.key === KEY_N) { notes = read<Notes>(KEY_N); emit(); }
});

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const EMPTY_H: CmdEntry[] = [];
const EMPTY_N: Record<string, string> = {};

export function useCmdHistory(host: string): CmdEntry[] {
  return useSyncExternalStore(subscribe, () => hist[host] ?? EMPTY_H);
}
export function useCmdNotes(host: string): Record<string, string> {
  return useSyncExternalStore(subscribe, () => notes[host] ?? EMPTY_N);
}

export function addCommand(host: string, cmd: string) {
  const c = cmd.trim();
  if (!c) return;
  const list = hist[host] ?? [];
  const old = list.find((e) => e.cmd === c);
  const next = [{ cmd: c, ts: Date.now(), n: (old?.n ?? 0) + 1 }, ...list.filter((e) => e.cmd !== c)].slice(0, MAX_PER_HOST);
  hist = { ...hist, [host]: next };
  save();
  emit();
}

export function removeCommand(host: string, cmd: string) {
  const list = hist[host];
  if (!list) return;
  hist = { ...hist, [host]: list.filter((e) => e.cmd !== cmd) };
  save();
  emit();
}

export function clearCommands(host: string) {
  const { [host]: _, ...rest } = hist;
  hist = rest;
  save();
  emit();
}

/** Đặt / xoá (chuỗi rỗng) ghi chú cho một lệnh. */
export function setNote(host: string, cmd: string, note: string) {
  const cur = { ...(notes[host] ?? {}) };
  const v = note.trim();
  if (v) cur[cmd] = v;
  else delete cur[cmd];
  notes = { ...notes, [host]: cur };
  save();
  emit();
}
