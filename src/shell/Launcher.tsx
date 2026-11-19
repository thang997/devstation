import { useMemo, useState, useSyncExternalStore } from "react";
import { APPS, appShortcut, loadApp, loadedApp, moveApp, orderedApps, resetAppOrder, subscribeAppOrder } from "../apps/registry";
import type { AppManifest, Command } from "../apps/types";
import { useWorkbench } from "../store/workbench";
import { tIn, useLang, useT, type TKey } from "../store/lang";
import { checkForUpdate, useAppVersion } from "./updater";
import { exportConfig, importConfig } from "./configTransfer";
import { launchApp } from "./windows";

/** Bỏ dấu tiếng Việt để gõ "tien ich" vẫn khớp "Tiện ích". */
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

const matches = (hay: string, words: string[]) => {
  const h = fold(hay);
  return words.every((w) => h.includes(w));
};

/** Chạy xuất/nhập cấu hình, ghi kết quả/lỗi ra panel Output (lỗi hiển thị tại chỗ, không popup). */
async function runTransfer(s: ReturnType<typeof useWorkbench.getState>, job: () => Promise<string | null | false | undefined>) {
  try {
    const msg = await job();
    if (msg) { s.log(msg); if (!useWorkbench.getState().panelOpen) s.togglePanel(); }
  } catch (e) {
    s.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    if (!useWorkbench.getState().panelOpen) s.togglePanel();
  }
}

type Item = { kind: "app"; app: AppManifest } | { kind: "cmd"; cmd: Command };

/**
 * Launcher: danh sách app + ô tìm kiếm.
 * - `inline`: màn hình chính khi chưa vào app nào.
 * - overlay (Ctrl+G) khi đang ở trong app: chọn app khác hoặc chạy lệnh.
 */
