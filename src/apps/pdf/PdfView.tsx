import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  BadgeCheck, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, FileClock, FileSignature, FolderOpen, LayoutGrid, ListTree, Lock,
  LockOpen, MoreHorizontal, PanelLeft, Printer, RefreshCw, RotateCw, Search, Star, X, ZoomIn, ZoomOut,
} from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Tab } from "../types";
import { useWorkbench } from "../../store/workbench";
import { t, useT, type TKey } from "../../store/lang";
import { Picker } from "../../shell/Picker";
import { ContextMenu, type CtxItem } from "../../shell/ContextMenu";
import { Splitter, useSplitSize } from "../../shell/Resizable";
import { Loading, Spinner } from "../../shell/Loading";
import { confirmDialog } from "../../shell/confirm";
import { copyText } from "../../shell/clipboard";
import { listNav, rowKey } from "../../shell/listNav";
import { loadDocument, pdfjsLib, viewerLib } from "./pdfjs";
import { pdfApi, type SigOut, type VerifyOut } from "./api";
import { docBytes, fmtTime, getDoc, openPdfBytes, verifyDoc, openPdfDialog, setDefaultPdfApp, useTrustVersion } from "./store";
import { docSummary, SigDetailsModal, SigIcon, sigWarn, TrustManagerModal } from "./SigDetails";
import { printPdf } from "./print";

type Side = "thumbs" | "outline" | "sigs";
const SIDE_KEY = "devstation.pdf.side";
const ZOOMS = ["auto", "page-fit", "page-width", "0.5", "0.75", "1", "1.25", "1.5", "2", "3", "4"];
const zoomLabel = (v: string) =>
  v === "auto" ? t("pdf.zoomAuto") : v === "page-fit" ? t("pdf.zoomFit") : v === "page-width" ? t("pdf.zoomWidth") : `${Math.round(Number(v) * 100)}%`;

/** Trang hiện tại dạng store (subscribe) — để thumbnail chỉ vẽ lại cái vừa (bỏ) chọn, không vẽ lại cả danh sách. */
function pageStore() {
  let cur = 1;
  const subs = new Set<() => void>();
  return {
    get: () => cur,
    set: (n: number) => { if (n !== cur) { cur = n; subs.forEach((f) => f()); } },
    sub: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  };
}
type PageStore = ReturnType<typeof pageStore>;

interface Ctx {
  pdf: PDFDocumentProxy;
  task: { destroy(): Promise<void> };
  viewer: InstanceType<typeof viewerLib.PDFViewer>;
  link: InstanceType<typeof viewerLib.PDFLinkService>;
  bus: InstanceType<typeof viewerLib.EventBus>;
}

/** Mở link ngoài trong PDF: hỏi trước (PDF là dữ liệu không tin cậy) rồi mở bằng trình duyệt. */
async function openExternal(url: string) {
  const ok = await confirmDialog({ title: t("pdf.openLinkTitle"), message: t("pdf.openLinkMsg", { url }), confirmLabel: t("pdf.openLink"), danger: false });
  if (ok) await pdfApi.openUrl(url).catch((e) => useWorkbench.getState().log(`✗ ${String(e)}`));
}

