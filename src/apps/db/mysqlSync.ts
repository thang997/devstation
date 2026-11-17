/**
 * Struct sync cho MySQL/MariaDB dựa trên `SHOW CREATE TABLE` (giống Navicat): so sánh từng dòng định nghĩa
 * nên giữ đủ AUTO_INCREMENT, ON UPDATE, COMMENT, CHARSET/COLLATE, cột generated, index, khoá ngoại, tuỳ chọn bảng.
 * Logic thuần (không gọi DB) để test được.
 */

export interface ParsedTable {
  /** Cột theo đúng thứ tự: tên + nguyên dòng định nghĩa (bỏ dấu phẩy cuối). */
  cols: { name: string; def: string }[];
  /** Index/ràng buộc: khoá ("PRIMARY", "IDX:<tên>", "FK:<tên>", "CHK:<tên>") → nguyên dòng định nghĩa. */
  keys: Map<string, string>;
  /** Tuỳ chọn bảng sau dấu ")" cuối (đã bỏ AUTO_INCREMENT=<n>). */
  options: string;
  isView: boolean;
}

const unbt = (s: string) => s.replace(/``/g, "`");
const bt = (s: string) => `\`${s.replace(/`/g, "``")}\``;
const stripAutoInc = (s: string) => s.replace(/\s*AUTO_INCREMENT=\d+/i, "");

export function parseCreateTable(ddl: string): ParsedTable {
  const out: ParsedTable = { cols: [], keys: new Map(), options: "", isView: false };
  if (!/^\s*CREATE\s+TABLE/i.test(ddl)) { out.isView = true; return out; }
  const lines = ddl.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim().replace(/,$/, "");
    if (!line) continue;
    if (line.startsWith(")")) { out.options = stripAutoInc(line.slice(1).trim()); continue; }
    if (line.startsWith("`")) {
      const m = /^`((?:[^`]|``)+)`/.exec(line);
      if (m) out.cols.push({ name: unbt(m[1]), def: line });
      continue;
    }
    let m: RegExpExecArray | null;
    if (/^PRIMARY KEY/i.test(line)) out.keys.set("PRIMARY", line);
    else if ((m = /^(?:UNIQUE |FULLTEXT |SPATIAL )?(?:KEY|INDEX) `((?:[^`]|``)+)`/i.exec(line))) out.keys.set(`IDX:${unbt(m[1])}`, line);
    else if ((m = /^CONSTRAINT `((?:[^`]|``)+)` FOREIGN KEY/i.exec(line))) out.keys.set(`FK:${unbt(m[1])}`, line);
    else if ((m = /^CONSTRAINT `((?:[^`]|``)+)` CHECK/i.exec(line))) out.keys.set(`CHK:${unbt(m[1])}`, line);
  }
  return out;
}

/** Chuẩn hoá để SO SÁNH (không dùng để sinh SQL): bỏ khác biệt hiển thị giữa MySQL/MariaDB/phiên bản. */
export function normDef(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(tinyint|smallint|mediumint|int|bigint)\(\d+\)/g, "$1") // độ rộng hiển thị số nguyên
    .replace(/\butf8mb3\b/g, "utf8")
    .replace(/current_timestamp\(\)/g, "current_timestamp")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dòng index/ràng buộc trong CREATE TABLE → mệnh đề ADD trong ALTER TABLE. */
const addKeyClause = (def: string) => `ADD ${def}`;

