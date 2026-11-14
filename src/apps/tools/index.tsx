import { useState } from "react";
import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";
import { TabbedLayout } from "../../shell/TabbedLayout";
import { t, useT } from "../../store/lang";

type ToolId = "base64-decode" | "base64-encode" | "json" | "jwt";

/** Mỗi tool là hàm thuần: vào chuỗi, ra chuỗi hoặc ném lỗi (lỗi là kết quả bình thường). */
const TOOLS: Record<ToolId, { name: string; run: (s: string) => string }> = {
  "base64-decode": {
    name: "Base64 Decode",
    run: (s) => new TextDecoder().decode(Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0))),
  },
  "base64-encode": {
    name: "Base64 Encode",
    run: (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))),
  },
  json: { name: "JSON Format", run: (s) => JSON.stringify(JSON.parse(s), null, 2) },
  jwt: {
    name: "JWT Decode",
    run: (s) => {
      const parts = s.trim().split(".");
      if (parts.length < 2) throw new Error(t("Token must have at least 2 dot-separated parts", "Token phải có ít nhất 2 phần ngăn bởi dấu chấm"));
      const dec = (p: string) =>
        JSON.parse(TOOLS["base64-decode"].run(p.replace(/-/g, "+").replace(/_/g, "/")));
      const header = dec(parts[0]);
      const payload = dec(parts[1]);
      const exp = typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;
      const status = exp ? (exp.getTime() > Date.now() ? t(`Valid until ${exp.toLocaleString()}`, `Còn hạn đến ${exp.toLocaleString()}`) : t(`EXPIRED since ${exp.toLocaleString()}`, `HẾT HẠN từ ${exp.toLocaleString()}`)) : t("No exp", "Không có exp");
      return `// ${status}\n\n// header\n${JSON.stringify(header, null, 2)}\n\n// payload\n${JSON.stringify(payload, null, 2)}`;
    },
  },
};

export function openTool(id: ToolId, input = "") {
  useWorkbench.getState().openTab({
    id: `tools:${id}`,
    appId: "tools",
    title: `🧰 ${TOOLS[id].name}`,
    payload: { tool: id, input },
  });
}

function Sidebar() {
  const tr = useT();
  return (
    <div className="side-list">
      <div className="side-head"><span>{tr("TOOLS", "TIỆN ÍCH")}</span></div>
      {(Object.keys(TOOLS) as ToolId[]).map((id) => (
        <div key={id} className="side-item" onClick={() => openTool(id)}>{TOOLS[id].name}</div>
      ))}
    </div>
  );
}

function TabView({ tab }: { tab: Tab }) {
  const tr = useT();
  const tool = TOOLS[tab.payload.tool as ToolId];
  const [input, setInput] = useState(String(tab.payload.input ?? ""));
  let output = "";
  let error = "";
  if (input.trim()) {
    try {
      output = tool.run(input);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return (
    <div className="view">
      <div className="split">
        <div className="pane">
          <div className="pane-title">{tr("Input", "Đầu vào")}</div>
          <textarea className="io mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder={tr("Paste here…", "Dán vào đây…")} />
        </div>
        <div className="pane">
          <div className="pane-title">
            {tr("Result", "Kết quả")} <span className="grow" />
            {output && <button onClick={() => navigator.clipboard.writeText(output)}>Copy</button>}
          </div>
          {error ? <div className="error-box">⚠ {error}</div> : <pre className="io mono">{output}</pre>}
        </div>
      </div>
    </div>
  );
}

const toolsApp: AppModule = {
  View: () => <TabbedLayout appId="tools" Sidebar={Sidebar} TabView={TabView} />,
  commands: () =>
    (Object.keys(TOOLS) as ToolId[]).map((id) => ({
      id: `tools.${id}`,
      group: t("Tools", "Tiện ích"),
      title: TOOLS[id].name,
      run: () => openTool(id),
    })),
};

export default toolsApp;
