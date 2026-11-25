import { renderLog } from "../../shell/renderDebug";
import { copyText } from "../../shell/clipboard";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Binary, Braces, CircleCheck, CircleX, Copy, Download, FileCode, FileKey, FileUp, Info, KeyRound, TriangleAlert, Wrench, X, type LucideIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { JsonView, parseJsonValue } from "../../shell/JsonView";
import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";
import { TabbedLayout } from "../../shell/TabbedLayout";
import { listNav, rowKey } from "../../shell/listNav";
import { t, useT } from "../../store/lang";
import type { TKey } from "../../store/lang";
import { parseCsrOrCert, spkiToJwk, spkiToPem, verifyCsrSignature, type CsrInfo } from "./csr";
import { algSpec, b64urlToText, JwtVerifyError, timeClaims, verifyJwt, type VerifyResult } from "./jwtVerify";

type ToolId = "base64-decode" | "base64-encode" | "json" | "jwt" | "csr";

/** Base64 cho mảng byte, chia khúc để không tràn stack với dữ liệu lớn. */
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Tách header + payload của JWT (ném lỗi nếu không giải được). */
function decodeJwt(s: string): { header: unknown; payload: unknown } {
  const parts = s.trim().split(".");
  if (parts.length < 2) throw new Error(t("tools.tokenMustHaveAtLeast2"));
  return { header: JSON.parse(b64urlToText(parts[0])), payload: JSON.parse(b64urlToText(parts[1])) };
}

/** Base64 → chữ; thử base64 chuẩn trước, lỗi thì thử base64url (-_ → +/, bỏ khoảng trắng, thêm '='). */
function decodeB64(s: string): string {
  const toText = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
  try {
    return toText(s.trim());
  } catch {
    let u = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (u.length % 4) u += "=".repeat(4 - (u.length % 4));
    try {
      return toText(u);
    } catch {
      throw new Error(t("tools.b64Invalid"));
    }
  }
}

/** Lỗi JSON.parse → "line N, column M: <message>" (tính từ "position N", hoặc lấy "(line N column M)" của V8 mới). */
function jsonErrorText(e: unknown, src: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  const base = msg.replace(/\s*\(line \d+ column \d+\)/, "").replace(/\s+(in JSON )?at position \d+/, "");
  const lc = /\(line (\d+) column (\d+)\)/.exec(msg);
  if (lc) return `line ${lc[1]}, column ${lc[2]}: ${base}`;
  const pos = /position (\d+)/.exec(msg);
  if (!pos) return msg;
  const before = src.slice(0, Number(pos[1]));
  const line = before.split("\n").length;
  const col = before.length - before.lastIndexOf("\n");
  return `line ${line}, column ${col}: ${base}`;
}

/** Mỗi tool là hàm thuần: vào chuỗi, ra chuỗi hoặc ném lỗi (lỗi là kết quả bình thường). */
const TOOLS: Record<ToolId, { name: string; icon: LucideIcon; run: (s: string) => string }> = {
  "base64-decode": {
    name: "Base64 Decode",
    icon: Binary,
    run: decodeB64,
  },
  "base64-encode": {
    name: "Base64 Encode",
    icon: FileCode,
    run: (s) => bytesToB64(new TextEncoder().encode(s)),
  },
  json: {
    name: "JSON Format",
    icon: Braces,
    run: (s) => {
      let v: unknown;
      try {
        v = JSON.parse(s);
      } catch (e) {
        throw new Error(jsonErrorText(e, s));
      }
      return JSON.stringify(v, null, 2);
    },
  },
  jwt: {
    name: "JWT Decode",
    icon: KeyRound,
    run: (s) => {
      const { header, payload } = decodeJwt(s);
      return `// header\n${JSON.stringify(header, null, 2)}\n\n// payload\n${JSON.stringify(payload, null, 2)}`;
    },
  },
  csr: { name: "CSR → Public key", icon: FileKey, run: (s) => spkiToPem(parseCsrOrCert(s).spki) },
};

export function openTool(id: ToolId, input = "") {
  useWorkbench.getState().openTab({
    id: `tools:${id}`,
    appId: "tools",
    title: TOOLS[id].name,
    payload: { tool: id, input },
  });
}

