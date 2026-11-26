import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * In: vẽ từng trang ra ảnh (150 dpi) vào một khối chỉ hiện khi in (`body.pdf-printing` + @media print trong styles.css)
 * rồi gọi window.print() (WebView2 có hộp thoại in + xem trước). `onProgress(i, n)` báo tiến trình vẽ.
 */
export async function printPdf(pdf: PDFDocumentProxy, onProgress: (i: number, n: number) => void, signal: { cancelled: boolean }) {
  const host = document.createElement("div");
  host.className = "pdf-print-host";
  const urls: string[] = [];
  const cleanup = () => {
    document.body.classList.remove("pdf-printing");
    host.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
  };
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      if (signal.cancelled) { cleanup(); return; }
      onProgress(i, pdf.numPages);
      const page = await pdf.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 150 / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvas, viewport: vp, intent: "print" }).promise;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = document.createElement("img");
      img.src = url;
      // Giữ khổ giấy theo trang (pt → in): trang ngang/dọc lẫn lộn vẫn vừa.
      img.style.width = `${vp1.width / 72}in`;
      await img.decode().catch(() => {});
      const wrap = document.createElement("div");
      wrap.className = "pdf-print-page";
      wrap.append(img);
      host.append(wrap);
      page.cleanup();
    }
    document.body.append(host);
    document.body.classList.add("pdf-printing");
    await new Promise((r) => setTimeout(r, 50));
    window.print();
  } finally {
    // window.print() chặn tới khi đóng hộp thoại in.
    cleanup();
  }
}
