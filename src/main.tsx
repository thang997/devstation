import React from "react";
import ReactDOM from "react-dom/client";
import { Shell } from "./shell/Shell";
import { initTheme } from "./store/theme";
import "./styles.css";

initTheme();

// Tự mở các SSH tunnel được đánh dấu autostart ngay khi chạy app (tải lười, không kéo UI SSH vào bundle chính).
void import("./apps/ssh/tunnels").then((m) => m.startAutostartTunnels()).catch(() => {});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
);

