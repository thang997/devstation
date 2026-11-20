/**
 * Edit table — SỬA mục ĐÃ CÓ (cột / index / khoá ngoại) + danh sách kiểu dữ liệu đầy đủ. Phần THUẦN, có test.
 * Thêm mới nằm ở `tableDesign.ts`.
 */
import { autoName, defaultSql, designSql, quoteId, type Design, type DesignDriver, type NewCol, type NewFk, type NewIdx } from "./tableDesign";

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const norm = (s: string) => s.trim().toLowerCase();

/** Tách token: `ident`, 'chuỗi', (nhóm ngoặc — dính vào từ ngay trước nếu sát nhau), từ thường. */
export function sqlTokens(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "`" || ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "\\" && ch !== "`") { j += 2; continue; }
        if (s[j] === ch) { if (s[j + 1] === ch) { j += 2; continue; } break; }
        j++;
      }
      out.push(s.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (ch === "(") {
      let depth = 0;
      let j = i;
      let q = "";
      for (; j < s.length; j++) {
        const c = s[j];
        if (q) { if (c === "\\") j++; else if (c === q) q = ""; continue; }
        if (c === "'" || c === '"' || c === "`") q = c;
        else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) break;
      }
      const grp = s.slice(i, j + 1);
      if (out.length && i > 0 && !/\s/.test(s[i - 1]) && /^[A-Za-z_]/.test(out[out.length - 1])) out[out.length - 1] += grp;
      else out.push(grp);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/[\s('"`]/.test(s[j])) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

const unq = (t: string) => t.slice(1, -1).replace(/''/g, "'").replace(/\\'/g, "'").replace(/\\\\/g, "\\");
const unBacktick = (t: string) => (t.startsWith("`") ? t.slice(1, -1).replace(/``/g, "`") : t);

/** Một dòng định nghĩa cột trong SHOW CREATE TABLE (MySQL/MariaDB) tách thành phần sửa được + phần giữ nguyên. */
export interface MysqlColParts {
  name: string;
  type: string;
  /** Giữ sau kiểu: CHARACTER SET / COLLATE / GENERATED ALWAYS AS (…) VIRTUAL|STORED. */
  pre: string;
  notNull: boolean;
  /** DEFAULT dạng SQL gốc (`'abc'`, `NULL`, `current_timestamp()`…), rỗng = không có. */
  def: string;
  /** Giữ sau NULL/DEFAULT: AUTO_INCREMENT, ON UPDATE …, INVISIBLE… */
  post: string;
  comment: string;
}

const STOP = /^(NOT|NULL|DEFAULT|COMMENT|AUTO_INCREMENT|ON|CHARACTER|CHARSET|COLLATE|GENERATED|AS|VIRTUAL|STORED|PRIMARY|UNIQUE|KEY|INVISIBLE|VISIBLE|CHECK|COLUMN_FORMAT|STORAGE|SRID|REFERENCES)$/i;

export function parseMysqlColDef(line: string): MysqlColParts {
  const t = sqlTokens(line.trim().replace(/,$/, ""));
  const p: MysqlColParts = { name: unBacktick(t[0] ?? ""), type: "", pre: "", notNull: false, def: "", post: "", comment: "" };
  let i = 1;
  const type: string[] = [];
  while (i < t.length && !STOP.test(t[i])) type.push(t[i++]);
  p.type = type.join(" ");
  const pre: string[] = [];
  const post: string[] = [];
  while (i < t.length) {
    const w = t[i].toUpperCase();
    if (w === "NOT" && t[i + 1]?.toUpperCase() === "NULL") { p.notNull = true; i += 2; continue; }
    if (w === "NULL") { i++; continue; }
    if (w === "DEFAULT") { p.def = t[i + 1] ?? ""; i += 2; continue; }
    if (w === "COMMENT") { p.comment = t[i + 1] ? unq(t[i + 1]) : ""; i += 2; continue; }
    if (w === "CHARACTER" && t[i + 1]?.toUpperCase() === "SET") { pre.push(t[i], t[i + 1], t[i + 2] ?? ""); i += 3; continue; }
    if (w === "CHARSET" || w === "COLLATE") { pre.push(t[i], t[i + 1] ?? ""); i += 2; continue; }
    if (w === "GENERATED" || w === "AS") {
      while (i < t.length && !t[i].startsWith("(")) pre.push(t[i++]);
      if (i < t.length) pre.push(t[i++]);
      if (/^(VIRTUAL|STORED|PERSISTENT)$/i.test(t[i] ?? "")) pre.push(t[i++]);
      continue;
    }
    post.push(t[i++]);
  }
  p.pre = pre.join(" ");
  p.post = post.join(" ");
  return p;
}

/** Cột đang sửa: giá trị mới (như NewCol) + bản gốc để so. `pre`/`post` (MySQL) giữ thuộc tính không hiện trên lưới. */
export interface EditCol extends NewCol {
  orig: { name: string; type: string; notNull: boolean; def: string; comment: string };
  pre?: string;
  post?: string;
}

export function colChanged(e: EditCol): boolean {
  return e.name.trim() !== e.orig.name || norm(e.type) !== norm(e.orig.type) || e.notNull !== e.orig.notNull
    || e.def.trim() !== e.orig.def.trim() || e.comment.trim() !== e.orig.comment.trim();
}

/** Câu sửa một cột đã có. MySQL: một `CHANGE COLUMN` (giữ AUTO_INCREMENT/charset/ON UPDATE… và vị trí cột);
 *  Postgres: từng phần thay đổi; SQLite: chỉ đổi tên. */
export function alterColSql(d: DesignDriver, ref: string, e: EditCol): string[] {
  if (!colChanged(e)) return [];
  const q = (s: string) => quoteId(d, s);
  const name = e.name.trim();
  const type = e.type.trim();
  if (d === "mysql") {
    const typeSame = norm(type) === norm(e.orig.type);
    // Đổi kiểu → bỏ CHARACTER SET/COLLATE cũ (có thể không hợp kiểu mới); GENERATED vẫn giữ.
    const pre = typeSame ? (e.pre ?? "") : (e.pre ?? "").replace(/\b(CHARACTER SET|CHARSET|COLLATE)\s+\S+/gi, "").replace(/\s+/g, " ").trim();
    const dv = defaultSql(e.def);
    let line = `ALTER TABLE ${ref} CHANGE COLUMN ${q(e.orig.name)} ${q(name)} ${type}`;
    if (pre) line += ` ${pre}`;
    line += e.notNull ? " NOT NULL" : " NULL";
    if (dv !== null) line += ` DEFAULT ${dv}`;
    if (e.post) line += ` ${e.post}`;
    if (e.comment.trim()) line += ` COMMENT ${lit(e.comment.trim())}`;
    return [`${line};`];
  }
  const out: string[] = [];
  if (name !== e.orig.name) out.push(`ALTER TABLE ${ref} RENAME COLUMN ${q(e.orig.name)} TO ${q(name)};`);
  if (d === "sqlite") return out;
  const c = q(name);
  if (norm(type) !== norm(e.orig.type)) out.push(`ALTER TABLE ${ref} ALTER COLUMN ${c} TYPE ${type} USING ${c}::${type};`);
  if (e.notNull !== e.orig.notNull) out.push(`ALTER TABLE ${ref} ALTER COLUMN ${c} ${e.notNull ? "SET" : "DROP"} NOT NULL;`);
  if (e.def.trim() !== e.orig.def.trim()) {
    const dv = defaultSql(e.def);
    out.push(dv === null ? `ALTER TABLE ${ref} ALTER COLUMN ${c} DROP DEFAULT;` : `ALTER TABLE ${ref} ALTER COLUMN ${c} SET DEFAULT ${dv};`);
  }
  if (e.comment.trim() !== e.orig.comment.trim()) out.push(`COMMENT ON COLUMN ${ref}.${c} IS ${e.comment.trim() ? lit(e.comment.trim()) : "NULL"};`);
  return out;
}

/** Index đang sửa = xoá cũ + tạo mới. `kind` thêm PRIMARY cho khoá chính MySQL. */
export type IdxKind = NewIdx["kind"] | "PRIMARY";
export interface EditIdx { key: string; name: string; cols: string[]; kind: IdxKind; orig: { name: string; cols: string[]; kind: IdxKind } }
export const idxChanged = (e: EditIdx) =>
  e.name.trim() !== e.orig.name || e.kind !== e.orig.kind || e.cols.join("\u0001") !== e.orig.cols.join("\u0001");

export function alterIdxSql(d: DesignDriver, x: Pick<Design, "ref" | "schema" | "table">, e: EditIdx): string[] {
  if (!idxChanged(e) || !e.cols.length) return [];
  const q = (s: string) => quoteId(d, s);
  const cols = e.cols.map(q).join(", ");
  const name = e.name.trim() || autoName(e.kind === "UNIQUE" ? "uq" : "idx", x.table, e.cols);
  if (d === "mysql") {
    const drop = e.orig.kind === "PRIMARY" ? "DROP PRIMARY KEY" : `DROP INDEX ${q(e.orig.name)}`;
    const add = e.kind === "PRIMARY"
      ? `ADD PRIMARY KEY (${cols})`
      : `ADD ${e.kind === "UNIQUE" ? "UNIQUE " : e.kind === "FULLTEXT" ? "FULLTEXT " : ""}INDEX ${q(name)} (${cols})`;
    return [`ALTER TABLE ${x.ref} ${drop}, ${add};`];
  }
  const sch = d === "postgres" && x.schema && x.schema !== "public" ? `${q(x.schema)}.` : "";
  return [
    `DROP INDEX ${sch}${q(e.orig.name)};`,
    `CREATE ${e.kind === "UNIQUE" ? "UNIQUE " : ""}INDEX ${q(name)} ON ${x.ref} (${cols});`,
  ];
}

/** Khoá ngoại đang sửa = DROP + ADD (hai câu: MySQL không cho xoá rồi thêm FK cùng tên trong một ALTER). */
export interface EditFk extends NewFk { orig: { name: string; cols: string[]; refTable: string; refCols: string[]; onDelete: string; onUpdate: string } }
export const fkChanged = (e: EditFk) => {
  const o = e.orig;
  return e.name.trim() !== o.name || e.refTable !== o.refTable || e.cols.join(",") !== o.cols.join(",")
    || e.refCols.join(",") !== o.refCols.join(",") || norm(e.onDelete) !== norm(o.onDelete) || norm(e.onUpdate) !== norm(o.onUpdate);
};

export function alterFkSql(d: DesignDriver, x: Design, e: EditFk): string[] {
  if (d === "sqlite" || !fkChanged(e)) return [];
  const add = designSql(d, { ...x, cols: [], idx: [], fks: [e], order: undefined });
  if (!add.length) return [];
  const drop = d === "mysql"
    ? `ALTER TABLE ${x.ref} DROP FOREIGN KEY ${quoteId(d, e.orig.name)};`
    : `ALTER TABLE ${x.ref} DROP CONSTRAINT ${quoteId(d, e.orig.name)};`;
  return [drop, ...add];
}

/** Tách danh sách cột `a, "b c", \`d\`` → tên trần. */
export function splitColList(s: string): string[] {
  return s.split(",").map((t) => t.trim()).filter(Boolean).map((t) => (/^["`].*["`]$/.test(t) ? t.slice(1, -1) : t));
}

/** Postgres `pg_indexes.indexdef` / SQLite `sqlite_master.sql` → { unique, cols }; null nếu là index biểu thức. */
export function parseIndexDef(def: string): { unique: boolean; cols: string[] } | null {
  const m = /^CREATE\s+(UNIQUE\s+)?INDEX\b[\s\S]*?\bON\b[^(]*\(([^()]*)\)\s*(WHERE[\s\S]*)?$/i.exec(def.trim());
  if (!m) return null;
  return { unique: !!m[1], cols: splitColList(m[2]).map((c) => c.replace(/\s+(ASC|DESC)$/i, "")) };
}

const RULE = /(SET NULL|SET DEFAULT|NO ACTION|RESTRICT|CASCADE)/i;
/** Postgres `pg_get_constraintdef` của khoá ngoại → các phần. */
export function parsePgFkDef(def: string): { cols: string[]; refTable: string; refCols: string[]; onDelete: string; onUpdate: string } | null {
  const m = /FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]*)\)(.*)$/i.exec(def);
  if (!m) return null;
  const tbl = m[2].split(".").pop()!.replace(/^"|"$/g, "");
  const del = new RegExp(`ON DELETE ${RULE.source}`, "i").exec(m[4])?.[1]?.toUpperCase() ?? "";
  const upd = new RegExp(`ON UPDATE ${RULE.source}`, "i").exec(m[4])?.[1]?.toUpperCase() ?? "";
  return { cols: splitColList(m[1]), refTable: tbl, refCols: splitColList(m[3]), onDelete: del, onUpdate: upd };
}

/** Danh sách kiểu dữ liệu đầy đủ theo driver (như Navicat); `insert` = giá trị điền khi chọn (kèm độ dài mặc định). */
export interface TypeItem { name: string; insert: string }
const mk = (list: string[]): TypeItem[] => list.map((s) => { const [name, insert] = s.split("|"); return { name, insert: insert ?? name }; });
export const TYPE_LIST: Record<DesignDriver, TypeItem[]> = {
  mysql: mk([
    "bigint", "bigint unsigned", "binary|binary(16)", "bit|bit(1)", "blob", "bool", "boolean", "char|char(10)", "char(36)", "date",
    "datetime", "decimal|decimal(10,2)", "double", "enum|enum('a','b')", "float", "geometry", "geometrycollection", "int",
    "int unsigned", "integer", "json", "linestring", "longblob", "longtext", "mediumblob", "mediumint", "mediumtext",
    "multilinestring", "multipoint", "multipolygon", "numeric|numeric(10,2)", "point", "polygon", "real", "set|set('a','b')",
    "smallint", "text", "time", "timestamp", "tinyblob", "tinyint", "tinyint(1)", "tinytext", "varbinary|varbinary(255)",
    "varchar|varchar(255)", "year",
  ]),
  postgres: mk([
    "bigint", "bigint[]", "bigserial", "bit|bit(1)", "bit varying|bit varying(64)", "boolean", "box", "bytea", "char|char(10)",
    "character varying|character varying(255)", "cidr", "circle", "date", "daterange", "decimal|decimal(10,2)",
    "double precision", "inet", "int4range", "int8range", "integer", "integer[]", "interval", "json", "jsonb", "jsonb[]", "line",
    "lseg", "macaddr", "macaddr8", "money", "numeric|numeric(10,2)", "numrange", "path", "pg_lsn", "point", "polygon", "real",
    "serial", "smallint", "smallserial", "text", "text[]", "time", "time with time zone", "timestamp",
    "timestamp with time zone", "timestamptz", "tsquery", "tsrange", "tstzrange", "tsvector", "uuid", "uuid[]",
    "varchar|varchar(255)", "varchar[]", "xml",
  ]),
  sqlite: mk([
    "BIGINT", "BLOB", "BOOLEAN", "CHAR|CHAR(10)", "DATE", "DATETIME", "DECIMAL|DECIMAL(10,2)", "DOUBLE", "FLOAT", "INT",
    "INTEGER", "JSON", "NUMERIC", "REAL", "TEXT", "VARCHAR|VARCHAR(255)",
  ]),
};

/** Lọc kiểu theo chữ gõ: khớp đầu trước, rồi khớp giữa (bỏ phần `(…)` khi so). */
export function filterTypes(list: TypeItem[], text: string): TypeItem[] {
  const s = text.trim().toLowerCase().replace(/\(.*$/, "");
  if (!s) return list;
  const starts = list.filter((t) => t.name.toLowerCase().startsWith(s));
  const has = list.filter((t) => !t.name.toLowerCase().startsWith(s) && t.name.toLowerCase().includes(s));
  return [...starts, ...has];
}
