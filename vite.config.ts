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

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    // Không watch src-tauri: cargo ghi .exe trong target/ làm Windows khoá file → EBUSY.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022" },
});