export function PdfTab({ tab }: { tab: Tab }) {
  const tr = useT();
  const doc = getDoc(tab.id);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const ctx = useRef<Ctx | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "password" | "error">("loading");
  const [error, setError] = useState("");
  const [pwWrong, setPwWrong] = useState(false);
  const [pw, setPw] = useState("");
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [zoom, setZoom] = useState({ preset: "", scale: 1 });
  const [side, setSideRaw] = useState<Side | null>(() => (localStorage.getItem(SIDE_KEY) as Side | null) || null);
  const [sideW, setSideW] = useSplitSize("pdf.side", 220, 150, 480);
  const [find, setFind] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [matches, setMatches] = useState({ current: 0, total: 0, notFound: false });
  const [verify, setVerify] = useState<VerifyOut | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [details, setDetails] = useState<SigOut | null>(null);
  const [trustOpen, setTrustOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [printing, setPrinting] = useState<{ i: number; n: number } | null>(null);
  const printSignal = useRef({ cancelled: false });
  const fields = useRef(new Map<string, { page: number; rect: number[] }>());
  const trustVer = useTrustVersion();
  const pageSt = useMemo(() => pageStore(), []);

  const setSide = (s: Side | null) => {
    setSideRaw(s);
    if (s) localStorage.setItem(SIDE_KEY, s); else localStorage.removeItem(SIDE_KEY);
  };

  /* ── Mở tài liệu (lại khi nhập mật khẩu) ── */
  const open = useCallback(async (password?: string) => {
    if (!doc || !scrollRef.current || !viewerRef.current) return;
    setState("loading");
    try {
      // File có đường dẫn: giao hẳn byte cho pdf.js (nó chuyển buffer sang worker — không chép) rồi bỏ khỏi RAM tab;
      // mở lại (mật khẩu) thì đọc lại từ đĩa. Kéo-thả: đưa bản sao, giữ bản gốc (không đọc lại được).
      let data: Uint8Array;
      if (doc.path) {
        data = doc.bytes ?? (await docBytes(doc));
        doc.bytes = undefined;
      } else {
        data = (doc.bytes ?? new Uint8Array()).slice();
      }
      const task = loadDocument(data, password);
      const p = await task.promise;
      const old = ctx.current;
      if (old) { old.viewer.setDocument(null as unknown as PDFDocumentProxy); void old.task.destroy(); }
      const bus = new viewerLib.EventBus();
      const link = new viewerLib.PDFLinkService({ eventBus: bus, externalLinkTarget: viewerLib.LinkTarget.BLANK, externalLinkRel: "noopener noreferrer nofollow" });
      const findController = new viewerLib.PDFFindController({ eventBus: bus, linkService: link });
      const viewer = new viewerLib.PDFViewer({
        container: scrollRef.current,
        viewer: viewerRef.current,
        eventBus: bus,
        linkService: link,
        findController,
        textLayerMode: 1,
        annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
      });
      link.setViewer(viewer);
      bus.on("pagesinit", () => { viewer.currentScaleValue = "1"; }); // mặc định 100%
      bus.on("pagechanging", (e: { pageNumber: number }) => { setPage(e.pageNumber); setPageInput(String(e.pageNumber)); pageSt.set(e.pageNumber); });
      bus.on("scalechanging", (e: { scale: number; presetValue?: string }) => setZoom({ preset: e.presetValue ?? "", scale: e.scale }));
      bus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) => setMatches((m) => ({ ...m, ...e.matchesCount })));
      bus.on("updatefindcontrolstate", (e: { state: number; matchesCount?: { current: number; total: number } }) =>
        setMatches({ current: e.matchesCount?.current ?? 0, total: e.matchesCount?.total ?? 0, notFound: e.state === viewerLib.FindState.NOT_FOUND }));
      viewer.setDocument(p);
      link.setDocument(p, null);
      ctx.current = { pdf: p, task, viewer, link, bus };
      setPdf(p);
      setPages(p.numPages);
      setState("ready");
      // Vị trí ô chữ ký (để bấm chữ ký trong danh sách → nhảy tới đúng chỗ).
      void p.getFieldObjects().then((objs) => {
        fields.current.clear();
        if (!objs) return;
        const entries: [string, unknown[]][] = objs instanceof Map ? [...objs.entries()] : Object.entries(objs as Record<string, unknown[]>);
        for (const [name, arr] of entries) {
          for (const o of arr as { type?: string; page?: number; rect?: number[] }[]) {
            if (o.type === "signature" && typeof o.page === "number" && o.rect) fields.current.set(name, { page: o.page, rect: o.rect });
          }
        }
      }).catch(() => {});
    } catch (e) {
      const err = e as { name?: string; code?: number; message?: string };
      if (err?.name === "PasswordException") {
        setPwWrong(err.code === 2);
        setState("password");
      } else {
        setError(err?.message ?? String(e));
        setState("error");
      }
    }
  }, [doc]);

  useEffect(() => {
    void open();
    return () => {
      const c = ctx.current;
      ctx.current = null;
      if (c) void c.task.destroy();
    };
  }, [open]);

  /* ── Kiểm chữ ký (phía Rust) — chạy lại khi danh sách Trust đổi ── */
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    setVerifying(true);
    verifyDoc(doc)
      .then((v) => { if (alive) setVerify(v); })
      .catch((e) => { if (alive) setVerify({ signatures: [], error: String(e) }); })
      .finally(() => { if (alive) setVerifying(false); });
    return () => { alive = false; };
  }, [doc, trustVer]);
  // Chi tiết đang mở → cập nhật theo kết quả kiểm mới (sau khi Trust).
  useEffect(() => {
    setDetails((d) => (d && verify ? verify.signatures.find((s) => s.field === d.field) ?? null : d));
  }, [verify]);

  /* ── Link ngoài trong trang: chặn mở thẳng, hỏi trước ── */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href)) { e.preventDefault(); e.stopPropagation(); void openExternal(href); }
      else if (!href.startsWith("#")) { e.preventDefault(); e.stopPropagation(); }
    };
    // Ctrl + lăn chuột = zoom.
    const onWheel = (e: WheelEvent) => {
      const c = ctx.current;
      if (!e.ctrlKey || !c) return;
      e.preventDefault();
      const steps = e.deltaY < 0 ? 1 : -1;
      // Chờ ngắn rồi mới vẽ lại (gộp các lần lăn liên tiếp) — 300ms trước đây làm trang mờ lâu sau khi zoom.
      c.viewer.updateScale({ steps, origin: [e.clientX, e.clientY], drawingDelay: 60 });
    };
    el.addEventListener("click", onClick, true);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { el.removeEventListener("click", onClick, true); el.removeEventListener("wheel", onWheel); };
  }, []);

  /* ── Tìm chữ ── */
  const dispatchFind = (type: "" | "again", findPrevious = false, query = find) => {
    ctx.current?.bus.dispatch("find", { source: null, type, query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious, matchDiacritics: false });
  };
  const openFind = () => { setFindOpen(true); requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select(); }); };
  const closeFind = () => {
    setFindOpen(false);
    setFind("");
    setMatches({ current: 0, total: 0, notFound: false });
    ctx.current?.bus.dispatch("findbarclose", { source: null });
  };

  const goPageRef = useRef<(n: number) => void>(() => {});
  /** Hàm chọn trang ỔN ĐỊNH (không đổi giữa các lần render) — truyền xuống danh sách thumbnail memo. */
  const pickPage = useCallback((n: number) => goPageRef.current(n), []);
  const goPage = (n: number) => {
    const c = ctx.current;
    if (!c || !Number.isFinite(n)) return;
    c.viewer.currentPageNumber = Math.min(Math.max(1, Math.round(n)), c.pdf.numPages);
  };
  goPageRef.current = goPage;
  const setZoomValue = (v: string) => { if (ctx.current) ctx.current.viewer.currentScaleValue = v; };
  const zoomStep = (steps: number) => ctx.current?.viewer.updateScale({ steps });
  const rotate = () => { const c = ctx.current; if (c) c.viewer.pagesRotation = (c.viewer.pagesRotation + 90) % 360; };

  const print = async () => {
    const c = ctx.current;
    if (!c || printing) return;
    printSignal.current = { cancelled: false };
    setPrinting({ i: 0, n: c.pdf.numPages });
    try { await printPdf(c.pdf, (i, n) => setPrinting({ i, n }), printSignal.current); }
    catch (e) { useWorkbench.getState().log(`✗ ${t("pdf.printFailed")}: ${String(e)}`); }
    finally { setPrinting(null); }
  };

  const jumpToSig = (s: SigOut) => {
    const f = fields.current.get(s.field) ?? [...fields.current.entries()].find(([k]) => k.endsWith(s.field) || s.field.endsWith(k))?.[1];
    const c = ctx.current;
    if (!f || !c) return;
    c.viewer.scrollPageIntoView({ pageNumber: f.page + 1, destArray: [null, { name: "XYZ" }, f.rect[0] - 20, f.rect[3] + 40, null] });
  };
  const showSigned = (s: SigOut) => {
    if (!doc || !s.revEnd) return;
    setDetails(null);
    void docBytes(doc).then((b) => openPdfBytes(b.slice(0, s.revEnd), t("pdf.signedVersionTitle", { name: doc.name, signer: s.signer ?? s.field })));
  };

  const setDefault = () => setDefaultPdfApp(doc?.path || undefined);

  /* ── Phím tắt (chỉ khi tab này đang hiện) ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || root.closest(".tab-host")?.hasAttribute("hidden") || useWorkbench.getState().activeApp !== "pdf") return;
      if (document.querySelector(".modal-backdrop, .modal")) return;
      const mod = e.ctrlKey || e.metaKey;
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable=true]");
      if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); openFind(); }
      else if (mod && e.key.toLowerCase() === "p") { e.preventDefault(); void print(); }
      else if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomStep(1); }
      else if (mod && e.key === "-") { e.preventDefault(); zoomStep(-1); }
      else if (mod && e.key === "0") { e.preventDefault(); setZoomValue("1"); }
      else if (!typing && !mod && (e.key === "PageDown" || e.key === "PageUp") && root.contains(document.activeElement) === false) {
        e.preventDefault();
        goPage((ctx.current?.viewer.currentPageNumber ?? 1) + (e.key === "PageDown" ? 1 : -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const summary = verify ? docSummary(verify) : null;
  const sigCount = verify?.signatures.length ?? 0;

  const menuItems = (): CtxItem[] => [
    { id: "open", icon: <FolderOpen />, label: tr("pdf.openFile"), hint: "Ctrl+O", action: () => void openPdfDialog() },
    { id: "reveal", icon: <FolderOpen />, label: tr("pdf.reveal"), disabled: !doc?.path, action: () => doc?.path && void pdfApi.reveal(doc.path) },
    { id: "copy", icon: <Copy />, label: tr("pdf.copyPath"), disabled: !doc?.path, action: () => doc?.path && void copyText(doc.path) },
    { id: "reload", icon: <RefreshCw />, label: tr("pdf.reverify"), action: () => { if (doc) { setVerifying(true); void verifyDoc(doc).then(setVerify).finally(() => setVerifying(false)); } } },
    { id: "s1", sep: true },
    { id: "default", icon: <Star />, label: tr("pdf.setDefault"), action: () => void setDefault() },
    { id: "trust", icon: <BadgeCheck />, label: tr("pdf.trustManager"), action: () => setTrustOpen(true) },
  ];

  if (!doc) return <div className="empty">{tr("pdf.docGone")}</div>;

  const sideTabs: { id: Side; icon: ReactNode; label: TKey }[] = [
    { id: "thumbs", icon: <LayoutGrid />, label: "pdf.thumbnails" },
    { id: "outline", icon: <ListTree />, label: "pdf.outline" },
    { id: "sigs", icon: <FileSignature />, label: "pdf.signatures" },
  ];

  return (
    <div className="pdf-tab" ref={rootRef}>
      <div className="pdf-toolbar toolbar">
        <button className={`icon-btn ${side ? "on" : ""}`} title={tr("pdf.sidePanel")} aria-label={tr("pdf.sidePanel")} onClick={() => setSide(side ? null : "thumbs")}><PanelLeft /></button>
        <span className="pdf-sep" />
        <button className="icon-btn" title={tr("pdf.prevPage")} aria-label={tr("pdf.prevPage")} disabled={page <= 1} onClick={() => goPage(page - 1)}><ChevronLeft /></button>
        <input className="pdf-page-input" value={pageInput} aria-label={tr("pdf.page")}
          onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => { if (e.key === "Enter") goPage(Number(pageInput)); }}
          onBlur={() => setPageInput(String(page))} />
        <span className="muted pdf-page-total">/ {pages || "—"}</span>
        <button className="icon-btn" title={tr("pdf.nextPage")} aria-label={tr("pdf.nextPage")} disabled={page >= pages} onClick={() => goPage(page + 1)}><ChevronRight /></button>
        <span className="pdf-sep" />
        <button className="icon-btn" title={`${tr("pdf.zoomOut")} (Ctrl+-)`} aria-label={tr("pdf.zoomOut")} onClick={() => zoomStep(-1)}><ZoomOut /></button>
        <Picker
          label={zoom.preset ? zoomLabel(zoom.preset) : `${Math.round(zoom.scale * 100)}%`}
          title={tr("pdf.zoom")}
          items={ZOOMS.map((z) => ({ id: z, label: zoomLabel(z), selected: z === zoom.preset || (!zoom.preset && Math.abs(Number(z) - zoom.scale) < 0.001) }))}
          onPick={setZoomValue}
        />
        <button className="icon-btn" title={`${tr("pdf.zoomIn")} (Ctrl++)`} aria-label={tr("pdf.zoomIn")} onClick={() => zoomStep(1)}><ZoomIn /></button>
        <button className="icon-btn" title={tr("pdf.rotate")} aria-label={tr("pdf.rotate")} onClick={rotate}><RotateCw /></button>
        <span className="grow" />
        {findOpen ? (
          <div className={`pdf-find ${matches.notFound ? "nf" : ""}`}>
            <Search />
            <input ref={findRef} value={find} placeholder={tr("pdf.findPlaceholder")}
              onChange={(e) => { setFind(e.target.value); dispatchFind("", false, e.target.value); }}
              onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Enter") { e.preventDefault(); dispatchFind("again", e.shiftKey); }
                else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
              }} />
            <span className="muted small pdf-find-count">{find ? (matches.total ? `${matches.current}/${matches.total}` : matches.notFound ? tr("pdf.noMatch") : "") : ""}</span>
            <button className="icon-btn" title={`${tr("pdf.findPrev")} (Shift+Enter)`} aria-label={tr("pdf.findPrev")} onClick={() => dispatchFind("again", true)}><ChevronUp /></button>
            <button className="icon-btn" title={`${tr("pdf.findNext")} (Enter)`} aria-label={tr("pdf.findNext")} onClick={() => dispatchFind("again", false)}><ChevronDown /></button>
            <button className="icon-btn" title={tr("shell.close")} aria-label={tr("shell.close")} onClick={closeFind}><X /></button>
          </div>
        ) : (
          <button className="icon-btn" title={`${tr("pdf.find")} (Ctrl+F)`} aria-label={tr("pdf.find")} onClick={openFind}><Search /></button>
        )}
        <button className={`icon-btn pdf-sig-btn ${summary ? `lv-${summary.level}` : ""}`} title={tr("pdf.signatures")} aria-label={tr("pdf.signatures")} onClick={() => setSide(side === "sigs" ? null : "sigs")}>
          {verifying ? <Spinner /> : <FileSignature />}
          {sigCount > 0 && <span className="pdf-badge">{sigCount}</span>}
        </button>
        <button className="icon-btn" title={`${tr("pdf.print")} (Ctrl+P)`} aria-label={tr("pdf.print")} disabled={state !== "ready" || !!printing} onClick={() => void print()}><Printer /></button>
        <button className="icon-btn" title={tr("pdf.more")} aria-label={tr("pdf.more")} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 220, y: r.bottom + 2 }); }}><MoreHorizontal /></button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}

      {summary && (
        <div className={`pdf-banner lv-${summary.level}`}>
          <SigIcon status={summary.level} />
          <span className="grow">{summary.text}</span>
          <button onClick={() => setSide("sigs")}><FileSignature />{tr("pdf.signaturePanel")}</button>
        </div>
      )}
      {verify?.error && <div className="pdf-banner lv-unknown"><SigIcon status="unknown" /><span className="grow">{tr("pdf.verifyError", { err: verify.error })}</span></div>}

      <div className="pdf-body">
        {side && (
          <>
            <aside className="pdf-side" style={{ width: sideW }}>
              <div className="subtabs" role="tablist">
                {sideTabs.map((s) => (
                  <button key={s.id} role="tab" aria-selected={side === s.id} className={side === s.id ? "on" : ""} title={tr(s.label)} onClick={() => setSide(s.id)}>
                    {s.icon}{s.id === "sigs" && sigCount > 0 ? <span className="pdf-badge inline">{sigCount}</span> : null}
                  </button>
                ))}
                <span className="grow" />
                <button className="icon-btn" title={tr("shell.close")} aria-label={tr("shell.close")} onClick={() => setSide(null)}><X /></button>
              </div>
              <div className="pdf-side-body">
                {side === "thumbs" && pdf && <Thumbs pdf={pdf} pages={pageSt} onPick={pickPage} />}
                {side === "outline" && pdf && ctx.current && <Outline pdf={pdf} link={ctx.current.link} />}
                {side === "sigs" && <SigList verify={verify} verifying={verifying} onPick={jumpToSig} onOpen={setDetails} />}
                {!pdf && side !== "sigs" && <Loading variant="row" />}
              </div>
            </aside>
            <Splitter axis="x" live="prev" min={150} max={480} onResize={(d) => setSideW((w) => w + d)} onReset={() => setSideW(220)} />
          </>
        )}
        <div className="pdf-stage">
          <div className="pdf-scroll" ref={scrollRef} tabIndex={-1}>
            <div className="pdfViewer" ref={viewerRef} />
          </div>
          {state === "loading" && <div className="pdf-overlay"><Loading /></div>}
          {state === "error" && <div className="pdf-overlay"><div className="error-box">{tr("pdf.loadFailed", { err: error })}</div></div>}
          {state === "password" && (
            <div className="pdf-overlay">
              <form className="pdf-password inline-panel" onSubmit={(e) => { e.preventDefault(); void open(pw); }}>
                <div className="pdf-password-title"><Lock />{tr("pdf.passwordTitle")}</div>
                <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder={tr("pdf.password")} />
                {pwWrong && <div className="error-text small">{tr("pdf.passwordWrong")}</div>}
                <div className="toolbar"><span className="grow" /><button className="primary" type="submit"><LockOpen />{tr("pdf.unlock")}</button></div>
              </form>
            </div>
          )}
          {printing && (
            <div className="pdf-overlay">
              <div className="inline-panel pdf-printing-box">
                <Loading variant="inline" label={tr("pdf.preparingPrint", { i: printing.i, n: printing.n })} />
                <button onClick={() => { printSignal.current.cancelled = true; }}><X />{tr("shell.cancel")}</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {details && <SigDetailsModal sig={details} busy={verifying} onClose={() => setDetails(null)} onShowSigned={showSigned} />}
      {trustOpen && <TrustManagerModal onClose={() => setTrustOpen(false)} />}
    </div>
  );
}

/* ───────────────── Thumbnail ───────────────── */

