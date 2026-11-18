/** Tách output `git diff` / `git show` thành từng file + từng dòng có số dòng cũ/mới (thuần, có test). */

export interface DiffLine { k: "add" | "del" | "ctx" | "hunk" | "note"; o?: number; n?: number; t: string }
export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "A" | "M" | "D" | "R" | "C";
  binary: boolean;
  add: number;
  del: number;
  lines: DiffLine[];
}

/** Bỏ nháy + escape kiểu C mà git dùng cho tên file có ký tự đặc biệt ("a/t\303\252n.txt"). */
function unquote(p: string) {
  if (!p.startsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      const nx = inner[i + 1];
      if (/[0-7]/.test(nx)) { bytes.push(parseInt(inner.slice(i + 1, i + 4), 8)); i += 3; continue; }
      const map: Record<string, number> = { n: 10, t: 9, '"': 34, "\\": 92 };
      bytes.push(map[nx] ?? nx.charCodeAt(0));
      i++;
      continue;
    }
    for (const b of new TextEncoder().encode(ch)) bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
const stripAB = (p: string) => unquote(p).replace(/^[ab]\//, "");

/** Tách diff thành phần đầu (trước `diff --git` đầu tiên — vd. thông tin commit) + từng file. */
export function parseDiff(text: string): { head: string[]; files: DiffFile[] } {
  const head: string[] = [];
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let o = 0, n = 0, inHunk = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("diff --git ")) {
      // Tên lấy tạm từ "diff --git a/x b/y"; chính xác hơn sẽ lấy từ ---/+++ / rename to.
      const m = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(l);
      f = { path: m ? stripAB(m[2]) : l.slice(11), status: "M", binary: false, add: 0, del: 0, lines: [] };
      files.push(f);
      inHunk = false;
      continue;
    }
    if (!f) { head.push(l); continue; }
    if (!inHunk) {
      if (l.startsWith("new file mode")) f.status = "A";
      else if (l.startsWith("deleted file mode")) f.status = "D";
      else if (l.startsWith("rename from ")) { f.status = "R"; f.oldPath = unquote(l.slice(12)); }
      else if (l.startsWith("rename to ")) f.path = unquote(l.slice(10));
      else if (l.startsWith("copy from ")) { f.status = "C"; f.oldPath = unquote(l.slice(10)); }
      else if (l.startsWith("copy to ")) f.path = unquote(l.slice(8));
      else if (l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) f.binary = true;
      else if (l.startsWith("--- ")) { if (l.slice(4) === "/dev/null") f.status = "A"; }
      else if (l.startsWith("+++ ")) {
        const p = l.slice(4);
        if (p === "/dev/null") f.status = "D";
        else if (f.status !== "R" && f.status !== "C") f.path = stripAB(p);
      }
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
    if (h) {
      o = +h[1]; n = +h[2]; inHunk = true;
      f.lines.push({ k: "hunk", t: h[3].trim() });
      continue;
    }
    if (!inHunk) continue;
    if (l.startsWith("+")) { f.lines.push({ k: "add", n: n++, t: l.slice(1) }); f.add++; }
    else if (l.startsWith("-")) { f.lines.push({ k: "del", o: o++, t: l.slice(1) }); f.del++; }
    else if (l.startsWith("\\")) f.lines.push({ k: "note", t: l.slice(1).trim() });
    else if (l.startsWith(" ")) f.lines.push({ k: "ctx", o: o++, n: n++, t: l.slice(1) });
    else if (l === "" && i < lines.length - 1) f.lines.push({ k: "ctx", o: o++, n: n++, t: "" });
  }
  return { head, files };
}
