import { beforeEach, describe, expect, it } from "vitest";
import { useWorkbench } from "./workbench";

const initial = useWorkbench.getState();
const wb = () => useWorkbench.getState();
const tab = (appId: "git" | "http" | "ssh" | "tools", id: string) => ({ id, appId, title: id, payload: {} });

describe("workbench: mini app", () => {
  beforeEach(() => useWorkbench.setState(initial, true));

  it("chuyển app thì mount app đó, giữ app cũ trong DOM", () => {
    wb().switchApp("ssh");
    expect(wb().activeApp).toBe("ssh");
    expect(wb().mounted).toEqual(["git", "ssh"]);
  });

  it("mỗi app có danh sách tab riêng; mở tab tự chuyển sang app của nó", () => {
    wb().openTab(tab("http", "http:1"));
    wb().openTab(tab("git", "git:a"));
    expect(wb().activeApp).toBe("git");
    expect(wb().apps.http.tabs.map((t) => t.id)).toEqual(["http:1"]);
    expect(wb().apps.git.activeTabId).toBe("git:a");
  });

  it("Ctrl+Tab chỉ xoay vòng tab trong app hiện tại", () => {
    wb().openTab(tab("git", "g1"));
    wb().openTab(tab("git", "g2"));
    wb().openTab(tab("http", "h1"));
    wb().switchApp("git");
    wb().cycleTab(1);
    expect(wb().apps.git.activeTabId).toBe("g1");
    expect(wb().apps.http.activeTabId).toBe("h1");
  });

  it("đóng tab đang xem thì chuyển sang tab bên cạnh", () => {
    wb().openTab(tab("git", "g1"));
    wb().openTab(tab("git", "g2"));
    wb().closeTab("g2");
    expect(wb().apps.git.activeTabId).toBe("g1");
  });

  it("đóng app đang xem → quay về app dùng gần nhất, tab của nó bị xoá", () => {
    wb().openTab(tab("http", "h1"));
    wb().openTab(tab("ssh", "s1"));
    wb().unloadApp("ssh");
    expect(wb().activeApp).toBe("http");
    expect(wb().mounted).toEqual(["git", "http"]);
    expect(wb().apps.ssh.tabs).toEqual([]);
  });

  it("bấm lại icon app đang chọn thì gập sidebar của app đó", () => {
    wb().clickApp("git");
    expect(wb().apps.git.sidebarOpen).toBe(false);
    wb().clickApp("http");
    expect(wb().apps.http.sidebarOpen).toBe(true);
  });
});
