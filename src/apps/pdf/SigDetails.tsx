import { useEffect, useRef, useState, type ReactNode } from "react";
import { BadgeCheck, ChevronDown, ChevronRight, CircleCheck, CircleX, Copy, Download, FileClock, Info, ShieldCheck, ShieldOff, ShieldPlus, Trash2, TriangleAlert, X } from "lucide-react";
import { Modal } from "../../shell/Modal";
import { confirmDialog } from "../../shell/confirm";
import { copyText } from "../../shell/clipboard";
import { Loading } from "../../shell/Loading";
import { useWorkbench } from "../../store/workbench";
import { useT, t, type TKey } from "../../store/lang";
import { pdfApi, type CertOut, type SigOut, type SigStatus, type VerifyOut } from "./api";
import { bumpTrust, derToPem, fmtTime, useTrustVersion } from "./store";

/** Icon trạng thái chữ ký (màu theo lớp .sig-ic.<status>). */
export function SigIcon({ status, warn }: { status: SigStatus; warn?: boolean }) {
  if (status === "invalid") return <CircleX className="sig-ic invalid" />;
  if (status === "unknown" || warn) return <TriangleAlert className="sig-ic unknown" />;
  return <CircleCheck className="sig-ic valid" />;
}

/** Chữ ký "có vấn đề" theo nghĩa Acrobat: không hợp lệ / chưa xác định / có sửa nội dung sau khi ký. */
export const sigWarn = (s: SigOut) => s.status !== "valid" || s.unsafeChanges === true;

/** Tóm tắt cả tài liệu cho thanh banner. */
export function docSummary(v: VerifyOut): { level: SigStatus; text: string } | null {
  const sigs = v.signatures;
  if (!sigs.length) return null;
  // Nêu đúng lý do nặng nhất (thu hồi / vi phạm chứng nhận / bị sửa…), không gộp chung "có thể đã bị sửa".
  if (sigs.some((s) => s.revoked)) return { level: "invalid", text: t("pdf.bannerRevoked") };
  if (sigs.some((s) => s.docmdpViolation)) return { level: "invalid", text: t("pdf.bannerDocmdp") };
  if (sigs.some((s) => s.status === "invalid")) return { level: "invalid", text: t("pdf.bannerInvalid") };
  if (sigs.some((s) => s.unsafeChanges)) return { level: "unknown", text: t("pdf.bannerModified") };
  if (sigs.some((s) => s.weakHash)) return { level: "unknown", text: t("pdf.bannerWeak") };
  if (sigs.some(sigWarn)) return { level: "unknown", text: t("pdf.bannerUnknown") };
  return { level: "valid", text: sigs.length > 1 ? t("pdf.bannerValidMany", { n: sigs.length }) : t("pdf.bannerValid") };
}

const kindLabel = (s: SigOut) =>
  s.kind === "pades" ? `PAdES${s.padesLevel ? ` ${s.padesLevel}` : ""}` : s.kind === "pkcs7" ? "PKCS#7 (adbe.pkcs7.detached)" : s.kind === "pkcs7sha1" ? "PKCS#7 SHA-1 (adbe.pkcs7.sha1)" : s.kind === "timestamp" ? "Document timestamp (RFC 3161)" : "Unknown";

function Check({ ok, children }: { ok: "ok" | "warn" | "bad" | "info"; children: ReactNode }) {
  const icon = ok === "ok" ? <CircleCheck /> : ok === "warn" ? <TriangleAlert /> : ok === "bad" ? <CircleX /> : <Info />;
  return <div className={`sig-check ${ok}`}>{icon}<div>{children}</div></div>;
}

/** SHA-256 dạng AA:BB:… chia 2 dòng (16 byte/dòng) cho vừa hộp xác nhận. */
const shaLines = (hex: string) => (hex.match(/.{2}/g) ?? [hex]).reduce((acc, b, i) => acc + (i === 0 ? "" : i % 16 === 0 ? "\n" : ":") + b, "");

/** Hỏi rồi thêm chứng thư vào danh sách Trust của app. */
export async function trustCert(c: CertOut): Promise<boolean> {
  const ok = await confirmDialog({
    title: t("pdf.trustTitle"),
    message: t("pdf.trustConfirm", { name: c.name, subject: c.subject, sha: shaLines(c.sha256) }),
    confirmLabel: t("pdf.trust"),
    danger: false,
  });
  if (!ok) return false;
  try {
    await pdfApi.trustAdd(c.der);
    useWorkbench.getState().log(`✓ ${t("pdf.trustAdded", { name: c.name })}`);
    bumpTrust();
    return true;
  } catch (e) {
    useWorkbench.getState().log(`✗ ${String(e)}`);
    return false;
  }
}