/**
 * Hàng đợi vẽ thumbnail: vẽ LẦN LƯỢT từng cái lúc trình duyệt rảnh (requestIdleCallback). pdf.js vẽ canvas trên luồng
 * giao diện — để IntersectionObserver vẽ đồng loạt (file 1000 trang, panel thumbnail đang mở) thì cuộn trang chính
 * bị giật (long task ~190ms). Thumbnail ra khỏi tầm nhìn trước khi tới lượt thì bỏ khỏi hàng.
 */
class ThumbQueue {
  private jobs = new Map<number, () => Promise<void>>();
  private running = false;
  private alive = true;
  add(n: number, job: () => Promise<void>) {
    this.jobs.set(n, job);
    this.pump();
  }
  remove(n: number) {
    this.jobs.delete(n);
  }
  dispose() {
    this.alive = false;
    this.jobs.clear();
  }
  private pump() {
    if (this.running || !this.jobs.size || !this.alive) return;
    this.running = true;
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const next = () => {
      // Trang nhỏ nhất trước (thứ tự đọc); mỗi lần chỉ một job.
      const n = Math.min(...this.jobs.keys());
      const job = this.jobs.get(n)!;
      this.jobs.delete(n);
      job().catch(() => {}).finally(() => {
        this.running = false;
        this.pump();
      });
    };
    if (idle) idle(next, { timeout: 300 }); else setTimeout(next, 16);
  }
}

