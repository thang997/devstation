import { invoke } from "@tauri-apps/api/core";

export interface CertOut {
  name: string;
  subject: string;
  issuer: string;
  serial: string;
  /** Unix giây. */
  notBefore: number;
  notAfter: number;
  sha256: string;
  selfSigned: boolean;
  isCa: boolean;
  userTrusted: boolean;
  /** DER base64. */
  der: string;
}

export type SigStatus = "valid" | "unknown" | "invalid";

export interface SigOut {
  field: string;
  kind: "pades" | "pkcs7" | "pkcs7sha1" | "timestamp" | "unknown";
  status: SigStatus;
  signer: string | null;
  reason: string | null;
  location: string | null;
  contact: string | null;
  nameField: string | null;
  pdfTime: number | null;
  cmsTime: number | null;
  tsTime: number | null;
  tsVerified: boolean;
  timeUsed: number;
  timeSource: "timestamp" | "signer" | "pdf" | "now";
  integrityOk: boolean;
  digestOk: boolean;
  cryptoOk: boolean;
  cryptoError: string | null;
  coversWhole: boolean;
  modifiedAfter: boolean;
  unsafeChanges: boolean | null;
  revEnd: number;
  trusted: boolean;
  trustSource: "app" | "system" | "windows" | null;
  chainError: "expired" | "notYetValid" | "untrustedRoot" | "chainIncomplete" | "issuerMismatch" | "error" | null;
  chainErrorText: string | null;
  chain: CertOut[];
  algorithm: string | null;
  padesLevel: string | null;
  issues: string[];
  /** Thuật toán băm yếu (vd. "SHA-1"). */
  weakHash: string | null;
  /** Thu hồi theo CRL/OCSP nhúng trong file. */
  revocation: { status: "revoked" | "good" | "unknown"; revokedAt: number | null; cert: string | null; source: "crl" | "ocsp" | null; checked: number; total: number };
  /** Bị thu hồi trước/đúng thời điểm ký. */
  revoked: boolean;
  /** Chữ ký chứng nhận: mức DocMDP /P. */
  docmdp: number | null;
  docmdpViolation: boolean;
  /** Kiểm bằng bộ kiểm riêng vì thư viện chính không hỗ trợ thuật toán. */
  fallback: boolean;
}

export interface VerifyOut {
  signatures: SigOut[];
  error: string | null;
}

export interface DefaultStatus {
  supported: boolean;
  registered: boolean;
  isDefault: boolean;
  /** Bản dev (npm run app:dev): đăng ký trỏ tới exe debug. */
  dev: boolean;
}

export const pdfApi = {
  read: (path: string) => invoke<ArrayBuffer>("pdf_read", { path }),
  /** Gửi byte thô (không base64). */
  verify: (bytes: Uint8Array) => invoke<VerifyOut>("pdf_verify", bytes),
  /** Kiểm theo đường dẫn — Rust tự đọc file (không gửi cả file qua IPC). */
  verifyPath: (path: string) => invoke<VerifyOut>("pdf_verify_path", { path }),
  openUrl: (url: string) => invoke<void>("pdf_open_url", { url }),
  takePending: () => invoke<string[]>("pdf_take_pending"),
  trustList: () => invoke<CertOut[]>("pdf_trust_list"),
  trustAdd: (der: string) => invoke<void>("pdf_trust_add", { der }),
  trustRemove: (sha256: string) => invoke<void>("pdf_trust_remove", { sha256 }),
  defaultStatus: () => invoke<DefaultStatus>("pdf_default_status"),
  /** Đăng ký + mở hộp thoại "Open with" của Windows (chặn tới khi người dùng đóng), trả trạng thái sau đó. */
  registerDefault: (file?: string) => invoke<DefaultStatus>("pdf_register_default", { file: file ?? null }),
  unregisterDefault: () => invoke<void>("pdf_unregister_default"),
  openSettings: () => invoke<void>("pdf_open_settings"),
  reveal: (path: string) => {
    const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    return invoke<void>("git_reveal", { path: path.slice(0, i), file: path.slice(i + 1) });
  },
  writeText: (path: string, content: string) => invoke<void>("write_text_file", { path, content }),
};
