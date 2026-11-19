import React from "react";
import ReactDOM from "react-dom/client";
import { Shell } from "./shell/Shell";
import { initTheme } from "./store/theme";
import { loadLang } from "./store/lang";
import { useWorkbench } from "./store/workbench";
import { unregisterOnClose, windowAppParam } from "./shell/windows";
import "./styles.css";

initTheme();
unregisterOnClose();

// Thả file ra ngoài vùng nhận (vd. sidebar HTTP) → chặn WebView mở/điều hướng tới file thay cho app.
for (const ev of ["dragover", "drop"] as const) {
  window.addEventListener(ev, (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
}

// Cửa sổ mở riêng cho một app (index.html?app=<id>) → vào thẳng app đó, không qua màn hình chính.
if (windowAppParam) useWorkbench.getState().openApp(windowAppParam);


// Nạp file ngôn ngữ đã chọn trước lần vẽ đầu (en có sẵn trong bundle → không chờ).
void loadLang().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Shell />
    </React.StrictMode>,
  );
});
