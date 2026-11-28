/**
 * Gom container Docker theo service (thuần, không phụ thuộc giao diện).
 * Ưu tiên label: Swarm `com.docker.swarm.service.name`, Compose `com.docker.compose.service` (+ project).
 * Không có label (chạy `docker run`) → đoán theo tên: task Swarm `crm.2.<taskid>` → `crm`,
 * kiểu Compose `proj-crm-1` / `proj_crm_2` → `proj-crm` / `proj_crm`.
 */
import type { DockerContainer } from "./api";

export interface DockerGroup {
  /** Khoá nhóm (project + service). */
  key: string;
  /** Tên service hiển thị. */
  service: string;
  /** Compose project (nếu có). */
  project: string;
  items: DockerContainer[];
}

/** Service của một container: label nếu có, không thì đoán theo tên. */
export function serviceOf(c: DockerContainer): { service: string; project: string } {
  if (c.service) return { service: c.service, project: c.project ?? "" };
  const name = c.name || c.id.slice(0, 12);
  const swarm = /^(.+)\.\d+\.[a-z0-9]{20,}$/i.exec(name);
  if (swarm) return { service: swarm[1], project: "" };
  const replica = /^(.+?)[-_]\d+$/.exec(name);
  if (replica) return { service: replica[1], project: "" };
  return { service: name, project: "" };
}

/** Gom theo service, nhóm sắp theo tên service; trong nhóm sắp theo tên container (số thứ tự tự nhiên). */
export function groupByService(list: DockerContainer[]): DockerGroup[] {
  const map = new Map<string, DockerGroup>();
  for (const c of list) {
    const { service, project } = serviceOf(c);
    const key = `${project}\u0000${service}`;
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, service, project, items: [] }));
    g.items.push(c);
  }
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const groups = [...map.values()];
  for (const g of groups) g.items.sort((a, b) => cmp(a.name, b.name));
  return groups.sort((a, b) => cmp(a.service, b.service) || cmp(a.project, b.project));
}

/**
 * Container mồ côi: Swarm đã bỏ task nhưng container vẫn chạy trên node (vd. update xong mà container cũ không dừng).
 * - `swarm`: node là manager, `docker service ps` báo task có trạng thái mong muốn khác Running (Shutdown…) → chắc chắn.
 * - `missing`: manager không còn task này trong service → chắc chắn.
 * - `duplicate`: không hỏi được Swarm (node worker) nhưng có ≥2 container cùng service + slot → các container CŨ hơn
 *   (theo thời điểm tạo) có thể là mồ côi.
 */
export type OrphanReason = "swarm" | "missing" | "duplicate";
export interface Orphan { reason: OrphanReason; detail: string }

export function findOrphans(list: DockerContainer[]): Map<string, Orphan> {
  const out = new Map<string, Orphan>();
  const bySlot = new Map<string, DockerContainer[]>();
  for (const c of list) {
    if (!c.taskId) continue;
    const desired = (c.swarmDesired ?? "").trim();
    if (desired === "missing") {
      out.set(c.id, { reason: "missing", detail: "" });
    } else if (desired && desired.toLowerCase() !== "running") {
      out.set(c.id, { reason: "swarm", detail: [c.swarmCurrent, c.swarmError].filter(Boolean).join(" — ") });
    } else if (!desired && c.slot != null && c.service) {
      const k = `${c.service}\u0000${c.slot}`;
      const arr = bySlot.get(k);
      if (arr) arr.push(c); else bySlot.set(k, [c]);
    }
  }
  for (const arr of bySlot.values()) {
    if (arr.length < 2) continue;
    // Giữ container mới nhất; chuỗi CreatedAt của docker ("2026-11-27 11:06:35 +0700 +07") so theo thứ tự được.
    const newest = arr.reduce((a, b) => ((b.created ?? "") > (a.created ?? "") ? b : a));
    for (const c of arr) if (c !== newest) out.set(c.id, { reason: "duplicate", detail: newest.name });
  }
  return out;
}

/** Container không ở trạng thái chạy khoẻ (unhealthy / restarting / không "Up"). */
export const isUnhealthy = (c: DockerContainer) => {
  const s = c.status.toLowerCase();
  return !s.startsWith("up") || s.includes("unhealthy") || s.includes("restarting");
};
