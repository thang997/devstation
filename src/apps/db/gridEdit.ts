/**
 * Sửa dữ liệu ngay trên bảng kết quả (kiểu Navicat) — phần logic thuần, không phụ thuộc React.
 * Chỉ sửa được khi kết quả đến từ MỘT bảng (SELECT … FROM <bảng> [WHERE/ORDER/LIMIT]) có khoá chính
 * và cột khoá chính có mặt trong kết quả; câu UPDATE dùng giá trị khoá chính GỐC để xác định dòng.
 */

export type GridDriver = "mysql" | "postgres" | "sqlite" | "cassandra";

/** Ô đã sửa: dòng → (cột → giá trị mới; null = NULL). */
export type GridEdits = Map<number, Map<number, string | null>>;

const stripComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(--|#)[^\n]*/g, " ");

const unquote = (s: string) => {
  const t = s.trim();
  if ((t.startsWith("`") && t.endsWith("`")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t;
};

const IDENT = String.raw`(?:\x60[^\x60]+\x60|"[^"]+"|[\w$]+)`;
const STOP = String.raw`(?:where|order|limit|offset|for|fetch|window)\b`;
const FROM_RE = new RegExp(
  String.raw`\bfrom\s+(${IDENT}(?:\s*\.\s*${IDENT})?)(?:\s+(?:as\s+)?(?!${STOP})[\w$]+)?\s*(?:${STOP}|$)`,
  "i",
);

/** Bảng nguồn của một câu SELECT đơn bảng; null nếu không phải (JOIN, UNION, GROUP BY, subquery, nhiều bảng…). */
export function parseSourceTable(sql: string): { schema?: string; table: string } | null {
  const s = stripComments(sql).trim().replace(/;\s*$/, "");
  if (!/^select\b/i.test(s)) return null;
  if (/\b(join|union|intersect|except|group\s+by|having|distinct)\b/i.test(s)) return null;
  if (/\(\s*select\b/i.test(s)) return null;
  const m = FROM_RE.exec(s);
  if (!m) return null;
  const parts = m[1].split(/\s*\.\s*(?=[`"\w$])/).map(unquote);
  return parts.length === 2 ? { schema: parts[0], table: parts[1] } : { table: parts[0] };
}

export function quoteIdent(name: string, driver: GridDriver): string {
  return driver === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}

/** Giá trị → literal SQL. Mọi ô là chuỗi (giao thức text) → luôn bọc nháy; DB tự ép sang kiểu cột. */
export function sqlLiteral(v: string | null, driver: GridDriver): string {
  if (v === null) return "NULL";
  let s = v.replace(/'/g, "''");
  if (driver === "mysql") s = s.replace(/\\/g, "\\\\"); // MySQL coi \ là ký tự thoát trong chuỗi
  return `'${s}'`;
}

/** Giá trị cho cột BIT (MySQL): số → số trần; `b'0101'` / `0x..` giữ nguyên; còn lại bọc nháy như thường. */
export function bitLiteral(v: string | null, driver: GridDriver): string {
  if (v === null) return "NULL";
  const s = v.trim();
  if (/^\d+$/.test(s) || /^b'[01]*'$/i.test(s) || /^0x[0-9a-f]+$/i.test(s)) return s;
  return sqlLiteral(v, driver);
}

/**
 * Sinh câu UPDATE cho từng dòng có ô sửa. `rows` là dữ liệu GỐC (chưa sửa) → WHERE theo khoá chính gốc,
 * nên sửa cả cột khoá chính vẫn đúng dòng.
 */
export function buildUpdates(opts: {
  driver: GridDriver;
  tableRef: string;
  columns: string[];
  rows: (string | null)[][];
  edits: GridEdits;
  pkCols: string[];
  /** MySQL: chỉ số cột kiểu BIT — ghi bằng số trần (`'1'` vào cột BIT là chuỗi nhị phân 0x31 → lỗi). */
  bitCols?: number[];
}): { row: number; sql: string }[] {
  const { driver, tableRef, columns, rows, edits, pkCols } = opts;
  const bits = new Set(opts.bitCols ?? []);
  const lit = (c: number, v: string | null) => (bits.has(c) ? bitLiteral(v, driver) : sqlLiteral(v, driver));
  const out: { row: number; sql: string }[] = [];
  const rowIdxs = [...edits.keys()].sort((a, b) => a - b);
  for (const r of rowIdxs) {
    const cells = edits.get(r);
    if (!cells || !cells.size) continue;
    const set = [...cells.entries()]
      .sort(([a], [b]) => a - b)
      .map(([c, v]) => `${quoteIdent(columns[c], driver)} = ${lit(c, v)}`);
    const where = pkCols.map((pk) => {
      const c = columns.indexOf(pk);
      const v = rows[r][c];
      return v === null ? `${quoteIdent(pk, driver)} IS NULL` : `${quoteIdent(pk, driver)} = ${lit(c, v)}`;
    });
    out.push({ row: r, sql: `UPDATE ${tableRef} SET ${set.join(", ")} WHERE ${where.join(" AND ")};` });
  }
  return out;
}

/* ── Phân trang phía server ─────────────────────────────────────────────── */

/** Bỏ comment + dấu ; cuối để phân tích/ghép LIMIT. */
export const stripSql = (sql: string) => stripComments(sql).trim().replace(/;\s*$/, "").trim();

/**
 * Câu SELECT phân trang được: SELECT/WITH … chưa tự có LIMIT/OFFSET/FETCH, không SELECT … INTO / FOR UPDATE.
 * (Có chữ "limit" trong chuỗi cũng coi như đã có LIMIT → không phân trang; an toàn hơn là ghép sai.)
 */
export function isPageable(sql: string, driver: GridDriver): boolean {
  if (driver === "cassandra") return false; // CQL không có OFFSET
  const s = stripSql(sql);
  if (!/^(select|with)\b/i.test(s)) return false;
  if (/\b(limit|offset|fetch\s+(first|next)|into|for\s+(update|share)|lock\s+in\s+share\s+mode)\b/i.test(s)) return false;
  return !s.includes(";"); // nhiều câu dính nhau → bỏ
}

/** Sắp xếp theo cột của LƯỚI KẾT QUẢ (chỉ số cột từ 0). */
export interface GridSort { col: number; desc: boolean }

/**
 * Thêm ORDER BY theo cột thứ `col` của kết quả. Dùng SỐ THỨ TỰ cột (`ORDER BY 3`) — không phải quote tên,
 * chạy được cả khi cột là biểu thức/alias, MySQL/MariaDB/Postgres/SQLite đều hiểu.
 * Câu gốc đã có ORDER BY (ở đâu đó) → bọc thành bảng con rồi sắp lại, tránh hai mệnh đề ORDER BY.
 */
export function orderedSql(sql: string, sort?: GridSort | null): string {
  const s = stripSql(sql);
  if (!sort) return s;
  const by = `ORDER BY ${sort.col + 1} ${sort.desc ? "DESC" : "ASC"}`;
  return /\border\s+by\b/i.test(s) ? `SELECT * FROM (${s}) AS ds_sort ${by}` : `${s} ${by}`;
}

/** Câu lấy một trang: lấy dư 1 dòng để biết còn trang sau. */
export const pagedSql = (sql: string, size: number, offset: number, sort?: GridSort | null) =>
  `${orderedSql(sql, sort)} LIMIT ${size + 1} OFFSET ${offset}`;

/** Sắp xếp phía UI (kết quả không phân trang): số so theo giá trị số, NULL luôn đứng đầu khi tăng dần. */
export function sortRows(rows: (string | null)[][], sort: GridSort): (string | null)[][] {
  const num = (v: string) => (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim()) ? Number(v) : NaN);
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const dir = sort.desc ? -1 : 1;
  return rows.map((r, i) => ({ r, i })).sort((a, b) => {
    const x = a.r[sort.col], y = b.r[sort.col];
    let c: number;
    if (x === null || y === null) c = x === y ? 0 : x === null ? -1 : 1;
    else {
      const nx = num(x), ny = num(y);
      c = !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : coll.compare(x, y);
    }
    return c * dir || a.i - b.i;
  }).map((e) => e.r);
}

/** Đếm tổng số dòng của câu SELECT gốc. */
export const countSql = (sql: string) => `SELECT COUNT(*) FROM (${stripSql(sql)}) AS ds_count`;
