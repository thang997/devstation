/**
 * Nạp pdf.js (Apache-2.0) — chỉ khi vào app PDF (chunk riêng của app).
 * Worker + tài nguyên phụ (cmaps / standard_fonts / wasm / iccs) phục vụ ở /pdfjs/… (plugin `pdfjsAssets` trong vite.config.ts).
 * An toàn: PDF là dữ liệu không tin cậy → tắt XFA, KHÔNG bật scripting (không nạp quickjs); pdf.js 6 không còn dùng eval.
 */
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjsLib };
export * as viewerLib from "pdfjs-dist/web/pdf_viewer.mjs";

const asset = (p: string) => new URL(`/pdfjs/${p}/`, location.href).href;

export function loadDocument(data: Uint8Array, password?: string) {
  return pdfjsLib.getDocument({
    data,
    password,
    cMapUrl: asset("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: asset("standard_fonts"),
    wasmUrl: asset("wasm"),
    iccUrl: asset("iccs"),
    enableXfa: false,
  });
}