const FK_LINE = /^\s*CONSTRAINT\s+`(?:[^`]|``)+`\s+FOREIGN KEY/i;

/** CREATE TABLE bỏ các dòng khoá ngoại (thêm lại ở pha cuối) + sửa dấu phẩy. Trả về câu CREATE và danh sách FK. */
function splitForeignKeys(ddl: string): { create: string; fks: string[] } {
  const lines = ddl.trim().replace(/;\s*$/, "").split(/\r?\n/);
  const close = lines.findIndex((l, i) => i > 0 && l.trim().startsWith(")"));
  if (close < 0) return { create: ddl, fks: [] };
  const inner = lines.slice(1, close).map((l) => l.replace(/,\s*$/, ""));
  const fks = inner.filter((l) => FK_LINE.test(l)).map((l) => l.trim());
  const keep = inner.filter((l) => !FK_LINE.test(l));
  return { create: [lines[0], keep.join(",\n"), ...lines.slice(close)].join("\n"), fks };
}

const dropKeyClause = (key: string) =>
  key === "PRIMARY" ? "DROP PRIMARY KEY"
  : key.startsWith("FK:") ? `DROP FOREIGN KEY ${bt(key.slice(3))}`
  : key.startsWith("CHK:") ? `DROP CONSTRAINT ${bt(key.slice(4))}`
  : `DROP INDEX ${bt(key.slice(4))}`;

/* ── Kế hoạch đồng bộ: danh sách thay đổi CHỌN ĐƯỢC (theo bảng → theo cột/index/FK) ──────────────────────
   Script chia PHA trên TOÀN BỘ bảng để chạy qua được ràng buộc khoá ngoại (kể cả bảng mới trỏ lẫn nhau / vòng):
     1. DROP FOREIGN KEY (FK đã đổi / thừa) — mọi bảng
     2. CREATE TABLE bảng thiếu, KHÔNG kèm FK
     3. ALTER gộp từng bảng (drop index cũ → thêm/sửa cột → xoá cột → thêm index) — gộp một câu để MySQL áp
        cùng lúc, tránh lỗi thứ tự (vd. AUTO_INCREMENT cần khoá chính tồn tại)
     4. Tuỳ chọn bảng (ENGINE/CHARSET/COMMENT) nếu khác
     5. ADD FOREIGN KEY — sau cùng, khi mọi bảng/cột/index được tham chiếu đã có
   Không dùng SET FOREIGN_KEY_CHECKS=0: các câu có thể chạy trên kết nối khác nhau của pool. */

export type SyncKind = "create" | "column" | "key" | "fk" | "options";

/** Một mảnh SQL của một mục: câu đứng riêng (`stmt`) hoặc mệnh đề gộp vào ALTER TABLE của bảng (`clause`/`addCol`). */
export interface SyncPart {
  phase: 1 | 2 | 3 | 4 | 5;
  /** Thứ tự trong cùng câu ALTER (pha 3): 0 xoá index, 1 thêm/sửa cột, 2 xoá cột, 3 thêm index. */
  order: number;
  stmt?: string;
  clause?: string;
  /** Thêm cột: vị trí tính lúc ráp SQL (cột đứng trước có thể không được chọn). */
  addCol?: { def: string; prev: string[] };
}

export interface SyncItem {
  /** Duy nhất trong toàn kế hoạch: "<bảng>|<loại>|<tên>". */
  id: string;
  kind: SyncKind;
  action: "add" | "modify" | "drop";
  /** Tên cột / index / FK (rỗng với create/options). */
  name: string;
  /** Định nghĩa mới (hoặc cũ khi xoá) để hiện cho người dùng xem. */
  detail: string;
  parts: SyncPart[];
}

export interface SyncTable {
  table: string;
  /** Tên đủ ở đích (đã quote). */
  ref: string;
  isNew: boolean;
  items: SyncItem[];
  /** Cột đang có ở đích (để tính AFTER khi thêm cột). */
  dstCols: string[];
}

export interface SyncPlan {
  tables: SyncTable[];
  viewsSkipped: string[];
  onlyInTarget: string[];
}

/** Lập kế hoạch đồng bộ MySQL/MariaDB từ SHOW CREATE TABLE hai đầu (tên bảng → DDL). */
export function planMysqlSync(src: Record<string, string>, dst: Record<string, string>, dstSchema: string, dropExtra: boolean): SyncPlan {
  const ref = (t: string) => (dstSchema ? `${bt(dstSchema)}.${bt(t)}` : bt(t));
  const tables: SyncTable[] = [];
  const viewsSkipped: string[] = [];

  for (const [tbl, sddl] of Object.entries(src)) {
    const s = parseCreateTable(sddl);
    if (s.isView) { viewsSkipped.push(tbl); continue; }
    const dddl = dst[tbl];
    const items: SyncItem[] = [];
    const id = (kind: string, name = "") => `${tbl}|${kind}|${name}`;

    if (!dddl) {
      // Bảng thiếu ở đích: nguyên CREATE TABLE của nguồn (đổi schema, bỏ bộ đếm AUTO_INCREMENT), FK tách ra pha 5.
      const { create, fks } = splitForeignKeys(sddl);
      const body = stripAutoInc(create).replace(/^\s*CREATE\s+TABLE\s+`(?:[^`]|``)+`/i, `CREATE TABLE ${ref(tbl)}`);
      items.push({ id: id("create"), kind: "create", action: "add", name: "", detail: `${s.cols.length} columns`, parts: [{ phase: 2, order: 0, stmt: `${body};` }] });
      for (const fk of fks) {
        const name = /CONSTRAINT `((?:[^`]|``)+)`/i.exec(fk)?.[1] ?? fk;
        items.push({ id: id("fk", name), kind: "fk", action: "add", name: unbt(name), detail: fk, parts: [{ phase: 5, order: 0, clause: addKeyClause(fk) }] });
      }
      tables.push({ table: tbl, ref: ref(tbl), isNew: true, items, dstCols: [] });
      continue;
    }
    const d = parseCreateTable(dddl);
    if (d.isView) continue;

    // Cột: thêm (đúng vị trí) / sửa / xoá.
    s.cols.forEach((sc, i) => {
      const dc = d.cols.find((c) => c.name === sc.name);
      if (!dc) {
        const prev = s.cols.slice(0, i).map((c) => c.name).reverse();
        items.push({ id: id("col", sc.name), kind: "column", action: "add", name: sc.name, detail: sc.def, parts: [{ phase: 3, order: 1, addCol: { def: sc.def, prev } }] });
      } else if (normDef(dc.def) !== normDef(sc.def)) {
        items.push({ id: id("col", sc.name), kind: "column", action: "modify", name: sc.name, detail: `${dc.def}\n→ ${sc.def}`, parts: [{ phase: 3, order: 1, clause: `MODIFY COLUMN ${sc.def}` }] });
      }
    });
    if (dropExtra) for (const dc of d.cols) if (!s.cols.some((c) => c.name === dc.name)) {
      items.push({ id: id("col", dc.name), kind: "column", action: "drop", name: dc.name, detail: dc.def, parts: [{ phase: 3, order: 2, clause: `DROP COLUMN ${bt(dc.name)}` }] });
    }
    // Index / khoá chính / CHECK / FK: thêm, đổi (= xoá + thêm), xoá.
    const keyNames = new Set([...s.keys.keys(), ...d.keys.keys()]);
    for (const key of keyNames) {
      const sdef = s.keys.get(key);
      const ddef = d.keys.get(key);
      const isFk = key.startsWith("FK:");
      const name = key === "PRIMARY" ? "PRIMARY KEY" : key.slice(key.indexOf(":") + 1);
      const kind: SyncKind = isFk ? "fk" : "key";
      const dropPart: SyncPart = isFk ? { phase: 1, order: 0, clause: dropKeyClause(key) } : { phase: 3, order: 0, clause: dropKeyClause(key) };
      const addPart = (def: string): SyncPart => (isFk ? { phase: 5, order: 0, clause: addKeyClause(def) } : { phase: 3, order: 3, clause: addKeyClause(def) });
      if (sdef !== undefined && ddef === undefined) items.push({ id: id(kind, name), kind, action: "add", name, detail: sdef, parts: [addPart(sdef)] });
      else if (sdef !== undefined && ddef !== undefined && normDef(sdef) !== normDef(ddef)) items.push({ id: id(kind, name), kind, action: "modify", name, detail: `${ddef}\n→ ${sdef}`, parts: [dropPart, addPart(sdef)] });
      else if (sdef === undefined && ddef !== undefined && dropExtra) items.push({ id: id(kind, name), kind, action: "drop", name, detail: ddef, parts: [dropPart] });
    }
    if (s.options && normDef(s.options) !== normDef(d.options)) {
      items.push({ id: id("options"), kind: "options", action: "modify", name: "", detail: `${d.options}\n→ ${s.options}`, parts: [{ phase: 4, order: 0, stmt: `ALTER TABLE ${ref(tbl)} ${s.options};` }] });
    }
    if (items.length) tables.push({ table: tbl, ref: ref(tbl), isNew: false, items, dstCols: d.cols.map((c) => c.name) });
  }
  return { tables, viewsSkipped, onlyInTarget: Object.keys(dst).filter((t) => !(t in src)) };
}

/** Ráp SQL từ các mục được chọn (mặc định: tất cả), theo đúng 5 pha. Dùng chung MySQL và Postgres/SQLite. */
export function assembleSync(plan: SyncPlan, picked?: Set<string>): string {
  const PHASES: Record<number, string> = {
    1: "1. Drop foreign keys",
    2: "2. Create tables (foreign keys added in step 5)",
    3: "3. Alter columns / indexes",
    4: "4. Table options",
    5: "5. Add foreign keys",
  };
  const byPhase = new Map<number, string[]>();
  const push = (phase: number, s: string) => { (byPhase.get(phase) ?? byPhase.set(phase, []).get(phase)!).push(s); };
  for (const t of plan.tables) {
    const sel = t.items.filter((it) => !picked || picked.has(it.id));
    if (!sel.length) continue;
    // Cột thêm mới được chọn trong bảng này → có thể làm mốc AFTER cho cột thêm sau nó.
    const added = new Set(sel.filter((it) => it.kind === "column" && it.action === "add").map((it) => it.name));
    const have = new Set(t.dstCols);
    const clauses = new Map<number, { order: number; i: number; c: string }[]>();
    let i = 0;
    for (const it of sel) for (const p of it.parts) {
      if (p.stmt) { push(p.phase, p.stmt); continue; }
      let c = p.clause ?? "";
      if (p.addCol) {
        const after = p.addCol.prev.find((n) => have.has(n) || added.has(n));
        c = `ADD COLUMN ${p.addCol.def}${after ? ` AFTER ${bt(after)}` : " FIRST"}`;
      }
      (clauses.get(p.phase) ?? clauses.set(p.phase, []).get(p.phase)!).push({ order: p.order, i: i++, c });
    }
    for (const [phase, list] of clauses) {
      list.sort((a, b) => a.order - b.order || a.i - b.i);
      push(phase, `ALTER TABLE ${t.ref}\n  ${list.map((x) => x.c).join(",\n  ")};`);
    }
  }
  return [1, 2, 3, 4, 5].flatMap((ph) => (byPhase.get(ph)?.length ? [`-- ${PHASES[ph]}`, ...byPhase.get(ph)!] : [])).join("\n\n");
}

/** Chọn tất cả rồi ráp SQL (giữ cho test + chỗ cần nhanh). */
export function buildMysqlSync(
  src: Record<string, string>,
  dst: Record<string, string>,
  dstSchema: string,
  dropExtra: boolean,
): { sql: string; notes: string[]; viewsSkipped: string[]; onlyInTarget: string[] } {
  const plan = planMysqlSync(src, dst, dstSchema, dropExtra);
  return { sql: assembleSync(plan), notes: [], viewsSkipped: plan.viewsSkipped, onlyInTarget: plan.onlyInTarget };
}
