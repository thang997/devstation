# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Chủ yếu là chính tác giả: một developer / DevOps làm việc trên Windows, mở DevStation cả ngày bên cạnh editor. Quen thuật ngữ kỹ thuật (git, SSH tunnel, SQL, Redis, Docker registry), làm việc với nhiều server và môi trường (DEV / STAGING / PROD) cùng lúc, ưu tiên tốc độ và mật độ thông tin hơn là hướng dẫn.

## Product Purpose

Gom các công cụ hằng ngày của developer vào một workbench mã nguồn đóng: Git (kiểu GitHub Desktop), HTTP client (Postman mini), SSH (terminal + tunnel + SFTP + Docker, kiểu MobaXterm), Database (MySQL/Postgres/SQLite/Cassandra, kiểu Navicat), Redis, Registry (Harbor), Tools (Base64/JSON/JWT/CSR…), Web Translate. Thành công = thay được việc mở 6–8 ứng dụng riêng lẻ, thao tác nhanh, không sợ thao tác nhầm trên PROD.

## Positioning

Một bộ công cụ do một người tự xây cho chính quy trình của mình: mỗi app là một cửa sổ Windows riêng (Alt+Tab giữa các app), dùng lại cấu hình của máy (git.exe, ssh.exe, keyring) nên kết quả giống hệt terminal, và mọi thao tác nguy hiểm trên PROD đều được nhận diện và hỏi lại.

## Operating Context

- Mở cả ngày, nhiều giờ liền; chuyển qua lại giữa các app bằng Alt+Tab, Ctrl+G (launcher), Ctrl+1..9.
- Làm song song nhiều kết nối/phiên (tab) trong mỗi app; dữ liệu lớn (bảng kết quả hàng nghìn dòng, log, cây key).
- Môi trường DEV / STAGING / PROD trộn lẫn trong cùng danh sách — phân biệt PROD là việc an toàn, không phải trang trí.
- Dùng chuột lẫn bàn phím (đã có điều hướng ↑/↓/Enter/F2/Delete, menu và dropdown dùng phím).

## Capabilities and Constraints

- Tauri 2 (WebView2 trên Windows) + React 19 + TypeScript; mỗi app là một chunk tải lười và một cửa sổ riêng.
- **Bắt buộc giữ:** nền tối là mặc định, vẫn có theme sáng; mỗi app một cửa sổ.
- Chỉ dùng thư viện MIT/Apache/BSD/ISC (icon: lucide-react). Chuỗi giao diện EN/VI qua file locale; thuật ngữ kỹ thuật giữ tiếng Anh.
- Hiệu năng render là ràng buộc cứng: danh sách lớn dùng hàng memo, lưới kết quả ảo hoá; giao diện mới không được làm chậm thao tác.
- Không đổi bố cục khi đổi giá trị (nút giữ bề rộng, số tabular).

## Brand Commitments

- Tên: DevStation. Icon app vẽ bằng code (scripts/make-icons.mjs); mỗi app có icon lucide + màu riêng.
- Người dùng đã từ chối rõ: trang trí, gradient, thẻ (card) kiểu landing page; giao diện trông như template SaaS; bất cứ thứ gì làm chậm thao tác (thêm bước, animation dài, chữ quá to).

## Evidence on Hand

- Mã nguồn giao diện hiện tại: `src/styles.css` (token màu theo `:root[data-theme]`), `src/shell/*`, `src/apps/*`.
- Quy ước giao diện chi tiết trong `CLAUDE.md` (mục "Quy ước giao diện").
- Không có ảnh chụp màn hình / golden nào được commit.

## Product Principles

1. Tốc độ thao tác trước, hình thức sau: mọi thay đổi giao diện phải giữ hoặc giảm số bước.
2. PROD phải nhận ra được ngay, ở mọi nơi nó xuất hiện.
3. Mật độ thông tin cao nhưng đọc được trong nhiều giờ liền.
4. Nhất quán giữa các app: cùng một hành động có cùng hình dạng, phím và vị trí.
5. Lỗi là kết quả bình thường, hiện tại chỗ, không popup.

## Accessibility & Inclusion

Điều hướng bàn phím đầy đủ và vòng focus khi dùng phím (đã có); độ tương phản chữ đủ đọc trong phiên làm việc dài ở cả hai theme.
