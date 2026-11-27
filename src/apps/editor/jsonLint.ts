/**
 * Dò lỗi JSON CHÍNH XÁC để báo dễ hiểu + đặt con trỏ đúng chỗ cần sửa (chỉ chạy khi JSON.parse đã báo lỗi —
 * thông báo của trình duyệt khó hiểu và vị trí là token SAU chỗ thiếu, vd. thiếu dấu phẩy thì trỏ vào phần tử kế).
 * Không đệ quy (ngăn xếp tự quản) → file lồng rất sâu không tràn stack. Thuần, không phụ thuộc giao diện.
 */

export type JsonErrKind =
  | "missingComma"      // thiếu "," giữa hai phần tử / thuộc tính
  | "missingColon"      // thiếu ":" sau tên thuộc tính
  | "trailingComma"     // "," thừa ngay trước ] hoặc }
  | "unquotedKey"       // tên thuộc tính không có nháy kép
  | "singleQuote"       // dùng nháy đơn thay vì nháy kép
  | "unterminatedString"
  | "badEscape"
  | "controlChar"       // xuống dòng / tab thô trong chuỗi
  | "badNumber"
  | "badLiteral"        // giá trị không hợp lệ (vd. True, undefined, chữ trần)
  | "unexpectedClose"   // ] / } không khớp
  | "unexpectedEnd"     // hết file khi còn mở { [ "
  | "extraAfterEnd"     // còn ký tự sau giá trị gốc
  | "empty";

export interface JsonErr {
  kind: JsonErrKind;
  /** Vị trí đặt con trỏ khi nhảy tới (thiếu dấu → chỗ cần gõ dấu). */
  caret: number;
  /** Đoạn gạch chân / bôi đen. */
  from: number;
  to: number;
  /** Ký tự đóng đang chờ (cho thông báo "thiếu ] / }"). */
  expect?: "]" | "}";
  line: number;
  col: number;
}

const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

