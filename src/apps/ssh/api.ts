import { invoke, isTauri } from "@tauri-apps/api/core";

export interface ConnectCfg {
  host: string;
  port: number;
  user: string;
  keyPath: string;
  cols?: number;
  rows?: number;
  command?: string;
  /** Ép cấp TTY từ xa (ssh -tt) — cần cho `docker exec -it`. */
  tty?: boolean;
}

/** Một container Docker trên server (từ `docker ps`). */
export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
}

export interface TunnelCfg {
  id: string;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  kind: "L" | "R" | "D";
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

const needApp = () => Promise.reject(new Error("Cần chạy trong app (npm run app:dev) — trình duyệt không mở được SSH."));

export const ssh = {
  connect: (cfg: ConnectCfg) => (isTauri() ? invoke<string>("ssh_connect", { cfg }) : needApp()),
  send: (id: string, data: string) => invoke<void>("ssh_send", { id, data }),
  resize: (id: string, cols: number, rows: number) => invoke<void>("ssh_resize", { id, cols, rows }),
  disconnect: (id: string) => invoke<void>("ssh_disconnect", { id }),
  tunnelOpen: (cfg: TunnelCfg) => (isTauri() ? invoke<void>("ssh_tunnel_open", { cfg }) : needApp()),
  tunnelClose: (id: string) => invoke<void>("ssh_tunnel_close", { id }),
  /** Host đã có mật khẩu lưu trong Windows Credential Manager chưa. */
  hasPassword: (user: string, host: string, port: number) =>
    isTauri() ? invoke<boolean>("ssh_has_password", { user, host, port }) : Promise.resolve(false),
  /** Quên mật khẩu đã lưu của host. */
  forgetPassword: (user: string, host: string, port: number) =>
    isTauri() ? invoke<void>("ssh_forget_password", { user, host, port }) : Promise.resolve(),
  /** Mở phiên thống kê server (CPU/RAM/net/disk) — phát event `ssh-stat`. */
  statStart: (cfg: ConnectCfg) => (isTauri() ? invoke<string>("ssh_stat_start", { cfg }) : needApp()),
  statStop: (id: string) => invoke<void>("ssh_stat_stop", { id }),
  /** Liệt kê container Docker đang chạy trên server. */
  dockerPs: (cfg: ConnectCfg) => (isTauri() ? invoke<DockerContainer[]>("ssh_docker_ps", { cfg }) : needApp()),
};

/** Một mẫu thống kê server từ event `ssh-stat`. */
export interface SshStat {
  id: string;
  cpu: number;        // %
  memUsed: number;    // bytes
  memTotal: number;
  netRx: number;      // bytes/s
  netTx: number;
  diskUsed: number;   // bytes
  diskTotal: number;
  load: number;
  /** Uptime tính bằng giây (từ /proc/uptime). */
  uptime: number;
}

/** Một mục trong thư mục remote (SFTP). */
export interface SftpEntry {
  name: string;
  kind: "dir" | "file" | "link";
  size: number;
  mtime: string;
  perms: string;
  linkTarget: string | null;
}

/** Kết quả preview một file remote. */
export interface SftpPreview {
  kind: "text" | "image" | "binary" | "toolarge";
  /** text: nội dung; image: base64; khác: rỗng. */
  data: string;
  mime: string;
  size: number;
}

/** Cấu hình mở phiên SFTP — cùng host/port/user/key với terminal. */
export interface SftpCfg {
  host: string;
  port: number;
  user: string;
  keyPath: string;
}

/** SFTP chạy sftp.exe của máy trong ConPTY (panel duyệt file kiểu MobaXterm). */
export const sftp = {
  open: (cfg: SftpCfg) => (isTauri() ? invoke<string>("sftp_open", { cfg }) : needApp()),
  close: (id: string) => invoke<void>("sftp_close", { id }),
  home: (id: string) => invoke<string>("sftp_home", { id }),
  /** Resolve + kiểm tra lệnh cd (neo về cwd), trả path tuyệt đối hoặc lỗi nếu thư mục không hợp lệ. */
  cd: (id: string, cwd: string, arg: string) => invoke<string>("sftp_cd", { id, cwd, arg }),
  list: (id: string, path: string) => invoke<SftpEntry[]>("sftp_list", { id, path }),
  read: (id: string, path: string, max: number) => invoke<SftpPreview>("sftp_read", { id, path, max }),
  get: (id: string, remote: string, local: string, recursive = false) =>
    invoke<void>("sftp_get", { id, remote, local, recursive }),
  put: (id: string, local: string, remote: string) => invoke<void>("sftp_put", { id, local, remote }),
  mkdir: (id: string, path: string) => invoke<void>("sftp_mkdir", { id, path }),
  touch: (id: string, path: string) => invoke<void>("sftp_touch", { id, path }),
  rm: (id: string, path: string) => invoke<void>("sftp_rm", { id, path }),
  rmdir: (id: string, path: string) => invoke<void>("sftp_rmdir", { id, path }),
  rename: (id: string, from: string, to: string) => invoke<void>("sftp_rename", { id, from, to }),
};

/** Giao diện chung cho một "nguồn file" mà SftpPanel dùng (sftp host hoặc docker exec container). */
export interface FsDriver {
  open(cfg: SftpCfg): Promise<string>;
  close(id: string): Promise<void>;
  home(id: string): Promise<string>;
  cd(id: string, cwd: string, arg: string): Promise<string>;
  list(id: string, path: string): Promise<SftpEntry[]>;
  read(id: string, path: string, max: number): Promise<SftpPreview>;
  get(id: string, remote: string, local: string, recursive?: boolean): Promise<void>;
  put(id: string, local: string, remote: string): Promise<void>;
  mkdir(id: string, path: string): Promise<void>;
  touch(id: string, path: string): Promise<void>;
  rm(id: string, path: string): Promise<void>;
  rmdir(id: string, path: string): Promise<void>;
  rename(id: string, from: string, to: string): Promise<void>;
}

/** Chuỗi POSIX TZ theo múi giờ máy hiện tại (vd UTC+7 → "LCL-7", UTC+5:30 → "LCL-5:30").
 * Tên vùng PHẢI ≥ 3 ký tự ("LCL") nếu không POSIX bỏ qua. POSIX đảo dấu: offset là lượng cộng
 * vào giờ địa phương để ra UTC (UTC+7 → -7). Không cần tzdata trong container. */
export function posixTz(): string {
  const mins = -new Date().getTimezoneOffset(); // phút lệch so với UTC, dương = nhanh hơn (đông)
  const sign = mins >= 0 ? "-" : "+";
  const a = Math.abs(mins);
  const hh = Math.floor(a / 60);
  const mm = a % 60;
  return `LCL${sign}${hh}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
}

/** Driver duyệt file TRONG một container Docker (qua `docker exec`, không phải sftp host).
 * Không có phiên bền — mỗi thao tác là một lệnh ssh một-lần mang theo cfg + tên container. */
export function dockerFs(cfg: ConnectCfg, container: string): FsDriver {
  const C = { cfg, container };
  // Container thường chạy TZ=UTC → truyền TZ của máy (dạng POSIX, vd "DS-7" cho UTC+7) để `ls` in giờ địa phương.
  const tz = posixTz();
  return {
    open: async () => "docker",
    close: async () => {},
    home: () => invoke<string>("docker_fs_home", { ...C }),
    cd: (_id, cwd, arg) => invoke<string>("docker_fs_cd", { ...C, cwd, arg }),
    list: (_id, path) => invoke<SftpEntry[]>("docker_fs_list", { ...C, path, tz }),
    read: (_id, path, max) => invoke<SftpPreview>("docker_fs_read", { ...C, path, max }),
    get: (_id, remote, local) => invoke<void>("docker_fs_get", { ...C, remote, local }),
    put: async () => Promise.reject(new Error("Upload vào container chưa hỗ trợ (dùng terminal + docker cp).")),
    mkdir: (_id, path) => invoke<void>("docker_fs_mkdir", { ...C, path }),
    touch: (_id, path) => invoke<void>("docker_fs_touch", { ...C, path }),
    rm: (_id, path) => invoke<void>("docker_fs_rm", { ...C, path }),
    rmdir: (_id, path) => invoke<void>("docker_fs_rmdir", { ...C, path }),
    rename: (_id, from, to) => invoke<void>("docker_fs_rename", { ...C, from, to }),
  };
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
