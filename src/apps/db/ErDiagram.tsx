import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Modal } from "../../shell/Modal";
import { viewerHtml } from "../../shell/svgViewer";
import { Loading } from "../../shell/Loading";
import { useT } from "../../store/lang";
import { FileDown, ImageDown, LayoutGrid, Link, Maximize, ZoomIn, ZoomOut } from "lucide-react";

/**
 * Sơ đồ quan hệ (ER) cha–con theo KHOÁ NGOẠI của một database MySQL/MariaDB.
 * - Đọc `information_schema.TABLES / COLUMNS / KEY_COLUMN_USAGE` (một lượt, không cần quyền đặc biệt).
 * - Tự xếp theo tầng: bảng CHA (được tham chiếu) bên trái → bảng CON bên phải; trong mỗi tầng xếp theo
 *   vị trí trung bình của bảng cha để giảm đường cắt nhau. Bảng không có quan hệ gom về cuối (ẩn được).
 * - Kéo nền = di chuyển, cuộn chuột = phóng to/thu nhỏ, kéo tiêu đề bảng = dời bảng (vị trí nhớ theo kết nối + db).
 * - Rê chuột / chọn một bảng → tô sáng các quan hệ của nó. Double-click bảng = mở dữ liệu bảng.
 * - Đường nối: đầu "nhiều" (chân chim) ở bảng con, vạch "một" ở bảng cha; nét đứt = cột khoá ngoại cho phép NULL.
 */

interface QueryOut { columns: string[]; rows: (string | null)[][] }
interface Col { name: string; type: string; pk: boolean; fk: boolean; nullable: boolean }
interface Tbl { name: string; cols: Col[] }
interface Fk { name: string; from: string; fromCols: string[]; to: string; toCols: string[]; external: boolean }
interface Pos { x: number; y: number }

