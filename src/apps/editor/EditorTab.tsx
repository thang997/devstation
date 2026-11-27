import { memo, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  AlignLeft, Binary, CaseLower, CaseUpper, CheckCheck, Eraser, FilePlus, FileText, FolderOpen, Keyboard, Link2, ListOrdered,
  Minimize2, Replace, RotateCcw, Save, Search, SortAsc, SortDesc, Unlink2, WrapText, Rows3, KeyRound, CopyMinus, Merge,
} from "lucide-react";
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, copyLineDown } from "@codemirror/commands";
import { foldGutter, indentOnInput, bracketMatching, foldKeymap, indentUnit } from "@codemirror/language";
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel, gotoLine } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import type { Tab } from "../types";
import { useT, t, type TKey } from "../../store/lang";
import { ContextMenu, type CtxItem } from "../../shell/ContextMenu";
import { Picker } from "../../shell/Picker";
import { confirmDialog } from "../../shell/confirm";
import { edHighlight, edTheme } from "./theme";
import { LANGS, langLabel, loadLang, sniffLang, type LangId } from "./langs";
import { EXTRA_KEYS, SHORTCUTS, keysOf, type ActionId } from "./keys";
import {
  TransformError, b64decode, b64encode, canFormat, canMinify, checkSyntax, formatText, joinLines, jwtDecode, minifyText,
  prettyIfJson, removeEmptyLines, sortLines, toLower, toUpper, trimTrailing, uniqueLines, urlDecode, urlEncode,
} from "./transforms";
import {
  getDoc, keepText, newDoc, openDialog, patchDoc, registerGetter, reload, save, scheduleDraft, takeInitial, useDocsVersion,
} from "./store";
import { openShortcuts } from "./ShortcutsModal";

const ENCODINGS: { id: string; enc: string; bom: boolean; label: string }[] = [
  { id: "utf-8", enc: "utf-8", bom: false, label: "UTF-8" },
  { id: "utf-8-bom", enc: "utf-8", bom: true, label: "UTF-8 BOM" },
  { id: "utf-16le", enc: "utf-16le", bom: true, label: "UTF-16 LE" },
  { id: "utf-16be", enc: "utf-16be", bom: true, label: "UTF-16 BE" },
  { id: "windows-1252", enc: "windows-1252", bom: false, label: "Windows-1252" },
];
const encLabel = (enc: string, bom: boolean) => ENCODINGS.find((e) => e.enc === enc && (e.enc !== "utf-8" || e.bom === bom))?.label ?? enc;

const LS_WRAP = "devstation.editor.wrap";
const LS_FONT = "devstation.editor.fontSize";
const CHECKABLE: LangId[] = ["json", "xml", "javascript"];

/** Thông báo ở status bar: kết quả kiểm cú pháp / lỗi chuyển đổi. */
interface Msg { kind: "good" | "bad" | "info"; text: string; pos?: number }

/** Lỗi chuyển đổi → câu dịch (mã đã biết) hoặc thông báo gốc của parser. */
function transformErr(e: unknown): string {
  if (e instanceof TransformError) {
    const known: Record<string, TKey> = {
      notBase64: "editor.errNotBase64", notText: "editor.errNotText", badUrl: "editor.errBadUrl", notJwt: "editor.errNotJwt",
      cannotFormat: "editor.errCannotFormat", cannotMinify: "editor.errCannotMinify",
    };
    return known[e.message] ? t(known[e.message]) : e.message;
  }
  return String(e);
}

