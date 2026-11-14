import { create } from "zustand";

export type Driver = "postgres" | "mysql" | "sqlite" | "cassandra";

export const DRIVERS: Record<Driver, { name: string; port?: number }> = {
  postgres: { name: "PostgreSQL", port: 5432 },
  mysql: { name: "MySQL / MariaDB", port: 3306 },
  sqlite: { name: "SQLite" },
  cassandra: { name: "Cassandra / ScyllaDB", port: 9042 },
};

/** Cấu hình SSH tunnel cho kết nối DB (kiểu Navicat): DB nối qua 127.0.0.1 → ssh -L → host:port thật. */
export interface DbSsh {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  /** Dùng key/agent (BatchMode — không hỏi mật khẩu). */
  keyPath: string;
}

/** Cấu hình kết nối đã lưu. KHÔNG có mật khẩu — mật khẩu sẽ vào keyring ở giai đoạn sau. */
export interface Conn {
  id: string;
  name: string;
  driver: Driver;
  host: string;
  port?: number;
  user: string;
  database: string;
  /** Đường dẫn file (SQLite). */
  file: string;
  env: "dev" | "staging" | "prod";
  /** Tuỳ chọn: nối DB qua SSH tunnel. */
  ssh?: DbSsh;
  /** Lưu mật khẩu vào keyring (chọn lúc tạo). true = lần sau tự kết nối, không hỏi. false = mở modal nhập. */
  savePw?: boolean;
  /** Id thư mục chứa kết nối ("" / bỏ trống = ngoài thư mục). */
  folderId?: string;
}

export const newConn = (): Conn => ({
  id: `c${Date.now().toString(36)}`,
  name: "",
  driver: "postgres",
  host: "localhost",
  port: 5432,
  user: "",
  database: "",
  file: "",
  env: "dev",
  savePw: true,
});

// Tạm lưu localStorage; khi có SQLite (giai đoạn 1) sẽ chuyển sang đó.
const KEY = "devstation.db.connections";
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
  /** Ghi đè toàn bộ danh sách (dùng khi kéo-thả sắp lại vị trí). */
  setAll: (conns: Conn[]) => void;
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
    setAll: (conns) => persist(conns),
  };
});

/** Mật khẩu chỉ giữ trong RAM đến khi tắt app (nếu người dùng chọn ghi nhớ). */
export const sessionPasswords = new Map<string, string>();

export const describe = (c: Conn) =>
  c.driver === "sqlite" ? c.file.split(/[\\/]/).pop() || "(chưa chọn file)" : `${c.user}@${c.host}${c.port ? `:${c.port}` : ""}/${c.database}`;