const Thumb = memo(function Thumb({ pdf, n, pages, onPick, queue }: { pdf: PDFDocumentProxy; n: number; pages: PageStore; onPick: (n: number) => void; queue: ThumbQueue }) {
  const active = useSyncExternalStore(pages.sub, () => pages.get() === n);
  const box = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    let done = false;
    const io = new IntersectionObserver((es) => {
      if (done) return;
      if (!es.some((e) => e.isIntersecting)) {
        queue.remove(n);
        return;
      }
      queue.add(n, async () => {
        if (done) return;
        const p = await pdf.getPage(n);
        const c = canvas.current;
        if (!c || done) return;
        const w = 140 * (window.devicePixelRatio || 1);
        const vp = p.getViewport({ scale: w / p.getViewport({ scale: 1 }).width });
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        task = p.render({ canvas: c, viewport: vp });
        await task.promise;
        // Giữ đúng tỉ lệ của chính trang này (trang ngang/khổ khác trong cùng file).
        c.style.aspectRatio = `${c.width} / ${c.height}`;
        done = true;
        io.disconnect();
      });
    }, { root: el.closest(".pdf-side-body"), rootMargin: "300px 0px" });
    io.observe(el);
    return () => { done = true; io.disconnect(); queue.remove(n); task?.cancel(); };
  }, [pdf, n, queue]);
  return (
    <button ref={box} className={`pdf-thumb ${active ? "on" : ""}`} data-n={n} tabIndex={active ? 0 : -1} onClick={() => onPick(n)}>
      <canvas ref={canvas} />
      <span className="small">{n}</span>
    </button>
  );
});