const HEAD = 26;
const ROW = 18;
const PADB = 6;
const GAP_X = 110;
const GAP_Y = 28;
const CHAR_W = 6.6;

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "''");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function ErDiagram({ dbId, connKey, db, focus: focusTable, onClose, onOpenTable }: {
  dbId: string;
  /** Khoá lưu vị trí bảng (id kết nối). */
  connKey: string;
  db: string;
  /** Mở xong thì nhảy tới + chọn bảng này (mở từ menu chuột phải một bảng). */
  focus?: string;
  onClose: () => void;
  onOpenTable?: (table: string) => void;
}) {
  const tr = useT();
  const [tables, setTables] = useState<Tbl[] | null>(null);
  const [fks, setFks] = useState<Fk[]>([]);
  const [err, setErr] = useState("");
  const [compact, setCompact] = useState(false);
  const [showIsolated, setShowIsolated] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const storeKey = `devstation.db.er.${connKey}.${db}`;
  const [moved, setMoved] = useState<Record<string, Pos>>(() => {
    try { return JSON.parse(localStorage.getItem(storeKey) ?? "{}"); } catch { return {}; }
  });
  const wrapRef = useRef<HTMLDivElement>(null);

  /* ── Nạp cấu trúc ── */
  useEffect(() => {
    let off = false;
    const s = esc(db);
    const run = (sql: string) => invoke<QueryOut>("db_query", { id: dbId, sql, limit: 200000 });
    (async () => {
      try {
        const [tb, cols, keys] = await Promise.all([
          run(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='${s}' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`),
          run(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${s}' ORDER BY TABLE_NAME, ORDINAL_POSITION`),
          run(`SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='${s}' AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`),
        ]);
        if (off) return;
        const map = new Map<string, Tbl>();
        for (const [n] of tb.rows) if (n) map.set(n, { name: n, cols: [] });
        for (const [t, c, type, key, nul] of cols.rows) {
          const tbl = t ? map.get(t) : undefined;
          if (tbl && c) tbl.cols.push({ name: c, type: type ?? "", pk: key === "PRI", fk: false, nullable: nul === "YES" });
        }
        const fkMap = new Map<string, Fk>();
        for (const [cn, t, c, rs, rt, rc] of keys.rows) {
          if (!t || !c || !rt || !rc || !map.has(t)) continue;
          const k = `${t}\u0000${cn}`;
          let f = fkMap.get(k);
          if (!f) { f = { name: cn ?? "", from: t, fromCols: [], to: rt, toCols: [], external: rs !== db || !map.has(rt) }; fkMap.set(k, f); }
          f.fromCols.push(c);
          f.toCols.push(rc);
          const col = map.get(t)!.cols.find((x) => x.name === c);
          if (col) col.fk = true;
        }
        setTables([...map.values()]);
        setFks([...fkMap.values()]);
      } catch (e) {
        if (!off) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { off = true; };
  }, [dbId, db]);


  const related = useMemo(() => {
    const s = new Set<string>();
    for (const f of fks) if (!f.external) { s.add(f.from); s.add(f.to); }
    return s;
  }, [fks]);

  // Bảng cần nhảy tới mà không có quan hệ → bật hiện bảng lẻ để thấy được nó.
  useEffect(() => {
    if (focusTable && tables && !related.has(focusTable)) setShowIsolated(true);
  }, [focusTable, tables, related]);

  // Không có quan hệ nào → hiện mọi bảng (để sơ đồ không trống trơn).
  const isolatedVisible = showIsolated || related.size === 0;

  const visible = useMemo(
    () => (tables ?? []).filter((t) => isolatedVisible || related.has(t.name)),
    [tables, related, isolatedVisible],
  );

  /** Tra cứu O(1): bảng theo tên, cột hiển thị (chế độ gọn: chỉ khoá), vị trí dòng của từng cột. */
  const tblMap = useMemo(() => new Map(visible.map((t) => [t.name, t])), [visible]);
  const colsMap = useMemo(
    () => new Map(visible.map((t) => [t.name, compact ? t.cols.filter((c) => c.pk || c.fk) : t.cols])),
    [visible, compact],
  );
  const rowIdx = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const [n, cols] of colsMap) m.set(n, new Map(cols.map((c, i) => [c.name, i])));
    return m;
  }, [colsMap]);

  const sizes = useMemo(() => {
    const m = new Map<string, { w: number; h: number }>();
    for (const t of visible) {
      const cols = colsMap.get(t.name)!;
      let longest = t.name.length + 3;
      for (const c of cols) longest = Math.max(longest, c.name.length + c.type.length + 5);
      m.set(t.name, { w: Math.round(Math.min(340, Math.max(170, 24 + longest * CHAR_W))), h: HEAD + cols.length * ROW + PADB });
    }
    return m;
  }, [visible, colsMap]);

  /* ── Xếp tầng tự động ── */
  const auto = useMemo(() => {
    const pos: Record<string, Box> = {};
    if (!visible.length) return pos;
    const parents = new Map<string, Set<string>>();
    const children = new Map<string, Set<string>>();
    for (const f of fks) {
      if (f.external || f.from === f.to || !tblMap.has(f.from) || !tblMap.has(f.to)) continue;
      (parents.get(f.from) ?? parents.set(f.from, new Set()).get(f.from)!).add(f.to);
      (children.get(f.to) ?? children.set(f.to, new Set()).get(f.to)!).add(f.from);
    }
    // Tầng = đường dài nhất tới bảng gốc (không trỏ đi đâu). Vòng tham chiếu → cắt ở cạnh quay lại.
    const level = new Map<string, number>();
    const visiting = new Set<string>();
    const lv = (n: string): number => {
      const known = level.get(n);
      if (known !== undefined) return known;
      if (visiting.has(n)) return 0;
      visiting.add(n);
      let l = 0;
      for (const p of parents.get(n) ?? []) l = Math.max(l, lv(p) + 1);
      visiting.delete(n);
      level.set(n, l);
      return l;
    };
    const linked = visible.filter((t) => parents.has(t.name) || children.has(t.name));
    const lonely = visible.filter((t) => !parents.has(t.name) && !children.has(t.name));
    linked.forEach((t) => lv(t.name));
    const byLevel: Tbl[][] = [];
    for (const t of linked) (byLevel[level.get(t.name)!] ??= []).push(t);

    let totalH = 0;
    for (const s of sizes.values()) totalH += s.h + GAP_Y;
    const maxH = Math.max(900, Math.sqrt(totalH * 900));
    const order = new Map<string, number>();
    let x = 0;
    const place = (list: Tbl[]) => {
      let y = 0, colW = 0;
      for (const t of list) {
        const { w, h } = sizes.get(t.name)!;
        if (y > 0 && y + h > maxH) { x += colW + GAP_X; y = 0; colW = 0; }
        pos[t.name] = { x, y, w, h };
        order.set(t.name, y);
        y += h + GAP_Y;
        colW = Math.max(colW, w);
      }
      x += colW + GAP_X;
    };
    byLevel.forEach((list, i) => {
      if (!list) return;
      if (i === 0) list.sort((a, b) => (children.get(b.name)?.size ?? 0) - (children.get(a.name)?.size ?? 0) || a.name.localeCompare(b.name));
      else {
        const bary = new Map<string, number>();
        for (const t of list) {
          let sum = 0, n = 0;
          for (const p of parents.get(t.name) ?? []) { const v = order.get(p); if (v !== undefined) { sum += v; n++; } }
          bary.set(t.name, n ? sum / n : Infinity);
        }
        list.sort((a, b) => bary.get(a.name)! - bary.get(b.name)! || a.name.localeCompare(b.name));
      }
      place(list);
    });
    if (lonely.length) { x += GAP_X; place(lonely.sort((a, b) => a.name.localeCompare(b.name))); }
    return pos;
  }, [visible, fks, tblMap, sizes]);

  /** Vị trí cuối = tự động + vị trí người dùng đã kéo. Giữ NGUYÊN object của bảng không đổi chỗ
   *  → TableBox (memo) không vẽ lại khi đang kéo một bảng khác. */
  const boxCache = useRef(new Map<string, Box>());
  const boxes = useMemo(() => {
    const r: Record<string, Box> = {};
    const cache = boxCache.current;
    for (const [n, p] of Object.entries(auto)) {
      const m = moved[n];
      const x = m ? m.x : p.x, y = m ? m.y : p.y;
      const old = cache.get(n);
      r[n] = old && old.x === x && old.y === y && old.w === p.w && old.h === p.h ? old : { x, y, w: p.w, h: p.h };
      cache.set(n, r[n]);
    }
    return r;
  }, [auto, moved]);

  // Lưu vị trí đã kéo (gộp, không ghi mỗi lần chuột nhích).
  useEffect(() => {
    const h = setTimeout(() => { try { localStorage.setItem(storeKey, JSON.stringify(moved)); } catch { /* bỏ qua */ } }, 400);
    return () => clearTimeout(h);
  }, [moved, storeKey]);

  /* ── Khung nhìn: pan/zoom ghi THẲNG vào DOM (không render React mỗi lần chuột nhích).
   *  Khi ngừng thao tác (~120ms) mới "chốt" vào state → cắt bảng ngoài màn hình + đổi mức chi tiết. */
  const viewRef = useRef({ x: 20, y: 20, k: 1 });
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<HTMLSpanElement>(null);
  const raf = useRef(0);
  const settleTimer = useRef(0);
  const [settled, setSettled] = useState({ x: 20, y: 20, k: 1, w: 0, h: 0 });
  const paint = useCallback(() => {
    raf.current = 0;
    const v = viewRef.current;
    gRef.current?.setAttribute("transform", `translate(${v.x},${v.y}) scale(${v.k})`);
    if (zoomRef.current) zoomRef.current.textContent = `${Math.round(v.k * 100)}%`;
    const el = wrapRef.current;
    if (el) el.style.backgroundPosition = `${v.x}px ${v.y}px`;
  }, []);
  const setView = useCallback((next: { x: number; y: number; k: number } | ((v: { x: number; y: number; k: number }) => { x: number; y: number; k: number })) => {
    viewRef.current = typeof next === "function" ? next(viewRef.current) : next;
    if (!raf.current) raf.current = requestAnimationFrame(paint);
    clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const el = wrapRef.current;
      setSettled({ ...viewRef.current, w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 });
    }, 120);
  }, [paint]);
  useEffect(() => () => { cancelAnimationFrame(raf.current); clearTimeout(settleTimer.current); }, []);

  /* ── Vừa khung ── */
  const bbox = useCallback(() => {
    const vs = Object.values(boxes);
    if (!vs.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const b of vs) { x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); }
    return { x1, y1, x2, y2 };
  }, [boxes]);
  const fit = useCallback(() => {
    const el = wrapRef.current, b = bbox();
    if (!el || !b) return;
    const W = el.clientWidth, H = el.clientHeight;
    const k = Math.min(1.2, Math.max(0.05, Math.min((W - 40) / (b.x2 - b.x1), (H - 40) / (b.y2 - b.y1))));
    setView({ k, x: (W - (b.x2 - b.x1) * k) / 2 - b.x1 * k, y: (H - (b.y2 - b.y1) * k) / 2 - b.y1 * k });
  }, [bbox, setView]);
  const centerOn = useCallback((name: string) => {
    const el = wrapRef.current, b = boxes[name];
    if (!el || !b) return;
    const k = Math.max(viewRef.current.k, 0.8);
    setView({ k, x: el.clientWidth / 2 - (b.x + b.w / 2) * k, y: el.clientHeight / 2 - (b.y + b.h / 2) * k });
    setSel(name);
  }, [boxes, setView]);
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current || !Object.keys(boxes).length) return;
    const known = !!focusTable && !!tables?.some((t) => t.name === focusTable);
    if (known && !boxes[focusTable!]) return; // chờ bật hiện bảng lẻ
    fitted.current = true;
    if (known) centerOn(focusTable!); else fit();
  }, [boxes, fit, centerOn, focusTable, tables]);

  /* ── Chuột: kéo nền / kéo bảng / zoom ── */
  const lastMoved = useRef(0);
  const drag = useRef<{ kind: "pan" | "box"; name?: string; sx: number; sy: number; ox: number; oy: number; movedPx: number } | null>(null);
  const boxRaf = useRef(0);
  const pendingBox = useRef<{ name: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      d.movedPx = Math.max(d.movedPx, Math.abs(dx) + Math.abs(dy));
      if (d.kind === "pan") setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
      else if (d.name) {
        const k = viewRef.current.k;
        pendingBox.current = { name: d.name, x: Math.round(d.ox + dx / k), y: Math.round(d.oy + dy / k) };
        // Gộp theo khung hình: tối đa một lần render / frame.
        if (!boxRaf.current) boxRaf.current = requestAnimationFrame(() => {
          boxRaf.current = 0;
          const p = pendingBox.current;
          if (p) setMoved((m) => ({ ...m, [p.name]: { x: p.x, y: p.y } }));
        });
      }
    };
    const up = () => {
      lastMoved.current = drag.current?.movedPx ?? 0;
      drag.current = null;
      document.body.classList.remove("er-dragging");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); cancelAnimationFrame(boxRaf.current); };
  }, [setView]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(2.5, Math.max(0.05, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k };
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [setView]);

  const startPan = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const v = viewRef.current;
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y, movedPx: 0 };
    document.body.classList.add("er-dragging");
  };
  const startBox = useCallback((e: React.MouseEvent, name: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const b = boxCache.current.get(name);
    if (!b) return;
    drag.current = { kind: "box", name, sx: e.clientX, sy: e.clientY, ox: b.x, oy: b.y, movedPx: 0 };
    document.body.classList.add("er-dragging");
    setSel(name);
  }, []);
  // Đang kéo thì không đổi hover (tránh render cả sơ đồ khi con trỏ lướt qua các bảng).
  // Trễ ~70ms: lướt chuột ngang qua nhiều bảng không gây một loạt lần vẽ lại cả sơ đồ.
  const hoverTimer = useRef(0);
  const onEnter = useCallback((name: string | null) => {
    clearTimeout(hoverTimer.current);
    if (drag.current) return;
    hoverTimer.current = window.setTimeout(() => setHover(name), name ? 70 : 40);
  }, []);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  /* ── Đường nối: hình học KHÔNG phụ thuộc bảng đang tô sáng (chỉ tính lại khi bảng dời chỗ) ── */
  const edges = useMemo(() => {
    const out: Edge[] = [];
    for (const f of fks) {
      const c = boxes[f.from], p = boxes[f.to];
      if (!c || !p || f.external) continue;
      const rowY = (n: string, b: Box, col: string) => {
        const i = rowIdx.get(n)?.get(col);
        return i === undefined ? b.y + HEAD / 2 : b.y + HEAD + i * ROW + ROW / 2;
      };
      const y1 = rowY(f.from, c, f.fromCols[0]);
      const y2 = rowY(f.to, p, f.toCols[0]);
      const ct = tblMap.get(f.from)!;
      const dashed = f.fromCols.some((n) => ct.cols.find((x) => x.name === n)?.nullable);
      let d: string, mid: Pos, x1: number, x2: number;
      if (f.from === f.to) {
        x1 = c.x + c.w; x2 = x1 + 50;
        d = `M${x1},${y1} C${x1 + 50},${y1} ${x1 + 50},${y2} ${x1},${y2}`;
        mid = { x: x1 + 38, y: (y1 + y2) / 2 };
      } else {
        const right = p.x + p.w / 2 < c.x + c.w / 2; // cha nằm bên trái con
        x1 = right ? c.x : c.x + c.w;
        x2 = right ? p.x + p.w : p.x;
        const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (right ? -1 : 1);
        d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
        mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      }
      out.push({
        key: `${f.from}.${f.name}`, d, f, dashed, mid,
        bx1: Math.min(x1, x2), bx2: Math.max(x1, x2), by1: Math.min(y1, y2), by2: Math.max(y1, y2),
      });
    }
    return out;
  }, [fks, boxes, rowIdx, tblMap]);

  const focus = hover ?? sel;
  const neighbours = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    for (const f of fks) { if (f.from === focus) s.add(f.to); if (f.to === focus) s.add(f.from); }
    return s;
  }, [focus, fks]);

  /* ── Cắt phần ngoài màn hình (đệm thêm nửa khung mỗi phía) + mức chi tiết theo độ zoom ── */
  const cull = useMemo(() => {
    if (!settled.w) return null;
    const { x, y, k, w, h } = settled;
    const mx = w / k / 2, my = h / k / 2;
    return { x1: -x / k - mx, y1: -y / k - my, x2: (w - x) / k + mx, y2: (h - y) / k + my };
  }, [settled]);
  const inView = (x1: number, y1: number, x2: number, y2: number) =>
    !cull || (x2 >= cull.x1 && x1 <= cull.x2 && y2 >= cull.y1 && y1 <= cull.y2);
  /** Thu nhỏ nhiều → chỉ vẽ khung + tên bảng (chữ cột quá nhỏ để đọc, lại tốn nhất). */
  const lod = settled.k < 0.45;

  const external = useMemo(() => fks.filter((f) => f.external), [fks]);
  const matches = q.trim() ? visible.filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 12) : [];

  const pal = useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
    return {
      bg: v("--bg", "#0d1117"), box: v("--bg-2", "#161b22"), head: v("--bg-3", "#21262d"), line: v("--line", "#30363d"),
      fg: v("--fg", "#e6edf3"), muted: v("--muted", "#8b949e"), primary: v("--primary", "#1f6feb"), warn: "#d29922",
    };
  }, []);

  /* ── Xuất SVG: dựng lại ĐẦY ĐỦ (không cắt, không giảm chi tiết) bằng chuỗi, màu lấy từ biến CSS ── */
  /** Dựng SVG ĐẦY ĐỦ (không cắt, không giảm chi tiết) bằng chuỗi, màu lấy từ biến CSS.
   *  `html` = bản cho file HTML tương tác: gắn data-* + class để script tô sáng quan hệ, marker theo màu nét. */
  const buildSvg = (html: boolean) => {
    const b = bbox();
    if (!b) return null;
    const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    // Lề 60px: vòng tự tham chiếu nhô ra bên phải bảng ~50px.
    const M = 60, w = b.x2 - b.x1 + 2 * M, h = b.y2 - b.y1 + 2 * M;
    const mk = html ? "context-stroke" : pal.muted;
    const parts: string[] = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" style="background:${pal.bg}" font-family="Consolas, Menlo, monospace" font-size="12">`);
    parts.push(`<defs><marker id="m" viewBox="0 0 12 12" refX="12" refY="6" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,6 L12,0 M0,6 L12,6 M0,6 L12,12" fill="none" stroke="${mk}" stroke-width="1.3"/></marker>`);
    parts.push(`<marker id="o" viewBox="0 0 12 12" refX="12" refY="6" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto"><path d="M7,0 L7,12 M10,0 L10,12" fill="none" stroke="${mk}" stroke-width="1.3"/></marker></defs>`);
    if (!html) parts.push(`<rect width="100%" height="100%" fill="${pal.bg}"/>`);
    parts.push(`<g transform="translate(${M - b.x1},${M - b.y1})">`);
    for (const e of edges) {
      const data = html ? ` class="e" data-f="${x(e.f.from)}" data-t="${x(e.f.to)}"` : "";
      parts.push(`<path${data} d="${e.d}" fill="none" stroke="${pal.muted}" stroke-width="1.2"${e.dashed ? ` stroke-dasharray="5 4"` : ""} marker-start="url(#m)" marker-end="url(#o)"><title>${x(`${e.f.from}(${e.f.fromCols.join(", ")}) → ${e.f.to}(${e.f.toCols.join(", ")})`)}</title></path>`);
    }
    for (const [n, bx] of Object.entries(boxes)) {
      const cols = colsMap.get(n) ?? [];
      const maxChars = Math.floor((bx.w - 20) / CHAR_W);
      const data = html ? ` class="t" data-n="${x(n)}" data-b="${bx.x + M - b.x1},${bx.y + M - b.y1},${bx.w},${bx.h}"` : "";
      parts.push(`<g${data} transform="translate(${bx.x},${bx.y})"><rect width="${bx.w}" height="${bx.h}" fill="${pal.box}" stroke="${pal.line}"/><rect class="hd" width="${bx.w}" height="${HEAD}" fill="${pal.head}" stroke="${pal.line}"/>`);
      parts.push(`<text x="8" y="17" fill="${pal.fg}" font-weight="700">${x(cut(n, maxChars))}</text>`);
      cols.forEach((c, i) => {
        const y = HEAD + i * ROW + 13;
        parts.push(`<text x="8" y="${y}" fill="${c.pk ? pal.warn : c.fk ? pal.primary : pal.fg}">${c.pk ? "◆" : c.fk ? "◇" : "·"} ${x(cut(c.name, maxChars - 4))}</text>`);
        parts.push(`<text x="${bx.w - 8}" y="${y}" fill="${pal.muted}" text-anchor="end" font-size="11">${x(c.type)}${c.nullable ? "?" : ""}</text>`);
      });
      parts.push(`</g>`);
    }
    parts.push(`</g></svg>`);
    return parts.join("");
  };

  const exportSvg = async () => {
    const svg = buildSvg(false);
    if (!svg) return;
    const path = await saveDialog({ title: tr("db.erExportSvg"), defaultPath: `${db}-er.svg`, filters: [{ name: "SVG", extensions: ["svg"] }] });
    if (typeof path !== "string") return;
    await invoke("write_text_file", { path, content: svg });
  };

  /** File HTML độc lập (không cần mạng): cuộn = zoom quanh con trỏ, kéo = di chuyển, tìm bảng, rê chuột tô sáng quan hệ. */
  const exportHtml = async () => {
    const svg = buildSvg(true);
    if (!svg) return;
    const path = await saveDialog({ title: tr("db.erExportHtml"), defaultPath: `${db}-er.html`, filters: [{ name: "HTML", extensions: ["html"] }] });
    if (typeof path !== "string") return;
    const html = viewerHtml({ title: `${db} — ER`, heading: db, svg, pal, find: tr("db.erFindTable"), fit: tr("db.erFit"), help: tr("db.erHtmlHelp") });
    await invoke("write_text_file", { path, content: html });
  };

  const v0 = viewRef.current;
  const shownEdges = edges.filter((e) => inView(e.bx1, e.by1, e.bx2, e.by2));

  return (
    <Modal title={<><Link /> {tr("db.erTitle")} — <span className="mono">{db}</span></>} width={1600} onClose={onClose}>
      <div className="er">
        <div className="er-bar">
          <div className="er-search">
            <input
              className="side-search"
              placeholder={tr("db.erFindTable")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) { centerOn(matches[0].name); setQ(""); } if (e.key === "Escape") { e.stopPropagation(); setQ(""); } }}
            />
            {matches.length > 0 && (
              <div className="er-sug">
                {matches.map((t) => <div key={t.name} className="er-sug-item mono" onMouseDown={(e) => { e.preventDefault(); centerOn(t.name); setQ(""); }}>{t.name}</div>)}
              </div>
            )}
          </div>
          <label className="check"><input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} /> {tr("db.erKeysOnly")}</label>
          <label className="check" title={tr("db.erIsolatedHint")}>
            <input type="checkbox" checked={isolatedVisible} disabled={related.size === 0} onChange={(e) => setShowIsolated(e.target.checked)} /> {tr("db.erShowIsolated")}
          </label>
          <span className="grow" />
          {tables && <span className="muted small">{tr("db.erStats", { tables: tables.length, fks: fks.length - external.length, linked: related.size })}</span>}
          <button onClick={fit}><Maximize /> {tr("db.erFit")}</button>
          <button onClick={() => setView((v) => ({ ...v, k: Math.min(2.5, v.k * 1.25) }))}><ZoomIn /></button>
          <button onClick={() => setView((v) => ({ ...v, k: Math.max(0.05, v.k / 1.25) }))}><ZoomOut /></button>
          <span ref={zoomRef} className="muted small er-zoom">{Math.round(v0.k * 100)}%</span>
          <button title={tr("db.erResetLayoutHint")} onClick={() => { setMoved({}); fitted.current = false; }}><LayoutGrid /> {tr("db.erResetLayout")}</button>
          <button onClick={() => void exportSvg()}><ImageDown /> {tr("db.erExportSvg")}</button>
          <button title={tr("db.erExportHtmlHint")} onClick={() => void exportHtml()}><FileDown /> {tr("db.erExportHtml")}</button>
        </div>

        <div ref={wrapRef} className="er-canvas" onMouseDown={startPan} onClick={(e) => { if (lastMoved.current > 4) return; if (e.target === e.currentTarget || (e.target as Element).tagName === "svg") setSel(null); }}>
          {err ? <div className="error-box pre">{err}</div>
            : !tables ? <Loading label={tr("db.erLoading")} />
            : !visible.length ? <div className="sftp-center">{tr("db.erNoTables")}</div>
            : (
              <svg width="100%" height="100%" fontFamily="Consolas, Menlo, 'DejaVu Sans Mono', monospace" fontSize="12" textRendering="optimizeSpeed" shapeRendering="optimizeSpeed">
                <defs>
                  {(["n", "on"] as const).map((k) => (
                    <g key={k}>
                      <marker id={`er-many-${k}`} viewBox="0 0 12 12" refX="12" refY="6" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                        <path d="M0,6 L12,0 M0,6 L12,6 M0,6 L12,12" fill="none" stroke={k === "on" ? pal.primary : pal.muted} strokeWidth="1.3" />
                      </marker>
                      <marker id={`er-one-${k}`} viewBox="0 0 12 12" refX="12" refY="6" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto">
                        <path d="M7,0 L7,12 M10,0 L10,12" fill="none" stroke={k === "on" ? pal.primary : pal.muted} strokeWidth="1.3" />
                      </marker>
                    </g>
                  ))}
                </defs>
                <g ref={gRef} transform={`translate(${v0.x},${v0.y}) scale(${v0.k})`}>
                  {shownEdges.map((e) => {
                    const on = !!focus && (e.f.from === focus || e.f.to === focus);
                    return on ? null : <EdgePath key={e.key} e={e} color={pal.muted} faded={!!focus} lod={lod} />;
                  })}
                  {Object.entries(boxes).map(([name, b]) =>
                    inView(b.x, b.y, b.x + b.w, b.y + b.h) || name === focus ? (
                      <TableBox
                        key={name}
                        name={name}
                        totalCols={tblMap.get(name)?.cols.length ?? 0}
                        cols={colsMap.get(name)!}
                        b={b}
                        pal={pal}
                        selected={sel === name}
                        dim={!!neighbours && !neighbours.has(name)}
                        lod={lod}
                        onDown={startBox}
                        onEnter={onEnter}
                        onOpen={onOpenTable}
                      />
                    ) : null,
                  )}
                  {/* Quan hệ đang tô sáng vẽ SAU cùng để nổi trên các bảng. */}
                  {focus && edges.filter((e) => e.f.from === focus || e.f.to === focus).map((e) => (
                    <g key={e.key}>
                      <path d={e.d} fill="none" stroke={pal.primary} strokeWidth={2} strokeDasharray={e.dashed ? "6 4" : undefined}
                        markerStart="url(#er-many-on)" markerEnd="url(#er-one-on)" />
                      <text x={e.mid.x} y={e.mid.y - 5} textAnchor="middle" fill={pal.primary} fontSize="11" paintOrder="stroke" stroke={pal.bg} strokeWidth={3}>
                        {e.f.fromCols.join(", ")} → {e.f.toCols.join(", ")}
                      </text>
                    </g>
                  ))}
                </g>
              </svg>
            )}
        </div>

        <div className="er-foot muted small">
          <span>{tr("db.erHelp")}</span>
          {external.length > 0 && (
            <span title={external.map((f) => `${f.from}(${f.fromCols.join(",")}) → ${f.to}`).join("\n")}>
              · {tr("db.erExternal", { n: external.length })}
            </span>
          )}
        </div>
      </div>
    </Modal>
  );
}

