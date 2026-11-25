import { memo, useEffect, useState } from "react";
import { ArrowLeftRight, Check, ExternalLink, FlaskConical, Globe, KeyRound, Languages, Save, ShieldAlert, Trash2, TriangleAlert, X } from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AppModule } from "../types";
import { Picker } from "../../shell/Picker";
import { Spinner } from "../../shell/Loading";
import { renderLog } from "../../shell/renderDebug";
import { useWorkbench } from "../../store/workbench";
import { t, useT } from "../../store/lang";

/* Web Translate: nhập link → mở trang thật trong cửa sổ riêng (`webtr-<n>`, Rust `webtr.rs`) và dịch chữ trên trang
 * theo thời gian thực (script `webtr_inject.js`). Trang ngoài chỉ gọi được lệnh dịch; khoá API ở keyring. */

type Provider = "google" | "google-cloud" | "deepl";
interface Cfg { provider: Provider; from: string; to: string }

const CFG_KEY = "devstation.webtr.cfg";
const HIST_KEY = "devstation.webtr.history";
const LANGS: { id: string; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "vi", label: "Tiếng Việt (vi)" },
  { id: "en", label: "English (en)" },
  { id: "zh-CN", label: "中文 简体 (zh-CN)" },
  { id: "zh-TW", label: "中文 繁體 (zh-TW)" },
  { id: "ja", label: "日本語 (ja)" },
  { id: "ko", label: "한국어 (ko)" },
  { id: "fr", label: "Français (fr)" },
  { id: "de", label: "Deutsch (de)" },
  { id: "es", label: "Español (es)" },
  { id: "ru", label: "Русский (ru)" },
  { id: "th", label: "ไทย (th)" },
];
const langLabel = (id: string) => (id === "auto" ? t("webtr.auto") : LANGS.find((l) => l.id === id)?.label ?? id);
/** Tên ngắn cho nút trên thanh nổi (vd "Tiếng Việt"). */
const langShort = (id: string) => langLabel(id).replace(/\s*\([^)]*\)$/, "");

const readCfg = (): Cfg => {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) ?? "{}");
    return { provider: c.provider ?? "google", from: c.from ?? "auto", to: c.to ?? "vi" };
  } catch { return { provider: "google", from: "auto", to: "vi" }; }
};
/** Thêm https:// khi người dùng gõ thiếu scheme (vd "example.com"). */
const normUrl = (u: string) => {
  const v = u.trim();
  return !v || /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
};
const readHist = (): string[] => {
  try { const h = JSON.parse(localStorage.getItem(HIST_KEY) ?? "[]"); return Array.isArray(h) ? h : []; } catch { return []; }
};

/** Chuỗi giao diện thanh nổi trong trang (theo ngôn ngữ app lúc mở). */
const barUi = () => ({
  showOriginal: t("webtr.barShowOriginal"),
  showTranslated: t("webtr.barShowTranslated"),
  original: t("webtr.barOriginal"),
  translating: t("webtr.barTranslating"),
  translated: t("webtr.barTranslated"),
  noBridge: t("webtr.barNoBridge"),
});

export async function openTranslated(url: string, cfg: Cfg) {
  if (!isTauri()) throw new Error(t("webtr.mustRunInsideTheApp"));
  await invoke<string>("webtr_open", { url, cfg, ui: { ...barUi(), targetName: langShort(cfg.to) } });
}