export function lintJson(text: string): JsonErr | null {
  const n = text.length;
  let i = 0;
  const err = (kind: JsonErrKind, caret: number, from = caret, to = Math.min(n, from + 1), expect?: "]" | "}"): JsonErr => {
    let line = 1, col = 1;
    for (let k = 0; k < caret && k < n; k++) {
      if (text.charCodeAt(k) === 10) { line++; col = 1; } else col++;
    }
    return { kind, caret, from, to: Math.max(to, from), expect, line, col };
  };
  const skipWs = () => { while (i < n && isWs(text.charCodeAt(i))) i++; };
  /** Vị trí ngay sau ký tự không phải khoảng trắng cuối cùng trước `p` (chỗ cần chèn dấu thiếu). */
  const afterPrev = (p: number) => { let k = p; while (k > 0 && isWs(text.charCodeAt(k - 1))) k--; return k; };
  /** Hết một "từ" trần (để gạch chân cả token sai). */
  const wordEnd = (p: number) => { let k = p; while (k < n && /[A-Za-z0-9_$.+\-]/.test(text[k])) k++; return Math.max(k, p + 1); };

  /** Đọc chuỗi bắt đầu ở `i` (text[i] === '"'). Trả lỗi hoặc null. */
  const readString = (): JsonErr | null => {
    const start = i;
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) { i++; return null; }
      if (c === 92) {
        const e = text[i + 1];
        if (e === undefined) return err("unterminatedString", n, start, n);
        if ('"\\/bfnrt'.includes(e)) { i += 2; continue; }
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) return err("badEscape", i, i, Math.min(n, i + 6));
          i += 6; continue;
        }
        return err("badEscape", i, i, i + 2);
      }
      if (c === 10 || c === 13) return err("unterminatedString", i, start, i);
      if (c < 32) return err("controlChar", i, i, i + 1);
      i++;
    }
    return err("unterminatedString", n, start, n);
  };

  /** Đọc một giá trị KHÔNG phải object/array (chuỗi, số, true/false/null). */
  const readScalar = (): JsonErr | null => {
    const c = text[i];
    if (c === '"') return readString();
    if (c === "'") return err("singleQuote", i, i, i + 1);
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
      if (!m || m[0] === "-") return err("badNumber", i, i, wordEnd(i));
      const end = i + m[0].length;
      // "01", "1.", "1e" … → dính thêm ký tự số/chữ ngay sau là số sai
      if (end < n && /[0-9A-Za-z.]/.test(text[end])) return err("badNumber", i, i, wordEnd(i));
      i = end;
      return null;
    }
    for (const lit of ["true", "false", "null"]) {
      if (text.startsWith(lit, i) && !(i + lit.length < n && /[A-Za-z0-9_]/.test(text[i + lit.length]))) { i += lit.length; return null; }
    }
    return err("badLiteral", i, i, wordEnd(i));
  };

  // Ngăn xếp: mỗi tầng là object ("}") hoặc array ("]"), `state` = đang chờ gì.
  type Frame = { close: "]" | "}"; open: number; state: "first" | "value" | "afterValue" | "key" | "colon" };
  const stack: Frame[] = [];

  skipWs();
  if (i >= n) return err("empty", 0, 0, 0);

  // Đọc giá trị (mở tầng mới nếu là { / [).
  const startValue = (): JsonErr | null => {
    const c = text[i];
    if (c === "{") { stack.push({ close: "}", open: i, state: "first" }); i++; return null; }
    if (c === "[") { stack.push({ close: "]", open: i, state: "first" }); i++; return null; }
    if (c === "]" || c === "}") return err("unexpectedClose", i, i, i + 1);
    return readScalar();
  };

  let e = startValue();
  if (e) return e;
  for (;;) {
    skipWs();
    const top = stack[stack.length - 1];
    if (!top) {
      // Xong giá trị gốc.
      if (i < n) return err("extraAfterEnd", i, i, n);
      return null;
    }
    if (i >= n) return err("unexpectedEnd", n, top.open, top.open + 1, top.close);
    const c = text[i];
    if (top.close === "]") {
      if (top.state === "first") {
        if (c === "]") { stack.pop(); i++; continue; }
        top.state = "afterValue";
        if ((e = startValue())) return e;
        continue;
      }
      if (top.state === "afterValue") {
        if (c === ",") {
          const comma = i; i++; skipWs();
          if (text[i] === "]") return err("trailingComma", comma, comma, comma + 1);
          if (i >= n) return err("unexpectedEnd", n, top.open, top.open + 1, "]");
          if ((e = startValue())) return e;
          continue;
        }
        if (c === "]") { stack.pop(); i++; continue; }
        if (c === "}") return err("unexpectedClose", i, i, i + 1, "]");
        // Có giá trị mới mà thiếu dấu phẩy → con trỏ ngay sau phần tử trước.
        const at = afterPrev(i);
        return err("missingComma", at, i, wordEnd(i));
      }
    } else {
      // object
      if (top.state === "first" || top.state === "key") {
        if (c === "}" && top.state === "first") { stack.pop(); i++; continue; }
        if (c === '"') {
          if ((e = readString())) return e;
          top.state = "colon";
          continue;
        }
        if (c === "'") return err("singleQuote", i, i, i + 1);
        if (c === "}") return err("trailingComma", afterPrev(i) - 1, afterPrev(i) - 1, afterPrev(i));
        return err("unquotedKey", i, i, wordEnd(i));
      }
      if (top.state === "colon") {
        if (c !== ":") return err("missingColon", afterPrev(i), i, wordEnd(i));
        i++; skipWs();
        if (i >= n) return err("unexpectedEnd", n, top.open, top.open + 1, "}");
        top.state = "afterValue";
        if ((e = startValue())) return e;
        continue;
      }
      if (top.state === "afterValue") {
        if (c === ",") {
          const comma = i; i++; skipWs();
          if (text[i] === "}") return err("trailingComma", comma, comma, comma + 1);
          top.state = "key";
          continue;
        }
        if (c === "}") { stack.pop(); i++; continue; }
        if (c === "]") return err("unexpectedClose", i, i, i + 1, "}");
        const at = afterPrev(i);
        return err("missingComma", at, i, wordEnd(i));
      }
    }
  }
}
