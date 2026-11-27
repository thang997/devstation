import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * App PDF: pdf.js cần cmaps (font CJK/CID), standard_fonts (14 font chuẩn không nhúng), wasm (giải mã JPEG2000/JBIG2,
 * màu ICC) + iccs → dev: phục vụ thẳng từ node_modules ở /pdfjs/…; build: chép vào dist/pdfjs/…
 * Bỏ quickjs (chạy JavaScript trong PDF — app không bật scripting).
 */
function pdfjsAssets(): Plugin {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "node_modules/pdfjs-dist");
  const dirs = ["cmaps", "standard_fonts", "wasm", "iccs"];
  const skip = (f: string) => f.startsWith("quickjs");
  const mime = (p: string) => (p.endsWith(".wasm") ? "application/wasm" : p.endsWith(".js") ? "text/javascript" : "application/octet-stream");
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]);
        const p = join(root, rel);
        if (!p.startsWith(root + sep) || !existsSync(p) || statSync(p).isDirectory() || skip(p.split(sep).pop() ?? "")) return next();
        res.setHeader("Content-Type", mime(p));
        createReadStream(p).pipe(res);
      });
    },
    generateBundle() {
      for (const d of dirs) {
        const dir = join(root, d);
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
          if (skip(f) || statSync(join(dir, f)).isDirectory()) continue;
          this.emitFile({ type: "asset", fileName: `pdfjs/${d}/${f}`, source: readFileSync(join(dir, f)) });
        }
      }
    },
  };
}

/**
 * CSS của pdf.js (`pdf_viewer.css`) có quy tắc class chung chung (`.sidebar` bo góc + đổ bóng, `.hidden`, `.error`,
 * `.selected`, `.title`, `.dialog`, `.loading`…) trùng class của app → nạp vào là sidebar mọi app thành khung nổi bo góc.
 * Bọc mọi quy tắc trong `@scope (.pdf-scroll)` (khung xem PDF) để chỉ áp bên trong viewer; khối `:root` (biến CSS) và
 * at-rule khai báo (`@font-face`, `@keyframes`, `@property`, `@import`) giữ ở ngoài.
 */
function scopePdfjsCss(): Plugin {
  const keepGlobal = (head: string) => /^(:root\b|@font-face|@keyframes|@property|@import|@charset|@layer\s+[^{]*;)/.test(head);
  return {
    name: "scope-pdfjs-css",
    enforce: "pre",
    transform(code, id) {
      if (!/pdfjs-dist[\\/]web[\\/]pdf_viewer\.css/.test(id.split("?")[0])) return null;
      const global: string[] = [];
      const scoped: string[] = [];
      let i = 0;
      while (i < code.length) {
        // Bỏ khoảng trắng / comment ở cấp ngoài cùng.
        if (/\s/.test(code[i])) { i++; continue; }
        if (code.startsWith("/*", i)) { const e = code.indexOf("*/", i + 2); i = e < 0 ? code.length : e + 2; continue; }
        // Một câu lệnh cấp ngoài: tới `;` (at-rule không có khối) hoặc tới `}` đóng khối khớp.
        let j = i, depth = 0, quote = "";
        for (; j < code.length; j++) {
          const c = code[j];
          if (quote) { if (c === "\\") j++; else if (c === quote) quote = ""; continue; }
          if (c === '"' || c === "'") { quote = c; continue; }
          if (code.startsWith("/*", j)) { const e = code.indexOf("*/", j + 2); j = e < 0 ? code.length : e + 1; continue; }
          if (c === "{") depth++;
          else if (c === "}") { depth--; if (depth === 0) { j++; break; } }
          else if (c === ";" && depth === 0) { j++; break; }
        }
        const stmt = code.slice(i, j);
        (keepGlobal(stmt.trimStart()) ? global : scoped).push(stmt);
        i = j;
      }
      return { code: `${global.join("\n")}\n@scope (.pdf-scroll) {\n${scoped.join("\n")}\n}\n`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets(), scopePdfjsCss()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    // Không watch src-tauri: cargo ghi .exe trong target/ làm Windows khoá file → EBUSY.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022" },
});