export async function untrustCert(c: Pick<CertOut, "name" | "sha256">): Promise<boolean> {
  const ok = await confirmDialog({ title: t("pdf.untrustTitle"), message: t("pdf.untrustConfirm", { name: c.name }), confirmLabel: t("pdf.untrust") });
  if (!ok) return false;
  try {
    await pdfApi.trustRemove(c.sha256);
    bumpTrust();
    return true;
  } catch (e) {
    useWorkbench.getState().log(`✗ ${String(e)}`);
    return false;
  }
}

async function saveCert(c: CertOut) {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: `${c.name.replace(/[\\/:*?"<>|]+/g, "_")}.cer`, filters: [{ name: "Certificate", extensions: ["cer", "pem", "crt"] }] });
  if (!path) return;
  try {
    await pdfApi.writeText(path, derToPem(c.der));
    useWorkbench.getState().log(`✓ ${t("pdf.certSaved", { path })}`);
  } catch (e) {
    useWorkbench.getState().log(`✗ ${String(e)}`);
  }
}

function CertCard({ c, role, open, onToggle }: { c: CertOut; role: string; open: boolean; onToggle: () => void }) {
  const tr = useT();
  const now = Date.now() / 1000;
  const expired = now > c.notAfter;
  return (
    <div className={`cert-card ${open ? "open" : ""}`}>
      <button className="cert-head" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown /> : <ChevronRight />}
        <span className="cert-role">{role}</span>
        <span className="ellipsis cert-name" title={c.subject}>{c.name}</span>
        {c.userTrusted && <span className="cert-tag ok"><ShieldCheck />{tr("pdf.trustedTag")}</span>}
        {expired && <span className="cert-tag warn">{tr("pdf.expiredTag")}</span>}
      </button>
      {open && (
        <div className="cert-body">
          <dl className="pdf-kv">
            <dt>Subject</dt><dd className="sel-text">{c.subject}</dd>
            <dt>Issuer</dt><dd className="sel-text">{c.issuer}</dd>
            <dt>Serial</dt><dd className="mono sel-text">{c.serial}</dd>
            <dt>{tr("pdf.validFrom")}</dt><dd>{fmtTime(c.notBefore)}</dd>
            <dt>{tr("pdf.validTo")}</dt><dd>{fmtTime(c.notAfter)}</dd>
            <dt>SHA-256</dt><dd className="mono sel-text small">{c.sha256.match(/.{2}/g)?.join(":")}</dd>
          </dl>
          <div className="toolbar pdf-wrap">
            {c.userTrusted
              ? <button onClick={() => void untrustCert(c)}><ShieldOff />{tr("pdf.untrust")}</button>
              : <button onClick={() => void trustCert(c)}><ShieldPlus />{tr("pdf.trustThis")}</button>}
            <button onClick={() => void copyText(c.sha256)}><Copy />{tr("pdf.copySha")}</button>
            <button onClick={() => void saveCert(c)}><Download />{tr("pdf.saveCert")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Chi tiết một chữ ký (kiểu "Signature Properties" của Acrobat). */
export function SigDetailsModal({ sig, busy, onClose, onShowSigned }: { sig: SigOut; busy?: boolean; onClose: () => void; onShowSigned?: (s: SigOut) => void }) {
  const tr = useT();
  const [openCert, setOpenCert] = useState<number>(-1);
  // Kiểm lại xong (sau khi Trust / bỏ Trust) → nháy danh sách chứng thư để thấy đã cập nhật.
  const [flash, setFlash] = useState(false);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 1400);
      wasBusy.current = false;
      return () => clearTimeout(id);
    }
    wasBusy.current = !!busy;
  }, [busy]);
  const s = sig;
  const intact = s.integrityOk && s.digestOk && s.cryptoOk;
  const head =
    s.revoked ? tr("pdf.sigRevoked") : s.docmdpViolation ? tr("pdf.sigDocmdpViolated") : s.status === "invalid" ? tr("pdf.sigInvalid") : s.status === "unknown" ? tr("pdf.sigUnknown") : s.unsafeChanges ? tr("pdf.sigValidModified") : tr("pdf.sigValid");
  const top = s.chain[s.chain.length - 1];
  const roleOf = (i: number) => (i === 0 ? tr("pdf.roleSigner") : i === s.chain.length - 1 && s.chain[i].selfSigned ? tr("pdf.roleRoot") : tr("pdf.roleCa"));
  const timeText =
    s.timeSource === "timestamp" ? (s.tsVerified ? tr("pdf.timeTsVerified") : tr("pdf.timeTsUnverified"))
    : s.timeSource === "signer" ? tr("pdf.timeSigner")
    : s.timeSource === "pdf" ? tr("pdf.timePdf")
    : tr("pdf.timeNow");
  // CA mà chuỗi dừng lại: gốc tự ký → chính nó; không thì CA cấp cho chứng thư trên cùng (file không nhúng CA đó).
  const caName = top ? (top.selfSigned ? top.name : (/CN=([^,]+)/.exec(top.issuer)?.[1] ?? top.issuer)) : "";
  const chainText = (() => {
    if (s.trusted) {
      const src = s.trustSource === "app" ? tr("pdf.srcApp") : s.trustSource === "windows" ? tr("pdf.srcWindows") : tr("pdf.srcSystem");
      return tr("pdf.idTrusted", { src });
    }
    switch (s.chainError) {
      case "untrustedRoot": return tr("pdf.idUntrustedRoot", { ca: caName });
      case "expired": return tr("pdf.idExpired");
      case "notYetValid": return tr("pdf.idNotYetValid");
      case "chainIncomplete": return tr("pdf.idChainIncomplete", { ca: caName });
      case "issuerMismatch": {
        // Mắt xích đầu tiên mà tên CA cấp (issuer) khác tên CA kế tiếp (subject).
        const i = s.chain.findIndex((c, k) => k + 1 < s.chain.length && c.issuer !== s.chain[k + 1].subject);
        const cn = (dnStr: string) => /CN=([^,]+)/.exec(dnStr)?.[1] ?? dnStr;
        return tr("pdf.idIssuerMismatch", { cert: s.chain[i]?.name ?? "", issuer: cn(s.chain[i]?.issuer ?? ""), ca: cn(s.chain[i + 1]?.subject ?? "") });
      }
      default: return tr("pdf.idError", { err: s.chainErrorText ?? "" });
    }
  })();

  return (
    <Modal title={<span className="sig-modal-title"><SigIcon status={s.status} warn={!!s.unsafeChanges} />{head}</span>} onClose={onClose} width={720}>
      <div className={`sig-details ${busy ? "busy" : ""}`} aria-busy={busy}>
        {busy && <div className="sig-busy"><Loading variant="inline" label={tr("pdf.reverifying")} /></div>}
        <div className={`sig-checks ${flash ? "flash" : ""}`}>
          <Check ok={intact ? "ok" : "bad"}>
            {intact ? tr("pdf.chkIntact") : tr("pdf.chkTampered")}
            {!intact && s.cryptoError && <div className="muted small">{s.cryptoError}</div>}
          </Check>
          {s.modifiedAfter && (
            <Check ok={s.unsafeChanges ? "warn" : "info"}>
              {s.unsafeChanges ? tr("pdf.chkModified") : tr("pdf.chkUpdatedSafe")}
              {onShowSigned && <div><button className="link-btn" onClick={() => onShowSigned(s)}><FileClock />{tr("pdf.showSigned")}</button></div>}
            </Check>
          )}
          <Check ok={s.trusted ? "ok" : "warn"}>
            {chainText}
            {!s.trusted && top && !top.userTrusted && (s.chainError === "untrustedRoot" || s.chainError === "chainIncomplete") && (
              <div className="sig-trust-cta">
                <button className="primary" onClick={() => void trustCert(top)}><ShieldPlus />{tr("pdf.trustRoot", { name: top.name })}</button>
                <span className="muted small">{tr("pdf.trustRootHint")}</span>
              </div>
            )}
          </Check>
          <Check ok={s.timeSource === "timestamp" && s.tsVerified ? "ok" : "info"}>
            {tr("pdf.chkTime", { time: fmtTime(s.timeUsed) })} <span className="muted">— {timeText}</span>
          </Check>
          {s.revocation.status === "revoked" ? (
            <Check ok={s.revoked ? "bad" : "warn"}>
              {tr(s.revoked ? "pdf.chkRevoked" : "pdf.chkRevokedAfter", { cert: s.revocation.cert ?? "", time: fmtTime(s.revocation.revokedAt), src: (s.revocation.source ?? "").toUpperCase() })}
            </Check>
          ) : s.revocation.status === "good" ? (
            <Check ok="ok">{tr("pdf.chkNotRevoked", { src: (s.revocation.source ?? "").toUpperCase() })}</Check>
          ) : (
            <Check ok="info">{tr("pdf.chkRevocation")}</Check>
          )}
          {s.weakHash && <Check ok="warn">{tr("pdf.chkWeakHash", { alg: s.weakHash })}</Check>}
          {s.docmdp != null && (
            <Check ok={s.docmdpViolation ? "bad" : "info"}>
              {s.docmdpViolation ? tr("pdf.chkDocmdpViolated", { p: tr(`pdf.docmdp${s.docmdp}` as TKey) }) : tr("pdf.chkCertified", { p: tr(`pdf.docmdp${s.docmdp}` as TKey) })}
            </Check>
          )}
        </div>

        <dl className="pdf-kv sig-kv">
          <dt>{tr("pdf.signer")}</dt><dd className="sel-text"><b>{s.signer ?? "—"}</b></dd>
          {s.reason && <><dt>{tr("pdf.reason")}</dt><dd className="sel-text">{s.reason}</dd></>}
          {s.location && <><dt>{tr("pdf.location")}</dt><dd className="sel-text">{s.location}</dd></>}
          {s.contact && <><dt>{tr("pdf.contact")}</dt><dd className="sel-text">{s.contact}</dd></>}
          {s.tsTime && <><dt>Timestamp</dt><dd>{fmtTime(s.tsTime)}{s.tsVerified ? "" : ` (${tr("pdf.unverified")})`}</dd></>}
          {s.cmsTime && <><dt>{tr("pdf.signerClock")}</dt><dd>{fmtTime(s.cmsTime)}</dd></>}
          {s.pdfTime && <><dt>{tr("pdf.pdfTime")}</dt><dd>{fmtTime(s.pdfTime)}</dd></>}
          <dt>{tr("pdf.field")}</dt><dd className="mono">{s.field}</dd>
          <dt>{tr("pdf.format")}</dt><dd>{kindLabel(s)}</dd>
          {s.algorithm && <><dt>{tr("pdf.algorithm")}</dt><dd>{s.algorithm}</dd></>}
        </dl>

        <div className="pane-title">{tr("pdf.certChain")}</div>
        <div className={`cert-chain ${flash ? "flash" : ""}`}>
          {s.chain.map((c, i) => (
            <CertCard key={c.sha256} c={c} role={roleOf(i)} open={openCert === i} onToggle={() => setOpenCert(openCert === i ? -1 : i)} />
          ))}
          {!s.chain.length && <div className="muted">—</div>}
        </div>
        {(s.issues.length > 0 || s.fallback) && (
          <details className="sig-issues">
            <summary>{tr("pdf.technicalNotes", { n: s.issues.length + (s.fallback ? 1 : 0) })}</summary>
            <ul>
              {s.fallback && <li className="small">{tr("pdf.noteFallback", { alg: s.algorithm ?? "" })}</li>}
              {s.issues.map((x, i) => <li key={i} className="mono small">{x}</li>)}
            </ul>
          </details>
        )}
        <div className="toolbar pdf-modal-actions"><span className="grow" />
          <button onClick={onClose}><X />{tr("shell.close")}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Quản lý danh sách chứng thư đã Trust. */
export function TrustManagerModal({ onClose }: { onClose: () => void }) {
  const tr = useT();
  const [list, setList] = useState<CertOut[] | null>(null);
  const [open, setOpen] = useState<string>("");
  const ver = useTrustVersion();
  useEffect(() => void pdfApi.trustList().then(setList).catch(() => setList([])), [ver]);
  return (
    <Modal title={<span className="sig-modal-title"><BadgeCheck />{tr("pdf.trustManager")}</span>} onClose={onClose} width={640}>
      <div className="sig-details">
        <p className="muted small">{tr("pdf.trustManagerHint")}</p>
        {!list ? <Loading variant="row" /> : !list.length ? <div className="muted">{tr("pdf.trustEmpty")}</div> : (
          <div className="cert-chain">
            {list.map((c) => (
              <div key={c.sha256} className="trust-row">
                <div className="grow">
                  <CertCard c={c} role={c.selfSigned ? tr("pdf.roleRoot") : c.isCa ? tr("pdf.roleCa") : tr("pdf.roleSigner")} open={open === c.sha256} onToggle={() => setOpen(open === c.sha256 ? "" : c.sha256)} />
                </div>
                <button className="icon-btn danger" title={tr("pdf.untrust")} aria-label={tr("pdf.untrust")} onClick={() => void untrustCert(c)}><Trash2 /></button>
              </div>
            ))}
          </div>
        )}
        <div className="toolbar pdf-modal-actions"><span className="grow" />
          <button onClick={onClose}><X />{tr("shell.close")}</button>
        </div>
      </div>
    </Modal>
  );
}