function Sidebar() {
  const tr = useT();
  const activeTabId = useWorkbench((s) => s.apps.tools.activeTabId);
  return (
    <div className="side-list" role="listbox" onKeyDown={(e) => listNav(e, { row: ".side-item", select: true })}>
      <div className="side-head"><span>{tr("tools.tools")}</span></div>
      {(Object.keys(TOOLS) as ToolId[]).map((id) => {
        const Icon = TOOLS[id].icon;
        return (
          <div
            key={id}
            className={`side-item${activeTabId === `tools:${id}` ? " sel" : ""}`}
            tabIndex={0}
            role="option"
            aria-selected={activeTabId === `tools:${id}`}
            onClick={() => openTool(id)}
            onKeyDown={(e) => rowKey(e, { Enter: () => openTool(id) })}
          >
            <Icon />{TOOLS[id].name}
          </div>
        );
      })}
    </div>
  );
}

/** Màn chào khi chưa mở tool nào: liệt kê tool thành nút bấm. */
function ToolsEmpty() {
  const tr = useT();
  return (
    <div className="welcome">
      <h1><Wrench /> {tr("apps.tools.title")}</h1>
      <p className="muted">{tr("apps.tools.description")}</p>
      <div className="toolbar tools-welcome">
        {(Object.keys(TOOLS) as ToolId[]).map((id) => {
          const Icon = TOOLS[id].icon;
          return <button key={id} onClick={() => openTool(id)}><Icon />{TOOLS[id].name}</button>;
        })}
      </div>
    </div>
  );
}