/** Danh sách thumbnail: memo + props ổn định → KHÔNG render lại khi đổi trang (1000 trang × mỗi lần đổi trang = giật). */
const Thumbs = memo(function Thumbs({ pdf, pages, onPick }: { pdf: PDFDocumentProxy; pages: PageStore; onPick: (n: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Đưa thumbnail trang hiện tại vào tầm nhìn — nghe store, không qua render.
  useEffect(() => pages.sub(() => { ref.current?.querySelector(`[data-n="${pages.get()}"]`)?.scrollIntoView({ block: "nearest" }); }), [pages]);
  const list = useMemo(() => Array.from({ length: pdf.numPages }, (_, i) => i + 1), [pdf]);
  const queue = useMemo(() => new ThumbQueue(), [pdf]);
  useEffect(() => () => queue.dispose(), [queue]);
  // Khung giữ chỗ theo tỉ lệ trang 1 → thumbnail chưa vẽ cao bằng thumbnail đã vẽ, vẽ xong không làm danh sách xê dịch
  // (trước đây cuộn tới trang 301 thì các thumbnail phía trên vẽ xong cao lên, đẩy thumbnail 301 khỏi tầm nhìn).
  const [ar, setAr] = useState("1 / 1.4142");
  useEffect(() => {
    let alive = true;
    void pdf.getPage(1).then((p) => { const v = p.getViewport({ scale: 1 }); if (alive) setAr(`${v.width} / ${v.height}`); }).catch(() => {});
    return () => { alive = false; };
  }, [pdf]);
  return (
    <div className="pdf-thumbs" ref={ref} style={{ "--thumb-ar": ar } as React.CSSProperties}
      onKeyDown={(e) => {
        const page = pages.get();
        if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); onPick(Math.min(page + 1, pdf.numPages)); }
        else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); onPick(Math.max(page - 1, 1)); }
      }}>
      {list.map((n) => <Thumb key={n} pdf={pdf} n={n} pages={pages} onPick={onPick} queue={queue} />)}
    </div>
  );
});

