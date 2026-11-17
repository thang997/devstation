import { create } from "zustand";

/** Kết nối Harbor đã lưu. KHÔNG chứa mật khẩu (mật khẩu ở keyring / RAM). */
export interface RegConn {
  id: string;
  name: string;
  /** URL Harbor, vd. https://harbor.example.com */
  url: string;
  /** Tài khoản (user Harbor hoặc robot account `robot$...`). Rỗng = ẩn danh (chỉ project public). */
  user: string;
  env: "dev" | "staging" | "prod";
  /** Bỏ qua kiểm tra chứng chỉ TLS (Harbor nội bộ dùng chứng chỉ tự ký). */
  insecure: boolean;
  /** Lưu mật khẩu vào keyring → lần sau tự đăng nhập. */
  savePw?: boolean;
}

export const newConn = (): RegConn => ({
  id: `g${Date.now().toString(36)}`,
  name: "",
  url: "https://",
  user: "",
  env: "dev",
  insecure: false,
  savePw: true,
});

const KEY = "devstation.registry.connections";
const load = (): RegConn[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
};

interface ConnStore {
  conns: RegConn[];
  save: (c: RegConn) => void;
  remove: (id: string) => void;
}

export const useConns = create<ConnStore>((set, get) => {
  const persist = (conns: RegConn[]) => {
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

/** Mật khẩu giữ trong RAM tới khi tắt app (khi không lưu keyring). */
export const sessionPasswords = new Map<string, string>();

/** Host (không có scheme) — dùng trong lệnh `docker pull`. */
export const hostOf = (url: string) => url.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