interface Box { x: number; y: number; w: number; h: number }
interface Edge { key: string; d: string; f: Fk; dashed: boolean; mid: Pos; bx1: number; bx2: number; by1: number; by2: number }
type Pal = { bg: string; box: string; head: string; line: string; fg: string; muted: string; primary: string; warn: string };

/** Một đường nối (memo: chỉ vẽ lại khi hình dạng / trạng thái mờ đổi). Thu nhỏ nhiều thì bỏ marker. */
const EdgePath = memo(function EdgePath({ e, color, faded, lod }: { e: Edge; color: string; faded: boolean; lod: boolean }) {
  return (
    <path d={e.d} fill="none" stroke={color} strokeOpacity={faded ? 0.15 : 0.7} strokeWidth={lod ? 2 : 1.2}
      strokeDasharray={e.dashed && !lod ? "5 4" : undefined}
      markerStart={lod ? undefined : "url(#er-many-n)"} markerEnd={lod ? undefined : "url(#er-one-n)"} />
  );
});

const TableBox = memo(function TableBox({ name, totalCols, cols, b, pal, selected, dim, lod, onDown, onEnter, onOpen }: {
  name: string;
  totalCols: number;
  cols: Col[];
  b: Box;
  pal: Pal;
  selected: boolean;
  dim: boolean;
  lod: boolean;
  onDown: (e: React.MouseEvent, name: string) => void;
  onEnter: (name: string | null) => void;
  onOpen?: (name: string) => void;
}) {
  const maxChars = Math.floor((b.w - 20) / CHAR_W);
  const stroke = selected ? pal.primary : pal.line;
  return (
    <g
      transform={`translate(${b.x},${b.y})`}
      opacity={dim ? 0.35 : 1}
      onMouseDown={(e) => onDown(e, name)}
      onMouseEnter={() => onEnter(name)}
      onMouseLeave={() => onEnter(null)}
      onDoubleClick={() => onOpen?.(name)}
      style={{ cursor: "move" }}
    >
      <rect width={b.w} height={b.h} fill={pal.box} stroke={stroke} strokeWidth={selected ? 2 : 1} />
      <rect width={b.w} height={HEAD} fill={pal.head} stroke={stroke} strokeWidth={selected ? 2 : 1} />
      {lod ? (
        // Mức chi tiết thấp: chỉ tên bảng, chữ to để vẫn đọc được khi thu nhỏ.
        <text x={b.w / 2} y={Math.min(b.h / 2 + 10, b.h - 6)} fill={pal.fg} fontWeight="700" fontSize={Math.min(34, Math.max(14, b.w / Math.max(6, name.length) * 1.5))} textAnchor="middle">{name}</text>
      ) : (
        <>
          <text x={8} y={17} fill={pal.fg} fontWeight="700">{cut(name, maxChars)}</text>
          <title>{`${name} · ${totalCols} cols`}</title>
          {cols.map((c, i) => {
            const y = HEAD + i * ROW + 13;
            const typeChars = Math.min(c.type.length, Math.max(4, maxChars - c.name.length - 3));
            return (
              <g key={c.name}>
                <text x={8} y={y} fill={c.pk ? pal.warn : c.fk ? pal.primary : pal.fg}>
                  {c.pk ? "◆" : c.fk ? "◇" : "·"} {cut(c.name, maxChars - 4)}
                </text>
                <text x={b.w - 8} y={y} fill={pal.muted} textAnchor="end" fontSize="11">{cut(c.type, typeChars)}{c.nullable ? "?" : ""}</text>
              </g>
            );
          })}
        </>
      )}
    </g>
  );
});