export function Launcher({ inline = false }: { inline?: boolean }) {
  const mounted = useWorkbench((s) => s.mounted);
  const activeApp = useWorkbench((s) => s.activeApp);
  const lang = useLang();
  const tr = useT();
  const version = useAppVersion();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const appOrder = useSyncExternalStore(subscribeAppOrder, orderedApps);
  /** Kéo-thả sắp thứ tự app: app đang kéo + hàng đang rê lên (chèn trước hàng đó; null = cuối). */
  const [drag, setDrag] = useState<{ id: AppManifest["id"]; over: AppManifest["id"] | "end" | null } | null>(null);
  const appTitle = (a: AppManifest) => tr(`apps.${a.id}.title` as TKey);
  const appDesc = (a: AppManifest) => tr(`apps.${a.id}.description` as TKey);

  const commands = useMemo<Command[]>(() => {
    const s = useWorkbench.getState();
    const shell: Command[] = [
      { id: "shell.home", group: tr("shell.general"), title: tr("shell.goHome"), run: s.goHome },
      { id: "shell.panel", group: tr("shell.general"), title: tr("shell.toggleOutputPanel"), hint: "Ctrl+`", run: s.togglePanel },
      { id: "shell.update", group: tr("shell.general"), title: tr("shell.checkForUpdates"), run: () => void checkForUpdate(true) },
      { id: "shell.exportConfig", group: tr("shell.general"), title: tr("shell.exportConfigToFile"), run: () => void runTransfer(s, () => exportConfig().then((p) => p && tr("shell.exportedConfig", { p }))) },
      { id: "shell.importConfig", group: tr("shell.general"), title: tr("shell.importConfigFromFile"), run: () => void runTransfer(s, () => importConfig().then(() => null)) },
      { id: "shell.resetAppOrder", group: tr("shell.general"), title: tr("shell.resetAppOrder"), run: resetAppOrder },
      { id: "shell.sidebar", group: tr("shell.general"), title: tr("shell.toggleAppSidebar"), hint: "Ctrl+B", run: s.toggleSidebar },
      ...s.mounted.map((id) => {
        const a = APPS.find((x) => x.id === id)!;
        return {
          id: `shell.unload.${id}`,
          group: tr("shell.general"),
          title: `${tr("shell.closeApp")} ${appTitle(a)} ${tr("shell.freeMemoryCloseAllTabs")}`,
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
    const apps: Item[] = appOrder.filter((a) =>
      matches(`${a.title} ${a.description} ${tIn("vi", `apps.${a.id}.title` as TKey)} ${tIn("vi", `apps.${a.id}.description` as TKey)} ${a.keywords ?? ""}`, words),
    ).map((app) => ({ kind: "app", app }));
    // Chưa gõ gì thì chỉ hiện danh sách app cho gọn.
    if (!words.length) return apps;
    const cmds: Item[] = commands
      .filter((c) => matches(`${c.group} ${c.title}`, words))
      .map((cmd) => ({ kind: "cmd", cmd }));
    return [...apps, ...cmds];
  }, [q, commands, appOrder]);
  const canReorder = !q.trim();

  /** Alt+↑/↓: dời app đang chọn lên/xuống một bậc. */
  const nudge = (dir: -1 | 1) => {
    const it = items[sel];
    if (!canReorder || it?.kind !== "app") return;
    const i = appOrder.findIndex((a) => a.id === it.app.id);
    const j = i + dir;
    if (j < 0 || j >= appOrder.length) return;
    // Xuống: chèn trước app đứng sau app kế tiếp (hoặc về cuối).
    moveApp(it.app.id, dir < 0 ? appOrder[j].id : (appOrder[j + 1]?.id ?? null));
    setSel(j);
  };

  const run = (it: Item | undefined) => {
    if (!it) return;
    const s = useWorkbench.getState();
    if (it.kind === "app") void launchApp(it.app.id);
    else { s.setLauncher(false); it.cmd.run(); }
  };

  const box = (
    <div className={`launcher ${inline ? "inline" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={q}
        placeholder={tr("shell.searchAppsOrCommandsSelectEnter")}
        onChange={(e) => { setQ(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); nudge(e.key === "ArrowUp" ? -1 : 1); }
          else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
          else if (e.key === "Enter") run(items[sel]);
        }}
      />
      <div
        className={`launcher-list ${drag?.over === "end" ? "drop-end" : ""}`}
        onDragOver={(e) => { if (!drag) return; e.preventDefault(); if (drag.over !== "end") setDrag({ ...drag, over: "end" }); }}
        onDrop={(e) => { e.preventDefault(); if (drag) moveApp(drag.id, null); setDrag(null); }}
      >
        {items.map((it, i) =>
          it.kind === "app" ? (
            <div
              key={`app.${it.app.id}`}
              className={`launcher-app ${i === sel ? "on" : ""} ${drag?.id === it.app.id ? "dragging" : ""} ${drag && drag.over === it.app.id && drag.id !== it.app.id ? "drop-before" : ""}`}
              draggable={canReorder}
              title={canReorder ? tr("shell.dragToReorderApps") : undefined}
              onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.app.id); setDrag({ id: it.app.id, over: null }); }}
              onDragOver={(e) => { if (!drag) return; e.preventDefault(); e.stopPropagation(); if (drag.over !== it.app.id) setDrag({ ...drag, over: it.app.id }); }}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (drag && drag.id !== it.app.id) moveApp(drag.id, it.app.id); setDrag(null); }}
              onDragEnd={() => setDrag(null)}
              onMouseEnter={() => { setSel(i); void loadApp(it.app.id).catch(() => {}); }}
              onClick={() => run(it)}
            >
              <span className="launcher-icon">{it.app.iconNode ?? it.app.icon}</span>
              <span className="grow">
                <div>{appTitle(it.app)}</div>
                <div className="muted small">{appDesc(it.app)}</div>
              </span>
              {it.app.id === activeApp ? (
                <span className="badge">{tr("shell.viewing")}</span>
              ) : mounted.includes(it.app.id) ? (
                <span className="badge live">{tr("shell.running")}</span>
              ) : null}
              {mounted.includes(it.app.id) && (
                <button
                  className="launcher-close"
                  title={tr("shell.closeThisAppFreeMemoryClose")}
                  onClick={(e) => { e.stopPropagation(); useWorkbench.getState().unloadApp(it.app.id); }}
                >
                  ×
                </button>
              )}
              {appShortcut(it.app.id) && <kbd>{appShortcut(it.app.id)}</kbd>}
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
        {!items.length && <div className="muted pad">{tr("shell.noMatchingAppsOrCommands")}</div>}
      </div>
    </div>
  );

  if (inline) {
    return (
      <div className="home">
        <h1>DevStation{version && <span className="home-version">v{version}</span>}</h1>
        <p className="muted">{tr("shell.pickAnAppToStartApps")}</p>
        {box}
        <p className="muted small">
          <kbd>Ctrl</kbd>+<kbd>G</kbd> {tr("shell.opensTheAppListAnytime")} · <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> {tr("shell.jumpsStraightToAnApp")}
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
