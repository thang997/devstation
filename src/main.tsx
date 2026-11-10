import React from "react";
import ReactDOM from "react-dom/client";
import { Shell } from "./shell/Shell";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
);