function runTool(tool: ToolId, input: string): { output: string; error: string } {
  if (!input.trim()) return { output: "", error: "" };
  try {
    return { output: TOOLS[tool].run(input), error: "" };
  } catch (e) {
    return { output: "", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Ô kết quả chung: tiêu đề + Copy + lỗi hoặc nội dung. `preview` cho phép hiện bản cắt ngắn (Copy vẫn lấy đủ). */
function ResultPane({ output, error, preview, children, body }: { output: string; error: string; preview?: string; children?: React.ReactNode; body?: React.ReactNode }) {
  const tr = useT();
  return (
    <div className="pane">
      <div className="pane-title">
        {tr("tools.result")} <span className="grow" />
        {output && <button onClick={() => copyText(output)}><Copy />Copy</button>}
      </div>
      {children}
      {error ? <div className="error-box"><TriangleAlert /> {error}</div> : body ?? <pre className="io mono">{preview ?? output}</pre>}
    </div>
  );
}

function TabView({ tab }: { tab: Tab }) {
  const id = tab.payload.tool as ToolId;
  const initial = String(tab.payload.input ?? "");
  if (id === "jwt") return <JwtView initial={initial} />;
  if (id === "base64-encode") return <Base64EncodeView initial={initial} />;
  if (id === "csr") return <CsrView initial={initial} />;
  return <TextToolView tool={id} initial={initial} />;
}

function TextToolView({ tool, initial }: { tool: ToolId; initial: string }) {
  renderLog("TextToolView");
  const tr = useT();
  const [input, setInput] = useState(initial);
  // Gõ chữ: ô nhập cập nhật ngay, phần biến đổi + vẽ kết quả (có thể lớn) chạy ở lượt render hoãn (deferred).
  const dInput = useDeferredValue(input);
  const res = useMemo(() => runTool(tool, dInput), [tool, dInput]);
  // Base64 Decode ra JSON → tự format đẹp (tô màu), nút Pretty/Raw để xem bản gốc; Copy lấy đúng bản đang xem.
  const json = useMemo(() => (tool === "base64-decode" && !res.error ? parseJsonValue(res.output) : undefined), [tool, res]);
  const [pretty, setPretty] = useState(() => localStorage.getItem("tools.b64Pretty") !== "0");
  const showPretty = json !== undefined && pretty;
  const prettyText = useMemo(() => (showPretty ? JSON.stringify(json, null, 2) : ""), [showPretty, json]);
  const output = showPretty ? prettyText : res.output;
  const error = res.error;
  return (
    <div className="view">
      <div className="split">
        <div className="pane">
          <div className="pane-title">{tr("tools.input")}</div>
          <textarea className="io mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder={tr("tools.pasteHere")} />
        </div>
        <ResultPane output={output} error={error} body={showPretty ? <JsonView value={json} className="io" /> : undefined}>
          {json !== undefined && (
            <div className="tool-note">
              <span className="badge rjson-badge">JSON</span>
              <span className="grow" />
              <button onClick={() => setPretty((v) => { localStorage.setItem("tools.b64Pretty", v ? "0" : "1"); return !v; })}>
                <Braces />{pretty ? tr("tools.showRaw") : tr("tools.prettyJson")}
              </button>
            </div>
          )}
        </ResultPane>
      </div>
    </div>
  );
}

/* ---------- Base64 Encode: chữ hoặc file ---------- */

const MAX_FILE = 20 * 1024 * 1024;
/** Hiện tối đa chừng này ký tự trong ô kết quả (vẽ chuỗi vài chục MB làm đơ WebView). */
const PREVIEW_CHARS = 200_000;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface FileB64 {
  name: string;
  size: number;
  dataUri: string;
}

function Base64EncodeView({ initial }: { initial: string }) {
  renderLog("Base64EncodeView");
  const tr = useT();
  const [input, setInput] = useState(initial);
  const [file, setFile] = useState<FileB64 | null>(null);
  const [fileErr, setFileErr] = useState("");
  const [keepUri, setKeepUri] = useState(false);
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const pick = useRef<HTMLInputElement>(null);

  const load = (f: File) => {
    setFileErr("");
    if (f.size > MAX_FILE) {
      setFile(null);
      setFileErr(tr("tools.fileTooLarge", { name: f.name, size: fmtSize(f.size), max: fmtSize(MAX_FILE) }));
      return;
    }
    setReading(true);
    const r = new FileReader();
    r.onload = () => {
      setReading(false);
      setFile({ name: f.name, size: f.size, dataUri: String(r.result ?? "") });
    };
    r.onerror = () => {
      setReading(false);
      setFile(null);
      setFileErr(tr("tools.fileReadError", { name: f.name, error: String(r.error?.message ?? r.error) }));
    };
    r.readAsDataURL(f);
  };

  // Hoãn ô nhập + memo: kéo file qua (đổi `over`), gõ chữ… không cắt lại chuỗi base64 vài chục MB mỗi lần render.
  const dInput = useDeferredValue(input);
  const { output, error } = useMemo(() => {
    if (file) {
      // FileReader trả "data:<mime>;base64,<dữ liệu>" — file rỗng có thể là "data:" trơn.
      const comma = file.dataUri.indexOf(",");
      return { output: keepUri ? file.dataUri : comma >= 0 ? file.dataUri.slice(comma + 1) : "", error: fileErr };
    }
    if (fileErr) return { output: "", error: fileErr };
    return runTool("base64-encode", dInput);
  }, [file, keepUri, fileErr, dInput]);
  const truncated = output.length > PREVIEW_CHARS;
  const preview = useMemo(() => (truncated ? output.slice(0, PREVIEW_CHARS) : undefined), [truncated, output]);

  return (
    <div className="view">
      <div className="split">
        <div
          className={`pane${over ? " file-drop" : ""}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
          }}
          onDrop={(e) => {
            const f = e.dataTransfer.files[0];
            if (!f) return;
            e.preventDefault();
            setOver(false);
            load(f);
          }}
        >
          <div className="pane-title">
            {tr("tools.input")} <span className="grow" />
            <button onClick={() => pick.current?.click()} title={tr("tools.chooseFileHint")}><FileUp />{tr("tools.chooseFile")}</button>
            <input
              ref={pick}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) load(f);
                e.target.value = "";
              }}
            />
          </div>
          {file || fileErr || reading ? (
            <div className="tool-file">
              <div className="tool-file-row">
                <FileUp />
                {reading ? <span className="muted">{tr("tools.readingFile")}</span> : file ? <><b className="ellipsis">{file.name}</b><span className="muted">{fmtSize(file.size)}</span></> : <span className="muted">{tr("tools.noFile")}</span>}
                <span className="grow" />
                <button onClick={() => { setFile(null); setFileErr(""); }}><X />{tr("tools.backToText")}</button>
              </div>
              {file && (
                <label className="tool-check">
                  <input type="checkbox" checked={keepUri} onChange={(e) => setKeepUri(e.target.checked)} />
                  {tr("tools.keepDataUri")}
                </label>
              )}
            </div>
          ) : (
            <textarea className="io mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder={tr("tools.pasteOrDropFile")} />
          )}
          {over && <div className="file-drop-hint"><FileUp /> {tr("tools.dropFileHere")}</div>}
        </div>
        <ResultPane output={output} error={error} preview={preview}>
          {truncated && <div className="tool-note"><Info /> {tr("tools.previewTruncated", { n: PREVIEW_CHARS.toLocaleString(), total: output.length.toLocaleString() })}</div>}
        </ResultPane>
      </div>
    </div>
  );
}

/* ---------- JWT: giải mã + xác minh chữ ký ---------- */

type VerifyState = { kind: "idle" } | { kind: "busy" } | VerifyResult | { kind: "error"; msg: string };

function verifyErrorText(e: unknown): string {
  if (e instanceof JwtVerifyError) {
    const map: Record<JwtVerifyError["code"], TKey> = {
      pemPrivate: "tools.jwtErrPemPrivate",
      pemCert: "tools.jwtErrPemCert",
      pemUnknown: "tools.jwtErrPemUnknown",
      keyFormat: "tools.jwtErrKeyFormat",
      unsupportedAlg: "tools.jwtErrUnsupportedAlg",
      noKey: "tools.jwtNeedKey",
      badToken: "tools.jwtErrBadToken",
      importFailed: "tools.jwtErrImport",
    };
    return t(map[e.code], { p: e.detail });
  }
  return e instanceof Error ? e.message : String(e);
}

function JwtView({ initial }: { initial: string }) {
  renderLog("JwtView");
  const tr = useT();
  const [input, setInput] = useState(initial);
  const [key, setKey] = useState("");
  const [b64Secret, setB64Secret] = useState(false);
  const [verify, setVerify] = useState<VerifyState>({ kind: "idle" });

  const { output, error } = runTool("jwt", input);
  let alg = "";
  let payload: unknown = null;
  if (!error && input.trim()) {
    try {
      const d = decodeJwt(input);
      payload = d.payload;
      alg = String((d.header as { alg?: unknown })?.alg ?? "");
    } catch {
      /* lỗi đã hiện qua runTool */
    }
  }
  const isHmac = algSpec(alg)?.family === "HMAC";
  const unsignedAlg = alg.toLowerCase() === "none";

  useEffect(() => {
    if (!input.trim() || error) return setVerify({ kind: "idle" });
    if (!key.trim() && !unsignedAlg) return setVerify({ kind: "idle" });
    let cancelled = false;
    setVerify({ kind: "busy" });
    const h = setTimeout(() => {
      verifyJwt(input, key, b64Secret).then(
        (r) => !cancelled && setVerify(r),
        (e) => !cancelled && setVerify({ kind: "error", msg: verifyErrorText(e) }),
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [input, key, b64Secret, error, unsignedAlg]);

  const claims = timeClaims(payload);
  const claimText = (c: (typeof claims)[number]) => {
    const p = c.date.toLocaleString();
    switch (c.state) {
      case "expired": return tr("tools.expiredSince", { p });
      case "valid": return tr("tools.validUntil", { p });
      case "notYet": return tr("tools.jwtNotYetValid", { p });
      case "active": return tr("tools.jwtActiveSince", { p });
      case "future": return tr("tools.jwtIssuedFuture", { p });
      default: return tr("tools.jwtIssuedAt", { p });
    }
  };
  const bad = (s: string) => s === "expired" || s === "notYet" || s === "future";

  return (
    <div className="view">
      <div className="split">
        <div className="pane">
          <div className="pane-title">{tr("tools.input")}</div>
          <textarea className="io mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder={tr("tools.pasteHere")} />
          <div className="pane-title jwt-key-title">
            <KeyRound />{tr("tools.jwtVerifyTitle")}{alg && <span className="muted">· {alg}</span>}
            <span className="grow" />
            {isHmac && (
              <label className="tool-check">
                <input type="checkbox" checked={b64Secret} onChange={(e) => setB64Secret(e.target.checked)} />
                {tr("tools.jwtSecretB64")}
              </label>
            )}
          </div>
          <textarea
            className="io mono jwt-key"
            value={key}
            spellCheck={false}
            onChange={(e) => setKey(e.target.value)}
            placeholder={isHmac ? tr("tools.jwtSecretPlaceholder") : tr("tools.jwtKeyPlaceholder")}
          />
        </div>
        <ResultPane output={output} error={error}>
          {!error && input.trim() && (
            <div className="jwt-info">
              {verify.kind === "valid" && <div className="jwt-status ok"><CircleCheck />{tr("tools.jwtSigValid", { alg: verify.alg })}</div>}
              {verify.kind === "invalid" && <div className="jwt-status bad"><CircleX />{tr("tools.jwtSigInvalid", { alg: verify.alg })}</div>}
              {verify.kind === "unsigned" && <div className="jwt-status warn"><TriangleAlert />{tr("tools.jwtUnsigned")}</div>}
              {verify.kind === "error" && <div className="jwt-status bad"><TriangleAlert />{verify.msg}</div>}
              {verify.kind === "busy" && <div className="jwt-status muted"><KeyRound />{tr("tools.jwtVerifying")}</div>}
              {verify.kind === "idle" && <div className="jwt-status muted"><Info />{tr("tools.jwtNeedKey")}</div>}
              {claims.length === 0 && <div className="jwt-claim muted">{tr("tools.noExp")}</div>}
              {claims.map((c) => (
                <div key={c.name} className={`jwt-claim${bad(c.state) ? " bad" : c.state === "valid" ? " ok" : ""}`}>
                  <code>{c.name}</code> {claimText(c)}
                </div>
              ))}
            </div>
          )}
        </ResultPane>
      </div>
    </div>
  );
}


/* ---------- CSR / Certificate → Public key ---------- */

function CsrView({ initial }: { initial: string }) {
  renderLog("CsrView");
  const tr = useT();
  const [input, setInput] = useState(initial);
  const [der, setDer] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [fmt, setFmt] = useState<"pem" | "jwk">("pem");
  const [over, setOver] = useState(false);
  const [sig, setSig] = useState<boolean | null | "busy">(null);
  const [saveErr, setSaveErr] = useState("");
  const pick = useRef<HTMLInputElement>(null);

  // Chỉ parse lại khi nội dung đổi (không parse khi đổi PEM/JWK hay trạng thái kiểm chữ ký).
  const { info, error } = useMemo((): { info: CsrInfo | null; error: string } => {
    if (!der && !input.trim()) return { info: null, error: "" };
    try {
      return { info: parseCsrOrCert(der ? der.bytes : input), error: "" };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { info: null, error: m === "privateKey" ? tr("tools.csrPrivateKey") : tr("tools.csrBad") };
    }
  }, [der, input, tr]);
  const pem = useMemo(() => (info ? spkiToPem(info.spki) : ""), [info]);
  const jwk = useMemo(() => (info ? spkiToJwk(info.spki) : null), [info]);
  const output = !info ? "" : fmt === "jwk" ? (jwk ? JSON.stringify(jwk, null, 2) : "") : pem;

  // Kiểm chữ ký (CSR tự ký bằng chính khoá của nó; cert tự ký cũng kiểm được, cert do CA ký thì báo không kiểm).
  const sigKey = info ? `${info.sigOid}:${info.signature.length}:${info.spki.length}:${input.length}:${der?.name ?? ""}` : "";
  useEffect(() => {
    if (!info) { setSig(null); return; }
    const selfSigned = info.kind === "csr" || (info.kind === "cert" && info.subject === info.issuer);
    if (!selfSigned) { setSig(null); return; }
    let alive = true;
    setSig("busy");
    void verifyCsrSignature(info).then((ok) => alive && setSig(ok)).catch(() => alive && setSig(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigKey]);

  const load = (f: File) => {
    const r = new FileReader();
    r.onload = () => {
      const bytes = new Uint8Array(r.result as ArrayBuffer);
      const text = new TextDecoder().decode(bytes);
      if (/-----BEGIN /.test(text)) { setDer(null); setInput(text); } else setDer({ name: f.name, bytes });
    };
    r.readAsArrayBuffer(f);
  };

  return (
    <div className="view">
      <div className="split">
        <div
          className={`pane${over ? " file-drop" : ""}`}
          onDragOver={(e) => { if (!e.dataTransfer.types.includes("Files")) return; e.preventDefault(); setOver(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
          onDrop={(e) => { const f = e.dataTransfer.files[0]; if (!f) return; e.preventDefault(); setOver(false); load(f); }}
        >
          <div className="pane-title">
            {tr("tools.input")} <span className="grow" />
            <button onClick={() => pick.current?.click()} title={tr("tools.csrFileHint")}><FileUp />{tr("tools.chooseFile")}</button>
            <input ref={pick} type="file" hidden accept=".csr,.pem,.crt,.cer,.der,.req,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); e.target.value = ""; }} />
          </div>
          {der ? (
            <div className="tool-file">
              <div className="tool-file-row"><FileUp /><b className="ellipsis">{der.name}</b><span className="muted small">DER · {der.bytes.length} B</span></div>
              <div><button onClick={() => setDer(null)}><X />{tr("tools.backToText")}</button></div>
            </div>
          ) : (
            <textarea className="io mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder={tr("tools.csrPlaceholder")} />
          )}
        </div>
        <ResultPane output={output} error={error}>
          {info && (
            <div className="jwt-info csr-info">
              {sig === true && <div className="jwt-status ok"><CircleCheck />{tr(info.kind === "csr" ? "tools.csrSigValid" : "tools.certSelfSigValid")}</div>}
              {sig === false && <div className="jwt-status bad"><CircleX />{tr("tools.csrSigInvalid")}</div>}
              {sig === null && info.kind === "cert" && info.subject !== info.issuer && <div className="jwt-status muted"><Info />{tr("tools.certCaSigned")}</div>}
              {info.kind === "csr-info" && <div className="jwt-status warn"><TriangleAlert />{tr("tools.csrInfoUnsigned")}</div>}
              <dl className="csr-dl">
                <dt>{tr("tools.csrType")}</dt><dd>{info.kind === "csr" ? "CSR (PKCS#10)" : info.kind === "csr-info" ? "CertificationRequestInfo" : "Certificate (X.509)"}</dd>
                <dt>Subject</dt><dd className="mono">{info.subject || "—"}</dd>
                {info.issuer !== undefined && <><dt>Issuer</dt><dd className="mono">{info.issuer}</dd></>}
                {info.validFrom && <><dt>{tr("tools.certValidity")}</dt><dd>{info.validFrom} → {info.validTo}</dd></>}
                <dt>{tr("tools.csrKey")}</dt><dd>{info.key.alg}{info.key.detail ? ` · ${info.key.detail}` : ""}</dd>
                {info.kind !== "csr-info" && <><dt>{tr("tools.csrSigAlg")}</dt><dd>{info.sigAlg}</dd></>}
              </dl>
              <div className="subtabs csr-fmt">
                <button className={fmt === "pem" ? "on" : ""} onClick={() => setFmt("pem")}><KeyRound />PEM</button>
                <button className={fmt === "jwk" ? "on" : ""} onClick={() => setFmt("jwk")} disabled={!jwk}><Braces />JWK</button>
                <span className="grow" />
                <button
                  onClick={() => {
                    setSaveErr("");
                    saveKey(output, fmt).catch((e) => setSaveErr(e instanceof Error ? e.message : String(e)));
                  }}
                  disabled={!output}
                ><Download />{tr("tools.csrSave")}</button>
              </div>
              {saveErr && <div className="error-box"><TriangleAlert /> {saveErr}</div>}
            </div>
          )}
        </ResultPane>
      </div>
    </div>
  );
}

async function saveKey(content: string, fmt: "pem" | "jwk") {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: fmt === "pem" ? "public.pem" : "public.jwk.json", filters: [{ name: fmt.toUpperCase(), extensions: [fmt === "pem" ? "pem" : "json"] }] });
  if (typeof path !== "string") return;
  await invoke("write_text_file", { path, content });
  useWorkbench.getState().log(`${t("tools.savedTo")} → ${path}`);
}

const toolsApp: AppModule = {
  View: () => <TabbedLayout appId="tools" Sidebar={Sidebar} TabView={TabView} empty={<ToolsEmpty />} />,
  commands: () =>
    (Object.keys(TOOLS) as ToolId[]).map((id) => ({
      id: `tools.${id}`,
      group: t("tools.tools2"),
      title: TOOLS[id].name,
      run: () => openTool(id),
    })),
};

export default toolsApp;