function TranslateView() {
  renderLog("TranslateView");
  const tr = useT();
  const [cfg, setCfgState] = useState<Cfg>(readCfg);
  const [url, setUrl] = useState("");
  const [hist, setHist] = useState<string[]>(readHist);
  const [err, setErr] = useState("");
  const [opening, setOpening] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState("");
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [keyErr, setKeyErr] = useState("");
  /** Vừa mở xong (hiện "✓ Đã mở trong cửa sổ mới" một lúc). */
  const [opened, setOpened] = useState(false);
  const needKey = cfg.provider !== "google";
  // Lý do chưa mở được (khoá nút Mở + ghi ngay dưới ô link) thay vì để lỗi tới lúc cửa sổ dịch chạy.
  const blockReason = needKey && !hasKey ? tr("webtr.needKey") : cfg.from === cfg.to ? tr("webtr.sameLang") : "";

  const setCfg = (p: Partial<Cfg>) => setCfgState((c) => {
    const n = { ...c, ...p };
    localStorage.setItem(CFG_KEY, JSON.stringify(n));
    return n;
  });

  useEffect(() => {
    setKey("");
    setTest(null);
    setKeyErr("");
    if (!needKey || !isTauri()) { setHasKey(false); return; }
    void invoke<boolean>("webtr_has_key", { provider: cfg.provider }).then(setHasKey).catch(() => setHasKey(false));
  }, [cfg.provider, needKey]);

  const open = async (u = url) => {
    const v = normUrl(u);
    if (!v || blockReason) return;
    setUrl(v);
    setErr("");
    setOpened(false);
    setOpening(true);
    try {
      await openTranslated(v, cfg);
      const h = [v, ...hist.filter((x) => x !== v)].slice(0, 30);
      setHist(h);
      localStorage.setItem(HIST_KEY, JSON.stringify(h));
      setOpened(true);
      setTimeout(() => setOpened(false), 4000);
      useWorkbench.getState().log(`✓ Translate ${langLabel(cfg.from)} → ${langLabel(cfg.to)}: ${v}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };

  const saveKey = async () => {
    if (!key.trim()) return;
    setKeyErr("");
    try {
      await invoke("webtr_save_key", { provider: cfg.provider, key });
      setHasKey(true);
      setKey("");
    } catch (e) { setKeyErr(tr("webtr.saveKeyFailed", { err: String(e) })); }
  };
  const forgetKey = async () => {
    await invoke("webtr_forget_key", { provider: cfg.provider }).catch(() => {});
    setHasKey(false);
  };
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await invoke<string>("webtr_test", { cfg: { ...cfg, from: "en" } });
      setTest({ ok: true, text: `✓ "Hello, how are you today?" → "${r}"` });
    } catch (e) {
      setTest({ ok: false, text: `✗ ${String(e)}` });
    } finally {
      setTesting(false);
    }
  };
  const swap = () => { if (cfg.from !== "auto") setCfg({ from: cfg.to, to: cfg.from }); };
  const clearHist = () => { setHist([]); localStorage.setItem(HIST_KEY, "[]"); };
  const removeHist = (u: string) => {
    const h = hist.filter((x) => x !== u);
    setHist(h);
    localStorage.setItem(HIST_KEY, JSON.stringify(h));
  };

  const providers: { id: Provider; label: string }[] = [
    { id: "google", label: tr("webtr.providerGoogle") },
    { id: "google-cloud", label: tr("webtr.providerGoogleCloud") },
    { id: "deepl", label: tr("webtr.providerDeepl") },
  ];

  return (
    <div className="webtr">
      <div className="webtr-box">
        <h2><Languages /> Web Translate</h2>
        <p className="muted small">{tr("webtr.intro")}</p>
        <div className="webtr-url">
          <input
            className="mono grow"
            value={url}
            autoFocus
            spellCheck={false}
            placeholder="https://example.com"
            onChange={(e) => { setUrl(e.target.value); setErr(""); setOpened(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") void open(); }}
          />
          <button className="primary" disabled={opening || !url.trim() || !!blockReason} title={blockReason} onClick={() => void open()}>
            {opening ? <Spinner /> : <ExternalLink />}{tr("webtr.open")}
          </button>
        </div>
        {err && <div className="error-box">{err}</div>}
        {!err && url.trim() && blockReason && <div className="webtr-msg webtr-warn"><TriangleAlert />{blockReason}</div>}
        {!err && opened && <div className="webtr-msg webtr-ok" aria-live="polite"><Check />{tr("webtr.opened")}</div>}

        <div className="webtr-row">
          <div className="field">
            <span className="field-cap">{tr("webtr.from")}</span>
            <div className="picker-field">
              <Picker label={<span className="ellipsis">{langLabel(cfg.from)}</span>}
                items={LANGS.map((l) => ({ id: l.id, label: langLabel(l.id), selected: l.id === cfg.from }))}
                onPick={(id) => setCfg({ from: id })} />
            </div>
          </div>
          <button className="icon-btn webtr-swap" disabled={cfg.from === "auto"} title={tr("webtr.swap")} aria-label={tr("webtr.swap")} onClick={swap}><ArrowLeftRight /></button>
          <div className="field">
            <span className="field-cap">{tr("webtr.to")}</span>
            <div className="picker-field">
              <Picker label={<span className="ellipsis">{langLabel(cfg.to)}</span>}
                items={LANGS.filter((l) => l.id !== "auto").map((l) => ({ id: l.id, label: l.label, selected: l.id === cfg.to }))}
                onPick={(id) => setCfg({ to: id })} />
            </div>
          </div>
          <div className="field grow">
            <span className="field-cap">{tr("webtr.provider")}</span>
            <div className="picker-field">
              <Picker label={<span className="ellipsis">{providers.find((p) => p.id === cfg.provider)?.label}</span>}
                items={providers.map((p) => ({ id: p.id, label: p.label, selected: p.id === cfg.provider }))}
                onPick={(id) => setCfg({ provider: id as Provider })} />
            </div>
          </div>
        </div>

        {cfg.provider === "google" && <div className="webtr-msg webtr-warn"><TriangleAlert />{tr("webtr.googleFreeHint")}</div>}
        {needKey && (
          <div className="field">
            <span className="field-cap">API key</span>
            <div className="webtr-key">
              <KeyRound />
              {hasKey ? (
                <>
                  <span className="grow small webtr-ok">{tr("webtr.keySaved")}</span>
                  <button onClick={() => void forgetKey()}><Trash2 />{tr("webtr.forgetKey")}</button>
                </>
              ) : (
                <>
                  <input type="password" className="mono grow" value={key} placeholder={tr("webtr.keyPlaceholder")} aria-label="API key"
                    onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void saveKey(); }} />
                  <button disabled={!key.trim()} onClick={() => void saveKey()}><Save />{tr("webtr.saveKey")}</button>
                </>
              )}
            </div>
            {keyErr && <div className="error-box">{keyErr}</div>}
          </div>
        )}
        <div className="webtr-msg"><ShieldAlert />{tr("webtr.privacyHint")}</div>
        <div className="toolbar">
          <button disabled={testing || (needKey && !hasKey)} onClick={() => void runTest()}>
            {testing ? <Spinner /> : <FlaskConical />}{tr("webtr.test")}
          </button>
          {test && <span className={`small ellipsis ${test.ok ? "webtr-ok" : "webtr-bad"}`} title={test.text} aria-live="polite">{test.text}</span>}
        </div>

        {hist.length > 0 && (
          <div className="webtr-hist">
            <div className="webtr-hist-h">
              <span className="field-cap">{tr("webtr.recent")}</span>
              <span className="muted small grow">{tr("webtr.recentHint")}</span>
              <button className="icon-btn" title={tr("webtr.clearRecent")} aria-label={tr("webtr.clearRecent")} onClick={clearHist}><Trash2 /></button>
            </div>
            <div className="webtr-hist-list">
              {hist.map((h) => <HistRow key={h} url={h} onPick={setUrl} onOpen={(u) => void open(u)} onRemove={removeHist} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const HistRow = memo(function HistRow({ url, onPick, onOpen, onRemove }: {
  url: string; onPick: (u: string) => void; onOpen: (u: string) => void; onRemove: (u: string) => void;
}) {
  const tr = useT();
  return (
    <div className="side-item webtr-hist-row" tabIndex={0} title={url} onClick={() => onPick(url)} onDoubleClick={() => onOpen(url)}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(url); }}>
      <Globe />
      <span className="ellipsis grow mono">{url}</span>
      <button className="icon-btn" title={tr("webtr.remove")} aria-label={tr("webtr.remove")} onClick={(e) => { e.stopPropagation(); onRemove(url); }}><X /></button>
    </div>
  );
});

const translateApp: AppModule = {
  View: TranslateView,
  commands: () => readHist().slice(0, 10).map((u) => ({
    id: `webtr.open.${u}`, group: "Web Translate", title: `${t("webtr.open")} ${u}`, run: () => void openTranslated(u, readCfg()),
  })),
};

export default translateApp;
