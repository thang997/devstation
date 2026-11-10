import { useMemo, useState } from "react";
import { APPS } from "../apps/registry";
import type { Command } from "../apps/types";
import { useWorkbench } from "../store/workbench";

/** Ctrl+K: gom lệnh của mọi app + lệnh của shell, lọc theo từ gõ vào. */
export function CommandPalette() {
  const wb = useWorkbench();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  const all = useMemo<Command[]>(() => {
    const shell: Command[] = [
      { id: "shell.sidebar", group: "Giao diện", title: "Ẩn/hiện sidebar", run: wb.toggleSidebar },
      { id: "shell.panel", group: "Giao diện", title: "Ẩn/hiện panel output", run: wb.togglePanel },
      ...APPS.map((a) => ({
        id: `shell.app.${a.id}`,
        group: "Giao diện",
        title: `Chuyển sang ${a.title}`,
        run: () => wb.setActiveApp(a.id),
      })),
    ];
    return [...APPS.flatMap((a) => a.commands?.() ?? []), ...shell];
  }, []);

  const items = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((c) => {
      const hay = `${c.group} ${c.title}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [q, all]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    wb.setPalette(false);
    c.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={() => wb.setPalette(false)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          placeholder="Gõ tên repo, request, host hoặc lệnh…"
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === "Enter") run(items[sel]);
          }}
        />
        <div className="palette-list">
          {items.map((c, i) => (
            <div
              key={c.id}
              className={`palette-item ${i === sel ? "on" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(c)}
            >
              <span className="grow">{c.title}</span>
              <span className="muted small">{c.group}</span>
            </div>
          ))}
          {!items.length && <div className="muted pad">Không có lệnh nào khớp</div>}
        </div>
      </div>
    </div>
  );
}
