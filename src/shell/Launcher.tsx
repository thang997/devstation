import { useMemo, useState } from "react";
import { APPS, appShortcut, loadApp, loadedApp } from "../apps/registry";
import type { AppManifest, Command } from "../apps/types";
import { useWorkbench } from "../store/workbench";
import { useLang, useT } from "../store/lang";
import { checkForUpdate } from "./updater";

/** Bỏ dấu tiếng Việt để gõ "tien ich" vẫn khớp "Tiện ích". */
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

const matches = (hay: string, words: string[]) => {
  const h = fold(hay);
  return words.every((w) => h.includes(w));
};

type Item = { kind: "app"; app: AppManifest } | { kind: "cmd"; cmd: Command };

/**
 * Launcher: danh sách app + ô tìm kiếm.
 * - `inline`: màn hình chính khi chưa vào app nào.
 * - overlay (Ctrl+K) khi đang ở trong app: chọn app khác hoặc chạy lệnh.
 */
export function Launcher({ inline = false }: { inline?: boolean }) {
  const mounted = useWorkbench((s) => s.mounted);
  const activeApp = useWorkbench((s) => s.activeApp);
  const lang = useLang();
  const tr = useT();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const appTitle = (a: AppManifest) => (lang === "vi" && a.titleVi ? a.titleVi : a.title);
  const appDesc = (a: AppManifest) => (lang === "vi" && a.descriptionVi ? a.descriptionVi : a.description);

  const commands = useMemo<Command[]>(() => {
    const s = useWorkbench.getState();
    const shell: Command[] = [
      { id: "shell.home", group: tr("General", "Chung"), title: tr("Go home", "Về màn hình chính"), run: s.goHome },
      { id: "shell.panel", group: tr("General", "Chung"), title: tr("Toggle output panel", "Ẩn/hiện panel output"), hint: "Ctrl+`", run: s.togglePanel },
      { id: "shell.update", group: tr("General", "Chung"), title: tr("Check for updates", "Kiểm tra cập nhật"), run: () => void checkForUpdate(true) },
      { id: "shell.sidebar", group: tr("General", "Chung"), title: tr("Toggle app sidebar", "Ẩn/hiện sidebar của app"), hint: "Ctrl+B", run: s.toggleSidebar },
      ...s.mounted.map((id) => {
        const a = APPS.find((x) => x.id === id)!;
        return {
          id: `shell.unload.${id}`,
          group: tr("General", "Chung"),
          title: `${tr("Close app", "Đóng app")} ${a.icon} ${appTitle(a)} ${tr("(free memory, close all tabs)", "(giải phóng bộ nhớ, đóng mọi tab)")}`,
          run: () => s.unloadApp(id),
        };
      }),
    ];
    // Chỉ app đã tải mới góp lệnh — không tải app nặng chỉ để tìm kiếm.
    return [...APPS.flatMap((a) => loadedApp(a.id)?.commands?.() ?? []), ...shell];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, lang]);

  const items = useMemo<Item[]>(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    const apps: Item[] = APPS.filter((a) =>
      matches(`${a.title} ${a.titleVi ?? ""} ${a.description} ${a.descriptionVi ?? ""} ${a.keywords ?? ""}`, words),
    ).map((app) => ({ kind: "app", app }));
    // Chưa gõ gì thì chỉ hiện danh sách app cho gọn.
    if (!words.length) return apps;
    const cmds: Item[] = commands
      .filter((c) => matches(`${c.group} ${c.title}`, words))
      .map((cmd) => ({ kind: "cmd", cmd }));
    return [...apps, ...cmds];
  }, [q, commands]);

  const run = (it: Item | undefined) => {
    if (!it) return;
    const s = useWorkbench.getState();
    if (it.kind === "app") s.openApp(it.app.id);
    else { s.setLauncher(false); it.cmd.run(); }
  };

  const box = (
    <div className={`launcher ${inline ? "inline" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={q}
        placeholder={tr("Search apps or commands…  (↑↓ select, Enter open)", "Tìm app hoặc lệnh…  (↑↓ chọn, Enter mở)")}
        onChange={(e) => { setQ(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
          else if (e.key === "Enter") run(items[sel]);
        }}
      />
      <div className="launcher-list">
        {items.map((it, i) =>
          it.kind === "app" ? (
            <div
              key={`app.${it.app.id}`}
              className={`launcher-app ${i === sel ? "on" : ""}`}
              onMouseEnter={() => { setSel(i); void loadApp(it.app.id).catch(() => {}); }}
              onClick={() => run(it)}
            >
              <span className="launcher-icon">{it.app.iconNode ?? it.app.icon}</span>
              <span className="grow">
                <div>{appTitle(it.app)}</div>
                <div className="muted small">{appDesc(it.app)}</div>
              </span>
              {it.app.id === activeApp ? (
                <span className="badge">{tr("viewing", "đang xem")}</span>
              ) : mounted.includes(it.app.id) ? (
                <span className="badge live">{tr("running", "đang chạy")}</span>
              ) : null}
              {mounted.includes(it.app.id) && (
                <button
                  className="launcher-close"
                  title={tr("Close this app (free memory, close all tabs)", "Tắt app này (giải phóng bộ nhớ, đóng mọi tab)")}
                  onClick={(e) => { e.stopPropagation(); useWorkbench.getState().unloadApp(it.app.id); }}
                >
                  ×
                </button>
              )}
              <kbd>{appShortcut(it.app.id)}</kbd>
            </div>
          ) : (
            <div
              key={it.cmd.id}
              className={`launcher-cmd ${i === sel ? "on" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(it)}
            >
              <span className="grow">{it.cmd.title}</span>
              {it.cmd.hint && <kbd>{it.cmd.hint}</kbd>}
              <span className="muted small">{it.cmd.group}</span>
            </div>
          ),
        )}
        {!items.length && <div className="muted pad">Không có app hay lệnh nào khớp</div>}
      </div>
    </div>
  );

  if (inline) {
    return (
      <div className="home">
        <h1>DevStation</h1>
        <p className="muted">Chọn một app để bắt đầu — app chỉ được tải khi bạn vào.</p>
        {box}
        <p className="muted small">
          <kbd>Ctrl</kbd>+<kbd>K</kbd> mở danh sách app bất cứ lúc nào · <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> vào thẳng app
        </p>
      </div>
    );
  }
  return (
    <div className="launcher-backdrop" onMouseDown={() => useWorkbench.getState().setLauncher(false)}>
      {box}
    </div>
  );
}
