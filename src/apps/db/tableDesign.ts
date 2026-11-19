/**
 * Edit table kiểu Navicat — phần THUẦN (không React, không gọi DB) để test được:
 * từ các dòng người dùng thêm (cột / index / khoá ngoại) + thứ tự cột mới → danh sách câu DDL theo driver.
 * Thứ tự câu: thêm cột → đổi thứ tự cột → thêm index → thêm khoá ngoại (index/FK có thể dùng cột vừa thêm).
 */

export type DesignDriver = "mysql" | "postgres" | "sqlite";

export interface NewCol { key: string; name: string; type: string; notNull: boolean; def: string; comment: string }
export interface NewIdx { key: string; name: string; cols: string[]; kind: "INDEX" | "UNIQUE" | "FULLTEXT" }
export interface NewFk { key: string; name: string; cols: string[]; refTable: string; refCols: string[]; onDelete: string; onUpdate: string }

export interface Design {
  /** Tên bảng (để đặt tên tự động) + schema (để qualify bảng được tham chiếu). */
  table: string;
  schema: string;
  /** Tên bảng đã quote/qualify, dùng trong ALTER TABLE. */
  ref: string;
  cols: NewCol[];
  idx: NewIdx[];
  fks: NewFk[];
  /** MySQL/MariaDB: đổi thứ tự cột — thứ tự cũ, thứ tự mới, định nghĩa đầy đủ từng cột (dòng trong SHOW CREATE TABLE). */
  order?: { before: string[]; after: string[]; defs: Record<string, string> };
}

export const FK_ACTIONS = ["RESTRICT", "CASCADE", "SET NULL", "NO ACTION", "SET DEFAULT"];

export function quoteId(d: DesignDriver, s: string): string {
  return d === "mysql" ? `\`${s.replace(/`/g, "``")}\`` : `"${s.replace(/"/g, '""')}"`;
}
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Giá trị DEFAULT người dùng gõ: số, NULL, TRUE/FALSE, CURRENT_TIMESTAMP…, biểu thức có ngoặc, hoặc chuỗi đã
 * tự đặt trong nháy → giữ nguyên; còn lại coi là chuỗi và bọc nháy. Rỗng = không có DEFAULT.
 */
export function defaultSql(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  if (/^(null|true|false|current_timestamp|current_date|current_time|now\(\)|localtimestamp)$/i.test(s)) return s.toUpperCase();
  if (/^'.*'$/s.test(s) || s.includes("(")) return s;
  return lit(s);
}

/** Tên tự động khi để trống: `idx_<bảng>_<cột>` / `fk_<bảng>_<bảng đích>` (cắt 64 ký tự — giới hạn MySQL). */
export function autoName(prefix: string, table: string, parts: string[]): string {
  return [prefix, table, ...parts].join("_").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64);
}

/** MySQL/MariaDB: chuỗi `MODIFY COLUMN … AFTER/FIRST` đưa cột về thứ tự mới (chạy lần lượt theo thứ tự mới). */
export function reorderSql(ref: string, before: string[], after: string[], defs: Record<string, string>): string[] {
  const prevOld = new Map(before.map((c, i) => [c, i ? before[i - 1] : null]));
  const out: string[] = [];
  after.forEach((c, i) => {
    const pred = i ? after[i - 1] : null;
    if (prevOld.get(c) === pred || !defs[c]) return;
    out.push(`ALTER TABLE ${ref} MODIFY COLUMN ${defs[c]} ${pred === null ? "FIRST" : `AFTER ${quoteId("mysql", pred)}`};`);
  });
  return out;
}

export function designSql(d: DesignDriver, x: Design): string[] {
  const q = (s: string) => quoteId(d, s);
  const out: string[] = [];
  for (const c of x.cols) {
    if (!c.name.trim() || !c.type.trim()) continue;
    const dv = defaultSql(c.def);
    let line = `ALTER TABLE ${x.ref} ADD COLUMN ${q(c.name.trim())} ${c.type.trim()}`;
    if (c.notNull) line += " NOT NULL";
    if (dv !== null) line += ` DEFAULT ${dv}`;
    if (d === "mysql" && c.comment.trim()) line += ` COMMENT ${lit(c.comment.trim())}`;
    out.push(`${line};`);
    if (d === "postgres" && c.comment.trim()) out.push(`COMMENT ON COLUMN ${x.ref}.${q(c.name.trim())} IS ${lit(c.comment.trim())};`);
  }
  if (d === "mysql" && x.order) out.push(...reorderSql(x.ref, x.order.before, x.order.after, x.order.defs));
  for (const i of x.idx) {
    if (!i.cols.length) continue;
    const name = i.name.trim() || autoName(i.kind === "UNIQUE" ? "uq" : "idx", x.table, i.cols);
    const kind = i.kind === "UNIQUE" ? "UNIQUE " : i.kind === "FULLTEXT" && d === "mysql" ? "FULLTEXT " : "";
    out.push(`CREATE ${kind}INDEX ${q(name)} ON ${x.ref} (${i.cols.map(q).join(", ")});`);
  }
  if (d !== "sqlite") {
    for (const f of x.fks) {
      if (!f.cols.length || !f.refTable || f.refCols.length !== f.cols.length) continue;
      const name = f.name.trim() || autoName("fk", x.table, [f.refTable]);
      const refT = d === "mysql"
        ? (x.schema ? `${q(x.schema)}.${q(f.refTable)}` : q(f.refTable))
        : (x.schema && x.schema !== "public" ? `${q(x.schema)}.${q(f.refTable)}` : q(f.refTable));
      let line = `ALTER TABLE ${x.ref} ADD CONSTRAINT ${q(name)} FOREIGN KEY (${f.cols.map(q).join(", ")}) REFERENCES ${refT} (${f.refCols.map(q).join(", ")})`;
      if (f.onDelete) line += ` ON DELETE ${f.onDelete}`;
      if (f.onUpdate) line += ` ON UPDATE ${f.onUpdate}`;
      out.push(`${line};`);
    }
  }
  return out;
}

/** Lỗi nhập liệu của các dòng mới (để báo trước khi chạy). */
export function designProblems(d: DesignDriver, x: Design): string[] {
  const p: string[] = [];
  x.cols.forEach((c, i) => { if (!c.name.trim() || !c.type.trim()) p.push(`col:${i}`); });
  x.idx.forEach((c, i) => { if (!c.cols.length) p.push(`idx:${i}`); });
  if (d !== "sqlite") x.fks.forEach((f, i) => { if (!f.cols.length || !f.refTable || f.refCols.length !== f.cols.length) p.push(`fk:${i}`); });
  return p;
}