export const EditorTab = memo(function EditorTab({ tab }: { tab: Tab }) {
  const tr = useT();
  useDocsVersion();
  const id = tab.id;
  const doc = getDoc(id);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langC = useRef(new Compartment());
  const wrapC = useRef(new Compartment());
  /** Đang nạp nội dung bằng code (đọc lại file) → không đánh dấu "chưa lưu". */
  const silent = useRef(false);
  const [pos, setPos] = useState({ line: 1, col: 1, sel: 0, lines: 1 });
  const [msg, setMsg] = useState<Msg | null>(null);
  const [wrap, setWrap] = useState(() => localStorage.getItem(LS_WRAP) === "1");
  const [font, setFont] = useState(() => Number(localStorage.getItem(LS_FONT)) || 13);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sniffTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const api = useRef<{ run: (a: ActionId) => void }>({ run: () => {} });

  /* ── Kiểm cú pháp (JSON / XML / JS): gạch chân chỗ lỗi + status bar ── */
  const runCheck = useCallback(async (show: boolean) => {
    const v = viewRef.current;
    const d = getDoc(id);
    if (!v || !d) return;
    if (!CHECKABLE.includes(d.lang)) {
      v.dispatch(setDiagnostics(v.state, []));
      if (show) setMsg({ kind: "info", text: t("editor.cannotValidate", { lang: langLabel(d.lang) }) });
      else setMsg((m) => (m?.kind === "info" ? m : null));
      return;
    }
    const text = v.state.doc.toString();
    const issue = await checkSyntax(text, d.lang);
    if (viewRef.current !== v) return;
    if (!issue) {
      v.dispatch(setDiagnostics(v.state, []));
      setMsg(text.trim() ? { kind: "good", text: t("editor.valid", { lang: langLabel(d.lang) }) } : null);
      return;
    }
    const from = Math.min(issue.from, v.state.doc.length);
    const to = Math.min(v.state.doc.length, from + 1);
    v.dispatch(setDiagnostics(v.state, [{ from, to, severity: "error", message: issue.message }]));
    setMsg({ kind: "bad", text: issue.message, pos: from });
    if (show) {
      v.dispatch({ selection: { anchor: from }, scrollIntoView: true });
      v.focus();
    }
  }, [id]);
  const scheduleCheck = useCallback(() => {
    clearTimeout(checkTimer.current);
    checkTimer.current = setTimeout(() => void runCheck(false), 700);
  }, [runCheck]);

  /* ── Tạo CodeMirror một lần cho tab ── */
  useEffect(() => {
    if (!host.current || !getDoc(id)) return;
    const runKey = (a: ActionId) => () => { api.current.run(a); return true; };
    const all = [
      ...SHORTCUTS.flatMap((g) => g.items).filter((s) => s.cm && s.action).map((s) => ({ cm: s.cm!, action: s.action! })),
      ...EXTRA_KEYS,
    ];
    // Ctrl+Alt+<chữ>: trên Windows CodeMirror coi Ctrl+Alt là AltGr và BỎ QUA các binding này → tự bắt theo mã phím
    // vật lý (e.code, không phụ thuộc bố cục bàn phím).
    const isCtrlAlt = (cm: string) => /^Mod-Alt-/.test(cm);
    const appKeys = all.filter((k) => !isCtrlAlt(k.cm)).map((k) => ({ key: k.cm, run: runKey(k.action), preventDefault: true }));
    const ctrlAlt = all.filter((k) => isCtrlAlt(k.cm)).map((k) => ({
      shift: k.cm.includes("-Shift-"),
      code: `Key${k.cm.slice(k.cm.lastIndexOf("-") + 1).toUpperCase()}`,
      action: k.action,
    }));
    const ctrlAltHandler = EditorView.domEventHandlers({
      keydown: (e) => {
        if (!(e.ctrlKey && e.altKey) || e.metaKey) return false;
        const hit = ctrlAlt.find((k) => k.code === e.code && k.shift === e.shiftKey);
        if (!hit) return false;
        e.preventDefault();
        api.current.run(hit.action);
        return true;
      },
    });
    const exts: Extension[] = [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
      EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(), autocompletion(),
      rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(), search({ top: true }),
      lintGutter(), indentUnit.of("    "), EditorState.tabSize.of(4),
      edTheme, edHighlight,
      langC.current.of([]),
      wrapC.current.of(wrap ? EditorView.lineWrapping : []),
      // Phím của Editor ưu tiên cao nhất (Ctrl+D = nhân đôi dòng như Notepad++, thay "chọn từ kế tiếp" của CodeMirror).
      Prec.highest(keymap.of(appKeys)),
      Prec.highest(ctrlAltHandler),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          if (!silent.current) scheduleDraft(id);
          scheduleCheck();
          const d = getDoc(id);
          // Tab mới chưa chọn ngôn ngữ: dán JSON/XML… vào thì tự đoán.
          if (d && !d.path && !d.langManual && d.lang === "text") {
            clearTimeout(sniffTimer.current);
            sniffTimer.current = setTimeout(() => {
              const v = viewRef.current;
              const cur = getDoc(id);
              if (!v || !cur || cur.langManual || cur.lang !== "text") return;
              const g = sniffLang(v.state.doc.toString());
              if (g !== "text") patchDoc(id, { lang: g });
            }, 400);
          }
        }
        if (u.docChanged || u.selectionSet) {
          const s = u.state;
          const r = s.selection.main;
          const line = s.doc.lineAt(r.head);
          setPos({ line: line.number, col: r.head - line.from + 1, sel: s.selection.ranges.reduce((n, x) => n + (x.to - x.from), 0), lines: s.doc.lines });
        }
      }),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: takeInitial(id), extensions: exts }), parent: host.current });
    viewRef.current = v;
    registerGetter(id, () => v.state.doc.toString());
    setPos({ line: 1, col: 1, sel: 0, lines: v.state.doc.lines });
    requestAnimationFrame(() => v.focus());
    return () => {
      keepText(id, v.state.doc.toString());
      registerGetter(id, null);
      clearTimeout(checkTimer.current);
      clearTimeout(sniffTimer.current);
      v.destroy();
      viewRef.current = null;
    };
    // Chỉ tạo một lần cho mỗi tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /* ── Ngôn ngữ đổi → nạp gói tô màu + kiểm lại ── */
  const lang = doc?.lang ?? "text";
  useEffect(() => {
    let alive = true;
    void loadLang(lang).then((ext) => {
      const v = viewRef.current;
      if (!alive || !v) return;
      v.dispatch({ effects: langC.current.reconfigure(ext) });
      void runCheck(false);
    });
    return () => { alive = false; };
  }, [lang, runCheck]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapC.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
    localStorage.setItem(LS_WRAP, wrap ? "1" : "0");
  }, [wrap]);
  useEffect(() => { localStorage.setItem(LS_FONT, String(font)); }, [font]);

  /* ── Áp chuyển đổi cho đoạn chọn (nhiều vùng chọn → từng vùng), không chọn gì → cả file ── */
  const transform = useCallback(async (fn: (s: string) => string | Promise<string>, okText?: string) => {
    const v = viewRef.current;
    if (!v) return;
    const st = v.state;
    const ranges = st.selection.ranges.filter((r) => !r.empty);
    const targets = ranges.length ? ranges.map((r) => ({ from: r.from, to: r.to })) : [{ from: 0, to: st.doc.length }];
    try {
      const outs = await Promise.all(targets.map((r) => fn(st.sliceDoc(r.from, r.to))));
      if (viewRef.current !== v || v.state.doc !== st.doc) return; // đã gõ thêm trong lúc chờ Prettier → bỏ
      const changes = targets.map((r, i) => ({ from: r.from, to: r.to, insert: outs[i] }));
      let off = 0;
      const sel = targets.map((r, i) => {
        const from = r.from + off;
        off += outs[i].length - (r.to - r.from);
        return EditorSelection.range(from, from + outs[i].length);
      });
      v.dispatch({ changes, selection: ranges.length ? EditorSelection.create(sel) : undefined, userEvent: "input.transform", scrollIntoView: true });
      setMsg(okText ? { kind: "good", text: okText } : null);
      v.focus();
    } catch (e) {
      setMsg({ kind: "bad", text: transformErr(e) });
    }
  }, []);

  const doSave = useCallback(async (as: boolean) => {
    const d = getDoc(id);
    if (!d) return;
    if (d.lossy && !as && !(await confirmDialog({ title: tr("editor.lossyTitle"), message: tr("editor.lossyConfirm", { name: d.name }), confirmLabel: tr("editor.aSave"), danger: true }))) return;
    if (await save(id, as)) setMsg({ kind: "good", text: tr("editor.saved") });
  }, [id, tr]);

  const doReload = useCallback(async () => {
    const d = getDoc(id);
    const v = viewRef.current;
    if (!d?.path || !v) return;
    if (d.dirty && !(await confirmDialog({ message: tr("editor.reloadConfirm", { name: d.name }), confirmLabel: tr("editor.aReload") }))) return;
    const text = await reload(id);
    if (text == null) return;
    silent.current = true;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    silent.current = false;
  }, [id, tr]);

  /* ── Mọi hành động (phím tắt, nút, menu, Ctrl+G) ── */
  api.current.run = (a: ActionId) => {
    const v = viewRef.current;
    const d = getDoc(id);
    if (!v || !d) return;
    const tw = 2;
    switch (a) {
      case "new": newDoc(); break;
      case "open": void openDialog(); break;
      case "save": void doSave(false); break;
      case "saveAs": void doSave(true); break;
      case "reload": void doReload(); break;
      case "format":
        if (!canFormat(d.lang)) { setMsg({ kind: "info", text: tr("editor.cannotFormat", { lang: langLabel(d.lang) }) }); break; }
        void transform((s) => formatText(s, d.lang, tw), tr("editor.formatted"));
        break;
      case "minify":
        if (!canMinify(d.lang)) { setMsg({ kind: "info", text: tr("editor.cannotMinify", { lang: langLabel(d.lang) }) }); break; }
        void transform((s) => minifyText(s, d.lang));
        break;
      case "validate": void runCheck(true); break;
      case "b64decode": void transform((s) => prettyIfJson(b64decode(s))); break;
      case "b64encode": void transform(b64encode); break;
      case "urlDecode": void transform(urlDecode); break;
      case "urlEncode": void transform(urlEncode); break;
      case "jwtDecode": void transform(jwtDecode); break;
      case "upper": void transform(toUpper); break;
      case "lower": void transform(toLower); break;
      case "sortAsc": void transform((s) => sortLines(s)); break;
      case "sortDesc": void transform((s) => sortLines(s, true)); break;
      case "unique": void transform(uniqueLines); break;
      case "trimTrailing": void transform(trimTrailing); break;
      case "removeEmpty": void transform(removeEmptyLines); break;
      case "joinLines": void transform(joinLines); break;
      case "gotoLine": gotoLine(v); break;
      case "replace":
        openSearchPanel(v);
        requestAnimationFrame(() => host.current?.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus());
        break;
      case "duplicateLine": copyLineDown(v); break;
      case "wrap": setWrap((w) => !w); break;
      case "zoomIn": setFont((f) => Math.min(32, f + 1)); break;
      case "zoomOut": setFont((f) => Math.max(8, f - 1)); break;
      case "zoomReset": setFont(13); break;
      case "shortcuts": openShortcuts(); break;
    }
  };

  // Lệnh từ Ctrl+G / menu toàn cục (index.tsx) gửi tới tab đang mở.
  useEffect(() => {
    const on = (e: Event) => {
      const { tabId, action } = (e as CustomEvent<{ tabId: string; action: ActionId }>).detail;
      if (tabId === id) api.current.run(action);
    };
    window.addEventListener("ds-editor-action", on);
    return () => window.removeEventListener("ds-editor-action", on);
  }, [id]);

  if (!doc) return <div className="empty">{tr("editor.docMissing")}</div>;

  const item = (a: ActionId, label: TKey, icon: React.ReactNode, disabled = false): CtxItem =>
    ({ id: a, icon, label: tr(label), hint: keysOf(a), disabled, action: () => api.current.run(a) });
  const menuItems = (): CtxItem[] => [
    item("format", "editor.aFormat", <AlignLeft />, !canFormat(doc.lang)),
    item("minify", "editor.aMinify", <Minimize2 />, !canMinify(doc.lang)),
    item("validate", "editor.aValidate", <CheckCheck />, !CHECKABLE.includes(doc.lang)),
    { id: "s1", sep: true },
    item("b64decode", "editor.aB64Decode", <Binary />),
    item("b64encode", "editor.aB64Encode", <Binary />),
    item("urlDecode", "editor.aUrlDecode", <Unlink2 />),
    item("urlEncode", "editor.aUrlEncode", <Link2 />),
    item("jwtDecode", "editor.aJwtDecode", <KeyRound />),
    { id: "s2", sep: true },
    item("upper", "editor.aUpper", <CaseUpper />),
    item("lower", "editor.aLower", <CaseLower />),
    item("sortAsc", "editor.aSortAsc", <SortAsc />),
    item("sortDesc", "editor.aSortDesc", <SortDesc />),
    item("unique", "editor.aUnique", <CopyMinus />),
    item("trimTrailing", "editor.aTrimTrailing", <Eraser />),
    item("removeEmpty", "editor.aRemoveEmpty", <Rows3 />),
    item("joinLines", "editor.aJoinLines", <Merge />),
    { id: "s3", sep: true },
    item("shortcuts", "editor.aShortcuts", <Keyboard />),
  ];
  const onContext = (e: ReactMouseEvent) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); };
  const enc = ENCODINGS.find((x) => x.enc === doc.encoding && (x.enc !== "utf-8" || x.bom === doc.bom))?.id ?? "utf-8";

  return (
    <div className="ed-tab">
      <div className="toolbar">
        <button className="icon-btn" title={`${tr("editor.aNew")} (Ctrl+N)`} onClick={() => api.current.run("new")}><FilePlus /></button>
        <button className="icon-btn" title={`${tr("editor.aOpen")} (Ctrl+O)`} onClick={() => api.current.run("open")}><FolderOpen /></button>
        <button className="icon-btn" title={`${tr("editor.aSave")} (Ctrl+S)`} onClick={() => api.current.run("save")}><Save /></button>
        {doc.path && <button className="icon-btn" title={tr("editor.aReload")} onClick={() => api.current.run("reload")}><RotateCcw /></button>}
        <span className="tb-sep" />
        <button disabled={!canFormat(doc.lang)} title={`${tr("editor.aFormat")} (Ctrl+Shift+F)`} onClick={() => api.current.run("format")}><AlignLeft />{tr("editor.format")}</button>
        <button disabled={!canMinify(doc.lang)} title={`${tr("editor.aMinify")} (Ctrl+Shift+M)`} onClick={() => api.current.run("minify")}><Minimize2 />{tr("editor.minify")}</button>
        <button disabled={!CHECKABLE.includes(doc.lang)} title={`${tr("editor.aValidate")} (Ctrl+Alt+V)`} onClick={() => api.current.run("validate")}><CheckCheck />{tr("editor.validate")}</button>
        <span className="tb-sep" />
        <button className="icon-btn" title={`${tr("editor.aFind")} (Ctrl+F)`} onClick={() => { const v = viewRef.current; if (v) openSearchPanel(v); }}><Search /></button>
        <button className="icon-btn" title={`${tr("editor.aReplace")} (Ctrl+H)`} onClick={() => api.current.run("replace")}><Replace /></button>
        <button className="icon-btn" title={`${tr("editor.aGotoLine")} (Ctrl+L)`} onClick={() => api.current.run("gotoLine")}><ListOrdered /></button>
        <button className={`icon-btn ${wrap ? "on" : ""}`} title={`${tr("editor.aWrap")} (Alt+Z)`} onClick={() => api.current.run("wrap")}><WrapText /></button>
        <span className="grow" />
        <button className="icon-btn" title={`${tr("editor.aShortcuts")} (F1)`} onClick={() => api.current.run("shortcuts")}><Keyboard /></button>
      </div>
      <div className="ed-host" ref={host} style={{ ["--ed-font" as string]: `${font}px` }} onContextMenu={onContext} />
      <div className="ed-status">
        <span>{tr("editor.lnCol", { line: pos.line, col: pos.col })}</span>
        {pos.sel > 0 && <span>{tr("editor.selected", { n: pos.sel })}</span>}
        <span>{tr("editor.lines", { n: pos.lines })}</span>
        <span className={`grow ellipsis ed-msg ${msg?.kind ?? ""}`} title={msg?.text}>
          {msg && (msg.pos != null
            ? <button className="bad" onClick={() => { const v = viewRef.current; if (v && msg.pos != null) { v.dispatch({ selection: { anchor: msg.pos }, scrollIntoView: true }); v.focus(); } }}>{msg.text}</button>
            : msg.text)}
        </span>
        <Picker
          label={<><FileText />{langLabel(doc.lang)}</>}
          items={LANGS.map((l) => ({ id: l.id, label: l.label, selected: l.id === doc.lang }))}
          onPick={(l) => patchDoc(id, { lang: l as LangId, langManual: true })}
          title={tr("editor.language")}
          filterPlaceholder={tr("editor.filterLang")}
        />
        <Picker
          label={encLabel(doc.encoding, doc.bom)}
          items={ENCODINGS.map((e) => ({ id: e.id, label: e.label, selected: e.id === enc }))}
          onPick={(e) => { const x = ENCODINGS.find((y) => y.id === e)!; if (x.enc !== doc.encoding || x.bom !== doc.bom) { patchDoc(id, { encoding: x.enc, bom: x.bom }); scheduleDraft(id); } }}
          title={tr("editor.encoding")}
        />
        <button title={tr("editor.eolTitle")} onClick={() => { patchDoc(id, { eol: doc.eol === "\r\n" ? "\n" : "\r\n" }); scheduleDraft(id); }}>
          {doc.eol === "\r\n" ? "CRLF" : "LF"}
        </button>
        <span>{font}px</span>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
    </div>
  );
});
