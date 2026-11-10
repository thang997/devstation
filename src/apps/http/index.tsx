import { useState } from "react";
import type { AppModule, Tab } from "../types";
import { useWorkbench } from "../../store/workbench";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// Dữ liệu mẫu — sẽ thay bằng collections lưu trong SQLite.
const DEMO_COLLECTIONS = [
  {
    name: "HRM API",
    requests: [
      { id: "r1", method: "GET", name: "Danh sách nhân viên", url: "{{baseUrl}}/employees" },
      { id: "r2", method: "POST", name: "Đăng nhập", url: "{{baseUrl}}/auth/login" },
    ],
  },
];

let untitled = 0;
export function newRequest(init?: { method?: string; url?: string; name?: string }) {
  const id = `http:new-${++untitled}`;
  useWorkbench.getState().openTab({
    id,
    appId: "http",
    title: `⚡ ${init?.name ?? "Request mới"}`,
    payload: { method: init?.method ?? "GET", url: init?.url ?? "" },
  });
}

function Sidebar() {
  const open = useWorkbench((s) => s.openTab);
  return (
    <div className="side-list">
      <div className="side-head">
        <span>COLLECTIONS</span>
        <button className="icon-btn" title="Request mới" onClick={() => newRequest()}>＋</button>
      </div>
      {DEMO_COLLECTIONS.map((c) => (
        <div key={c.name}>
          <div className="side-group">📁 {c.name}</div>
          {c.requests.map((r) => (
            <div
              key={r.id}
              className="side-item indent"
              onClick={() =>
                open({ id: `http:${r.id}`, appId: "http", title: `⚡ ${r.name}`, payload: { ...r } })
              }
            >
              <span className={`method m-${r.method}`}>{r.method}</span>
              <span className="grow ellipsis">{r.name}</span>
            </div>
          ))}
        </div>
      ))}
      <div className="side-head"><span>HISTORY</span></div>
      <div className="muted small pad">Chưa có request nào</div>
      <div className="side-head"><span>ENVIRONMENTS</span></div>
      <div className="side-item">dev</div>
      <div className="side-item">staging</div>
      <div className="side-item danger-text">prod</div>
    </div>
  );
}

const REQ_TABS = ["Params", "Headers", "Body", "Auth"] as const;
const RES_TABS = ["Body", "Headers", "Cookies", "Timeline"] as const;

function TabView({ tab }: { tab: Tab }) {
  const log = useWorkbench((s) => s.log);
  const [method, setMethod] = useState(String(tab.payload.method ?? "GET"));
  const [url, setUrl] = useState(String(tab.payload.url ?? ""));
  const [reqTab, setReqTab] = useState<(typeof REQ_TABS)[number]>("Params");
  const [resTab, setResTab] = useState<(typeof RES_TABS)[number]>("Body");

  const send = () => log(`${method} ${url || "(trống)"} — chưa nối backend reqwest`);

  return (
    <div className="view">
      <div className="toolbar">
        <select value={method} onChange={(e) => setMethod(e.target.value)} className={`method-select m-${method}`}>
          {METHODS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <input
          className="grow url"
          value={url}
          placeholder="Nhập URL hoặc dán lệnh curl…"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && send()}
        />
        <select defaultValue="dev"><option>dev</option><option>staging</option><option>prod</option></select>
        <button className="primary" onClick={send}>Send</button>
      </div>
      <div className="pane">
        <div className="subtabs">
          {REQ_TABS.map((t) => (
            <button key={t} className={t === reqTab ? "on" : ""} onClick={() => setReqTab(t)}>{t}</button>
          ))}
        </div>
        <div className="empty">{reqTab}</div>
      </div>
      <div className="pane">
        <div className="subtabs">
          {RES_TABS.map((t) => (
            <button key={t} className={t === resTab ? "on" : ""} onClick={() => setResTab(t)}>{t}</button>
          ))}
          <span className="grow" />
          <span className="muted small">Chưa gửi</span>
        </div>
        <div className="empty">Response {resTab}</div>
      </div>
    </div>
  );
}

const httpApp: AppModule = {
  Sidebar,
  TabView,
  commands: () => [
    { id: "http.new", group: "HTTP", title: "Request mới", run: () => newRequest() },
  ],
};

export default httpApp;
