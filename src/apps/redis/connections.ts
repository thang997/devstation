import { create } from "zustand";

/** Cấu hình SSH tunnel cho kết nối Redis (kiểu Navicat): Redis nối qua 127.0.0.1 → ssh -L → host:port thật. */
export interface RedisSsh {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  /** Dùng key/agent (BatchMode — không hỏi mật khẩu). */
  keyPath: string;
}

/** Cấu hình kết nối đã lưu. KHÔNG có mật khẩu (mật khẩu chỉ giữ RAM, sau này vào keyring). */
export interface Conn {
  id: string;
  name: string;
  host: string;
  port: number;
  db: number;
  tls: boolean;
  env: "dev" | "staging" | "prod";
  /** Tuỳ chọn: nối Redis qua SSH tunnel. */
  ssh?: RedisSsh;
  /** Lưu mật khẩu vào keyring (chọn lúc tạo). true = lần sau tự kết nối, không hỏi. false = mở modal nhập. */
  savePw?: boolean;
}

export const newConn = (): Conn => ({
  id: `r${Date.now().toString(36)}`,
  name: "",
  host: "127.0.0.1",
  port: 6379,
  db: 0,
  tls: false,
  env: "dev",
  savePw: true,
});

const KEY = "devstation.redis.connections";
const load = (): Conn[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
};

interface ConnStore {
  conns: Conn[];
  save: (c: Conn) => void;
  remove: (id: string) => void;
}

export const useConns = create<ConnStore>((set, get) => {
  const persist = (conns: Conn[]) => {
    localStorage.setItem(KEY, JSON.stringify(conns));
    set({ conns });
  };
  return {
    conns: load(),
    save: (c) => {
      const conns = get().conns;
      persist(conns.some((x) => x.id === c.id) ? conns.map((x) => (x.id === c.id ? c : x)) : [...conns, c]);
    },
    remove: (id) => persist(get().conns.filter((x) => x.id !== id)),
  };
});

/** Mật khẩu chỉ giữ trong RAM đến khi tắt app. */
export const sessionPasswords = new Map<string, string>();

export const describe = (c: Conn) => `${c.host}:${c.port}${c.tls ? " (TLS)" : ""}/db${c.db}`;
