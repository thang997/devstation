# DevStation

Workbench cho lập trình viên trên Windows: **Git · HTTP client (Postman mini) · SSH · Tiện ích** trong một cửa sổ.
Tách ra từ PonTea Toolkit (D:\toolkit) nhưng là repo riêng, không dùng chung code.

Khác PonTea: PonTea là launcher "gọi lên 10 giây rồi đóng"; DevStation là app **mở cả ngày**,
bố cục kiểu IDE (VS Code / Termius). Giao tiếp với người dùng bằng tiếng Việt.

## Stack
- Tauri 2 (Rust) + React 19 + TypeScript + Vite, state bằng Zustand.
- Mọi việc nặng (mạng, git, ssh) chạy phía Rust, UI gọi qua `invoke` + event stream.
- Dự kiến thêm theo giai đoạn: rusqlite (lưu dữ liệu), keyring (mật khẩu/key),
  reqwest (HTTP, không dính CORS), russh + russh-sftp (SSH), xterm.js (terminal),
  git2 cho đọc status/diff/log + gọi `git.exe` cho pull/push/fetch (dùng lại credential của máy),
  Monaco cho diff và body JSON.

## Cấu trúc
- `src/shell/` — khung: activity bar, panel output, status bar, command palette (Ctrl+K).
  `AppHost.tsx` là vỏ của một mini app: tải lười, sidebar + thanh tab riêng, error boundary riêng.
- `src/store/workbench.ts` — state chung: app đang chọn, app đang mount, `apps[id]` (tab + sidebar riêng từng app), log.
- `src/apps/types.ts` — `AppManifest` (nhẹ: id, title, icon, `load()`) và `AppModule` (nặng: Sidebar, TabView, commands).
- `src/apps/registry.ts` — đăng ký app bằng `import()` động → mỗi app một chunk riêng. Thêm app mới = tạo
  `src/apps/<id>/index.tsx` (export default AppModule) + khai báo vào đây. **Không import tĩnh app ở chỗ khác**
  (kể cả app này import app kia) — muốn liên kết giữa app thì đi qua store (`openTab` với `appId` khác).
- `src/apps/{git,http,ssh,tools}/` — mỗi app một thư mục. Hiện git/http/ssh mới là UI với dữ liệu mẫu
  (`DEMO_*`), chưa nối backend; tools (Base64, JSON, JWT) đã chạy thật.
- `src-tauri/src/main.rs` — mới có lệnh mẫu `app_info`.

## Quy ước giao diện
- Mỗi chức năng là một **mini app**: chỉ tải code khi mở lần đầu, có thanh tab + sidebar riêng.
  App đã mở được giữ trong DOM khi chuyển sang app khác; "Đóng app" trong Ctrl+K để giải phóng bộ nhớ.
- Mọi thứ mở ra là một **tab** trong app của nó (repo, request, phiên SSH, tool). Tab giữ trong DOM khi ẩn.
- Host/environment gắn nhãn prod → viền đỏ (`tab.danger`).
- Thao tác nguy hiểm (force push, reset hard, gửi request lên prod) phải xác nhận.
- Lỗi là kết quả bình thường, hiển thị tại chỗ, không popup.
- Phím tắt: Ctrl+1..9 chuyển app, Ctrl+Tab / Ctrl+PageUp/PageDown chuyển tab trong app, Ctrl+K palette,
  Ctrl+B sidebar, Ctrl+` panel, Ctrl+W đóng tab.

## Lộ trình
1. Khung ✅ — còn: workspace (nhiều dự án), lưu SQLite, keyring.
2. HTTP client: reqwest phía Rust, dán curl → tự tách, copy as curl, environment `{{var}}`, history.
3. SSH: russh + xterm.js, kết nối lại khi rớt, snippets; sau đó SFTP, port forward, jump host.
4. Git: đọc (status/diff/log) → ghi (stage/commit/pull/push) → giải conflict.
5. Liên kết giữa các app (response có JWT → mở tool JWT, repo → mở terminal...).

## Lệnh
- `npm run app:dev` — chạy app (Vite port 1430, khác PonTea 1420 nên chạy song song được).
- `npm run build` — typecheck + build frontend.
- `npm run app:build` — build file cài đặt NSIS.
