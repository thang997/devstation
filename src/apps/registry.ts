import type { AppId, AppModule } from "./types";
import { gitApp } from "./git";
import { httpApp } from "./http";
import { sshApp } from "./ssh";
import { toolsApp } from "./tools";

/** Thứ tự ở đây = thứ tự icon trên activity bar. Thêm app mới chỉ cần đăng ký vào đây. */
export const APPS: AppModule[] = [gitApp, httpApp, sshApp, toolsApp];

export const appById = (id: AppId) => APPS.find((a) => a.id === id)!;