/* ───────────────── Mục lục (bookmarks) ───────────────── */

interface OutlineNode { title: string; dest: string | unknown[] | null; url: string | null; items: OutlineNode[] }

function OutlineItem({ node, depth, link }: { node: OutlineNode; depth: number; link: Ctx["link"] }) {
  const [open, setOpen] = useState(false);
  const has = node.items?.length > 0;
  const go = () => {
    if (node.dest) void link.goToDestination(node.dest as string);
    else if (node.url) void openExternal(node.url);
  };
  return (
    <>
      <div className="side-item tree-row pdf-outline-row" style={{ paddingLeft: 6 + depth * 14 }} tabIndex={0} title={node.title}
        onClick={go}
        onKeyDown={(e) => rowKey(e, { Enter: go, ArrowRight: () => setOpen(true), ArrowLeft: () => setOpen(false) })}>
        {has
          ? <span className="tree-caret" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{open ? <ChevronDown /> : <ChevronRight />}</span>
          : <span className="tree-caret" />}
        <span className="ellipsis">{node.title}</span>
      </div>
      {open && node.items.map((c, i) => <OutlineItem key={i} node={c} depth={depth + 1} link={link} />)}
    </>
  );
}

function Outline({ pdf, link }: { pdf: PDFDocumentProxy; link: Ctx["link"] }) {
  const tr = useT();
  const [items, setItems] = useState<OutlineNode[] | null | undefined>(undefined);
  useEffect(() => { let a = true; void pdf.getOutline().then((o) => { if (a) setItems(o as OutlineNode[] | null); }).catch(() => a && setItems(null)); return () => { a = false; }; }, [pdf]);
  if (items === undefined) return <Loading variant="row" />;
  if (!items?.length) return <div className="muted pdf-side-empty">{tr("pdf.noOutline")}</div>;
  return (
    <div className="side-list" onKeyDown={(e) => listNav(e, { row: ".pdf-outline-row" })}>
      {items.map((n, i) => <OutlineItem key={i} node={n} depth={0} link={link} />)}
    </div>
  );
}

