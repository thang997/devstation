import { describe, expect, it } from "vitest";
import { findOrphans, groupByService, isUnhealthy, serviceOf } from "./dockerGroup";
import type { DockerContainer } from "./api";

const c = (name: string, extra: Partial<DockerContainer> = {}): DockerContainer => ({
  id: name.padEnd(12, "0"), name, image: "img", status: "Up 2 days", ports: "", ...extra,
});

describe("serviceOf", () => {
  it("ưu tiên label", () => {
    expect(serviceOf(c("x", { service: "crm", project: "shop" }))).toEqual({ service: "crm", project: "shop" });
  });
  it("đoán theo tên khi không có label", () => {
    expect(serviceOf(c("crm.2.k3j4h5g6f7d8s9a0q1w2e3r4")).service).toBe("crm");
    expect(serviceOf(c("shop-crm-1")).service).toBe("shop-crm");
    expect(serviceOf(c("shop_crm_12")).service).toBe("shop_crm");
    expect(serviceOf(c("redis")).service).toBe("redis");
  });
});

describe("groupByService", () => {
  it("gom node cùng service, tách project khác nhau", () => {
    const g = groupByService([
      c("crm-2", { service: "crm", project: "a" }),
      c("api-1", { service: "api", project: "a" }),
      c("crm-1", { service: "crm", project: "a" }),
      c("crm-1b", { service: "crm", project: "b" }),
    ]);
    expect(g.map((x) => `${x.project}/${x.service}:${x.items.map((i) => i.name).join(",")}`)).toEqual([
      "a/api:api-1",
      "a/crm:crm-1,crm-2",
      "b/crm:crm-1b",
    ]);
  });
});

describe("findOrphans", () => {
  const app = (slot: number, task: string, created: string, x: Partial<DockerContainer> = {}) =>
    c(`app.${slot}.${task}`, { service: "app", taskId: task, slot, created, ...x });
  it("node manager: theo trạng thái task của Swarm", () => {
    const o = findOrphans([
      app(1, "old", "2026-11-23 10:51:00 +0700", { swarmDesired: "Shutdown", swarmCurrent: "Failed 5 days ago" }),
      app(1, "new", "2026-11-27 11:06:35 +0700", { swarmDesired: "Running" }),
      app(2, "gone", "2026-11-20 08:00:00 +0700", { swarmDesired: "missing" }),
    ]);
    expect([...o.entries()].map(([id, v]) => `${id.replace(/0+$/, "")}:${v.reason}`)).toEqual(["app.1.old:swarm", "app.2.gone:missing"]);
  });
  it("node worker: trùng slot → bản cũ hơn", () => {
    const o = findOrphans([app(1, "old", "2026-11-23 10:51:00 +0700"), app(1, "new", "2026-11-27 11:06:35 +0700"), app(2, "b", "2026-11-23 10:51:00 +0700")]);
    expect([...o.entries()].map(([id, v]) => `${id.replace(/0+$/, "")}:${v.reason}:${v.detail}`)).toEqual(["app.1.old:duplicate:app.1.new"]);
  });
});

it("isUnhealthy", () => {
  expect(isUnhealthy(c("a"))).toBe(false);
  expect(isUnhealthy(c("a", { status: "Up 3 hours (unhealthy)" }))).toBe(true);
  expect(isUnhealthy(c("a", { status: "Restarting (1) 5 seconds ago" }))).toBe(true);
});