/* ───────────────── Danh sách chữ ký ───────────────── */

function SigList({ verify, verifying, onPick, onOpen }: { verify: VerifyOut | null; verifying: boolean; onPick: (s: SigOut) => void; onOpen: (s: SigOut) => void }) {
  const tr = useT();
  if (!verify) return verifying ? <Loading variant="row" label={tr("pdf.verifying")} /> : null;
  if (!verify.signatures.length) return <div className="muted pdf-side-empty">{verify.error ? tr("pdf.verifyError", { err: verify.error }) : tr("pdf.noSignatures")}</div>;
  return (
    <div className="side-list pdf-sig-list" onKeyDown={(e) => listNav(e, { row: ".pdf-sig-row", select: true })}>
      {verify.signatures.map((s, i) => (
        <div key={s.field + i} className={`pdf-sig-row ${sigWarn(s) ? "warn" : ""}`} tabIndex={0}
          onClick={() => onPick(s)} onDoubleClick={() => onOpen(s)}
          onKeyDown={(e) => rowKey(e, { Enter: () => onOpen(s) })}>
          <div className="pdf-sig-line">
            <SigIcon status={s.status} warn={!!s.unsafeChanges} />
            <span className="ellipsis grow"><b>{s.kind === "timestamp" ? tr("pdf.docTimestamp") : s.signer ?? s.field}</b></span>
          </div>
          <div className="muted small pdf-sig-sub">
            {fmtTime(s.timeUsed)}
            {s.reason ? ` · ${s.reason}` : ""}
          </div>
          <div className="small pdf-sig-state">
            {s.revoked ? tr("pdf.stRevoked") : s.docmdpViolation ? tr("pdf.stDocmdp") : s.status === "invalid" ? tr("pdf.stInvalid") : s.weakHash && s.trusted ? tr("pdf.stWeak", { alg: s.weakHash }) : s.status === "unknown" ? tr("pdf.stUnknown") : s.unsafeChanges ? tr("pdf.stValidModified") : tr("pdf.stValid")}
            {s.modifiedAfter && !s.unsafeChanges && <span className="muted"> · <FileClock className="inline-ic" />{tr("pdf.stUpdatedAfter")}</span>}
          </div>
          <button className="link-btn small" onClick={(e) => { e.stopPropagation(); onOpen(s); }}>{tr("pdf.details")}</button>
        </div>
      ))}
    </div>
  );
}
