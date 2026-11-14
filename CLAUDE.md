# DevStation

Workbench cho lập trình viên trên Windows: **Git · HTTP client (Postman mini) · SSH · Tiện ích** trong một cửa sổ.
**Mã nguồn đóng** (xem LICENSE) — chỉ dùng thư viện giấy phép MIT/Apache/BSD; tránh GPL/AGPL.
Tách ra từ PonTea Toolkit (D:\toolkit) nhưng là repo riêng, không dùng chung code.

Khác PonTea: PonTea là launcher "gọi lên 10 giây rồi đóng"; DevStation là app **mở cả ngày**,
bố cục kiểu IDE (VS Code / Termius). Giao tiếp với người dùng bằng tiếng Việt.

## Stack
- Tauri 2 (Rust) + React 19 + TypeScript + Vite, state bằng Zustand.
- Mọi việc nặng (mạng, git, ssh) chạy phía Rust, UI gọi qua `invoke` + event stream.
- Đã có: Git gọi thẳng `git.exe` cho MỌI thao tác (không dùng libgit2 — dùng lại config/hook/credential/autocrlf
  của máy, kết quả giống hệt terminal); tauri-plugin-dialog (chọn thư mục); sqlx 0.8 (postgres, mysql, sqlite; rustls) cho app Database;
  reqwest 0.12 (rustls) cho HTTP client, chạy phía Rust nên không dính CORS;
  SSH gọi ssh.exe trong ConPTY (portable-pty) + xterm.js cho terminal, tunnel bằng ssh -L/-R/-D.
- Dự kiến thêm theo giai đoạn: rusqlite (lưu dữ liệu), keyring (mật khẩu/key),
  SFTP (russh-sftp hoặc scp/sftp.exe), Monaco cho diff và body JSON.

## Cấu trúc
- `src/shell/` — khung, **không có thanh chọn app cố định**:
  - `Shell.tsx` — phím tắt toàn cục, chứa các app đang chạy, panel output, status bar.
  - `Launcher.tsx` — danh sách app + tìm kiếm (bỏ dấu tiếng Việt). Là màn hình chính khi chưa vào app,
    và overlay khi nhấn Ctrl+K trong app. Gõ chữ thì hiện thêm lệnh của các app đã tải.
  - `AppHost.tsx` — vỏ một mini app: tải lười (`use(loadApp)`), error boundary riêng, chiếm toàn cửa sổ.
  - `TabbedLayout.tsx` — bố cục dựng sẵn (sidebar tuỳ chọn + thanh tab) để app dùng nếu muốn.
- `src/store/workbench.ts` — state chung: `activeApp` (null = màn hình chính), `mounted`, `apps[id]`
  (tab + sidebar riêng từng app), log.
- `src/apps/types.ts` — `AppManifest` (nhẹ: id, title, icon, mô tả, từ khoá, `load()`) và
  `AppModule` (nặng: `View` chiếm toàn vùng làm việc, `commands`).
- `src/apps/registry.ts` — khai báo app bằng `import()` động → mỗi app một chunk riêng, chỉ tải khi vào.
  Thêm app = tạo `src/apps/<id>/index.tsx` (export default AppModule) + khai báo vào đây.
  **Không import tĩnh app ở chỗ khác** (kể cả app này import app kia) — liên kết giữa app đi qua store
  (`openTab` với `appId` khác).
- `src/apps/git/` — chạy thật (`src-tauri/src/git.rs`): status/diff/stage/discard/commit, bỏ commit chưa push (reset --soft), nhánh, stash,
  **Danh sách Thay đổi kiểu GitHub Desktop**: một danh sách có **ô tick từng file** (mặc định tick hết; `unchecked` lưu file bị bỏ tick),
  ô tick "chọn tất cả" ở header (tri-state). Commit chỉ gồm file đã tick (lúc commit mới stage file tick + unstage file bỏ tick).
  Diff file xem gộp cả staged lẫn chưa staged so với HEAD (`git_file_diff`). Header có **Bỏ tất cả** (`git_discard_all`: reset --hard + clean) và **Stash tất cả**.
  clone (có tiến trình), tài khoản Git: danh tính global + **đăng nhập/đăng xuất** (lưu/huỷ credential qua `git credential approve`/`reject`),
  hiển thị tài khoản GitHub đang đăng nhập (xác minh token qua API GitHub, không trả token về UI). Các thao tác cần nhập thêm
  (**Tài khoản Git**, **Clone**) mở dạng **modal** (`src/shell/Modal.tsx`), không phải tab. Repo chọn bằng
  dropdown "Current Repository" kiểu GitHub Desktop (không còn sidebar repo).
  fetch/pull/push (tiến trình qua event `git-progress`), lịch sử. **Merge** nhánh khác vào nhánh hiện tại (`git_merge`, modal chọn nguồn,
  xung đột báo rõ). Nhánh hiển thị **thời gian hoạt động gần nhất** (committerdate) và sắp theo mới nhất.
  **Chuột phải một nhánh** trong dropdown đổi nhánh (Picker có `onItemContextMenu`): chuyển sang, merge vào nhánh hiện tại,
  đổi tên (`git_rename_branch`, chỉ nhánh local), xoá (`git_delete_branch`: local `git branch -d`, nhánh chưa merge thì hỏi rồi **xoá ép** `-D`;
  remote `git push --delete`), copy tên. Chuyển nhánh khi còn thay đổi chưa commit mà git từ chối (`__DIRTY__`):
  hỏi rồi **mang theo thay đổi** sang nhánh mới (`git_switch_bring`: stash -u → switch → stash pop) thay vì báo lỗi đỏ.
  Danh sách repo lưu tạm localStorage.
  Chuột phải file trong danh sách: stage/unstage, bỏ thay đổi, copy đường dẫn, mở Explorer, bỏ qua
  (thêm .gitignore theo file / thư mục chứa / đuôi; file đã track thì hỏi trước khi `git rm --cached`).
  Chuột phải commit trong Lịch sử (kiểu GitHub Desktop): sửa message commit cuối chưa push (amend),
  tạo nhánh từ commit, revert (commit đảo ngược), reset về commit (soft giữ Staged / hard xoá sạch — hỏi trước),
  checkout detached, copy SHA/tiêu đề, mở trang commit trên remote. Sửa lịch sử đã push đều bị chặn phía Rust.
  Mọi lệnh git trên cùng repo được xếp hàng (khoá theo repo) để không tranh `.git/index.lock`.
  Chưa có: giải conflict, đồ thị nhánh, stage từng hunk, force push, cherry-pick.
- `src/apps/http/` — HTTP client chạy thật (`src-tauri/src/http.rs`, crate `reqwest` + rustls, không dính CORS).
  Gửi GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS; soạn Params (đồng bộ query URL) / Headers (bật-tắt) / Body raw;
  xem response có mã màu theo trạng thái + thời gian + kích thước, pretty JSON. **Dán lệnh curl** vào ô URL là tự tách
  thành request chạy được (`curl.ts`: tự tokenize như shell, hiểu -X/-H/-d/-u/-b/-G/-k…); nút **Copy curl** làm chiều ngược lại.
  Sidebar là **collections** (`collections.ts`, cây folder + request lưu localStorage): tạo folder, request mới, đổi tên (**F2** khi focus
  / menu chuột phải — bỏ double-click), xoá. **Import file** curl hoặc **import cả thư mục** lệnh (`http_read_file`/`http_read_dir` đọc file,
  `parseCurlFile` tách nhiều lệnh; giữ nguyên cấu trúc thư mục). Nút **💾 Lưu** (modal) chọn folder + tên để lưu vào collection,
  đã lưu thì ghi đè tại chỗ (tab mang `savedId`). Tab request: Params / Headers / **Auth** (Bearer/Basic/API key) / Body (có **Format/Minify JSON**) / **Script**.
  **Biến môi trường** (`vars.ts`, nút 🔑): `{{tên}}` được thay trong URL/header/body/auth lúc gửi. Tab **Script** có HAI ô: **Pre-request** (`runPreScript`, chạy TRƯỚC khi thay biến — có `req`/`vars`/`setVar`/`getVar`, lỗi thì KHÔNG gửi) và **After response** (`runScript`, có `json`/`resp`/`setVar`/`getVar`). Request lưu `preScript` + `script`. Trạng thái mỗi tab lưu localStorage theo id; `insecure` bỏ qua TLS self-signed.
  Dropdown method và badge tô màu theo method (GET xanh lá, POST vàng, PUT/PATCH xanh dương, DELETE đỏ…).
  Các ô chọn trong form (thư mục lưu, kiểu Auth) dùng `Picker` tự vẽ (hover đẹp) thay cho `<select>` native. **Ctrl+N** mở request mới.
  Chưa có: nhiều environment tách biệt, Postman/.http import, multipart/form-data, OAuth flow, lưu vào SQLite.
- `src/apps/ssh/` — SSH chạy thật (`src-tauri/src/ssh.rs`): **gọi `ssh.exe` của máy trong ConPTY** (`portable-pty`) cho terminal
  (xterm.js, `Terminal.tsx`), và **tunnel** bằng `ssh -N -L/-R/-D` (kiểu MobaXterm). Dùng lại key/known_hosts/ssh-agent/config của máy.
  **Lưu mật khẩu kiểu MobaXterm** (`keyring` → Windows Credential Manager, KHÔNG ghi plaintext): máy trạng thái `PwState` trong `ssh.rs`
  theo dõi dấu nhắc `password:` trên output PTY — có mật khẩu đã lưu thì tự điền; chưa có thì ghi lại mật khẩu người dùng gõ (`ssh_send`),
  đăng nhập thành công (không "permission denied"/không hỏi lại) thì lưu, sai thì xoá khỏi keyring. Khoá = `user@host:port`.
  `ssh_has_password`/`ssh_forget_password` cho UI xem trạng thái + nút "Quên mật khẩu" trong modal host. Host gắn PROD: nền tô đỏ nhạt + nhãn `PROD` (bỏ chấm đỏ cũ vì dễ nhầm mất kết nối).
  **Ô tìm host** ở đầu HOSTS (lọc theo tên/IP/user; đang tìm thì hiện phẳng mọi host khớp). **Chuột phải thư mục** (thêm host / đổi tên / xoá) và **chuột phải host** (kết nối / sửa / quên mật khẩu / xoá) qua `ContextMenu`.
  **`prepared_key` chuẩn hoá private key để `ssh -i` dùng được trên MỌI máy Windows** (không cần cài thêm gì):
  (1) quyền NTFS "quá mở" → chép key sang `%LOCALAPPDATA%\DevStation\keys\` + siết `icacls` chỉ cho user hiện tại (không đụng file gốc, nhất là trên OneDrive);
  (2) key định dạng **PuTTY (.ppk)** (`ssh.exe` báo "invalid format") → **tự convert sang OpenSSH bằng Rust thuần** (`convert_ppk_to_openssh`: đọc public/private blob rồi dựng file `openssh-key-v1`; hỗ trợ ed25519/ecdsa/rsa, key KHÔNG passphrase). Key có passphrase thì thử `puttygen` nếu có, không thì báo rõ. Có test round-trip (`DS_TEST_PPK`).
  **Terminal**: phiên đóng/lỗi → hiện "nhấn R để kết nối lại" (`Terminal.tsx`, `openSession` dùng lại cfg + mật khẩu đã lưu).
  **Tunnel autostart**: tunnel có `autostart` tự mở khi chạy app (`startAutostartTunnels` gọi lười từ `main.tsx`, không kéo UI SSH vào bundle chính); checkbox trong modal tunnel, biểu tượng ⚡ ở danh sách.
  Quy ước ngôn ngữ UI: **giữ thuật ngữ/tiêu đề kỹ thuật bằng tiếng Anh** (Changes, Conflicts, History, Local/Remote, HOSTS, Staged…), chỉ Việt hoá câu hướng dẫn/thông báo lỗi.
  Host lưu localStorage (`hosts.ts`) và **nhóm theo thư mục** (`folders.ts`,
  host có `folderId`; folder đổi tên/xoá, host tự chuyển ra ngoài khi xoá folder), tunnel lưu + trạng thái chạy (`tunnels.ts`).
  Terminal nối hai chiều qua event `ssh-data`/`ssh-closed` (dữ liệu base64); đổi kích thước → `ssh_resize`. Tunnel báo trạng thái qua
  event `ssh-tunnel` (đọc stderr của ssh). Thêm/sửa host & tunnel bằng modal.
  **Panel SFTP kiểu MobaXterm** (`src-tauri/src/sftp.rs` + `src/apps/ssh/SftpPanel.tsx`): **mở sẵn khi vào phiên, nằm bên TRÁI terminal** (nút **📁** bật/tắt; split kéo được `useSplitSize("ssh-files")`).
  **Sidebar host tự thu khi đang trong phiên** (`SshRoot` theo dõi số tab → `setSidebar`): danh sách host chuyển thành **dropdown ở toolbar tab** (Picker: lọc, nhóm theo thư mục, nhãn PROD, mục "Host mới…"/"Hiện danh sách đầy đủ"); chưa vào phiên (không có tab) thì giữ nguyên sidebar. Modal host dùng store nhỏ `openHostForm` (render ở `SshRoot`) để mở được cả khi sidebar ẩn. Chọn host đã có tab thì chuyển sang tab đó (`openHost`), chưa có thì mở tab mới.
  Driver chạy **`sftp.exe` của máy trong ConPTY** (phiên tương tác bền, một kênh nối tiếp bằng `cmd_lock`), đọc kết quả tới dấu nhắc `sftp> ` rồi parse. **Tái dùng auth của app SSH**: `prepared_key` (đã `pub(crate)` trong `ssh.rs`), tự điền mật khẩu đã lưu qua `PwState`/`handle_output` (khoá keyring `user@host:port` dùng chung terminal). Host dùng mật khẩu mà CHƯA lưu → panel báo lỗi rõ (không có chỗ gõ; mở terminal đăng nhập một lần hoặc dùng key). Lệnh Tauri `sftp_open/close/home/list/read/get/put/mkdir/touch/rm/rmdir/rename` (`SftpState` trong `main.rs`; `sftp_touch` tạo file rỗng bằng cách put file tạm 0 byte vì sftp.exe không có `touch`). List bằng `ls -la` (dir trước, bỏ `.`/`..`, lấy basename vì `ls <path>` in tên đầy đủ), preview text/ảnh chặn ~2MB (`sftp_read` tải tạm về rồi phân loại), download/upload qua save/open dialog, chuột phải (`ContextMenu`) tải/đổi tên(F2)/xoá(confirm)/copy path.
  **Điều khiển qua ConPTY:** lệnh sftp submit bằng `\r` (Enter trong ConPTY, KHÔNG phải `\n`), lọc mã ANSI trước khi dò dấu nhắc `sftp>`, lệnh Tauri là **async + `spawn_blocking`** (nếu để sync sẽ chặn main thread → đơ UI).
  **Panel đi theo `cd`:** `ssh_send` dò dòng lệnh người dùng gõ; gõ trọn `cd <path>` + Enter thì phát event `ssh-cd` (bỏ qua khi có Tab/mũi tên/history/`&;|` để không nhảy nhầm), `SftpPanel` (`followCd`) resolve tương đối theo cwd rồi điều hướng. Giới hạn: parse `ls -l` nên tên có xuống dòng/nhiều khoảng trắng bất thường có thể lệch; chưa có %tiến trình, kéo-thả OS, tải cả thư mục.
  **Dải thống kê server** (`SshStats.tsx` + `ssh_stat_start/stop` trong `ssh.rs`, kiểu MobaXterm): mở một **phiên ssh ẩn** chạy vòng lặp sh đọc `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `df -P -k /`, `/proc/loadavg` mỗi 2s → Rust parse (tính CPU% và tốc độ net bằng delta giữa hai mẫu) → phát event `ssh-stat`. Hiện CPU/RAM/Disk dạng thanh % (xanh→vàng→đỏ) + `↑`/`↓` tốc độ mạng (KB/s) + load + **uptime** (`/proc/uptime`, hiện `31d 19h`). Chỉ server Linux; lỗi/không có /proc thì ẩn dải (timeout 15s không có mẫu).
  **Icon file trong SFTP** theo loại (`fileIcon` trong `SftpPanel.tsx`): 📁 dir, 🔗 link, 🖼️ ảnh, 🎬🎵 media, 🗜️📦 nén/gói, 📕📘📊📙📝 tài liệu, ⚙️ cấu hình, 🟨🔷🐍🦀🐹💎🐘☕🔧🐚🗄️🌐 mã nguồn theo ngôn ngữ, 🔑 khoá/chứng chỉ, 🐳 Dockerfile, 🔨 Makefile, 🔀 .git*, 🔒 *.lock; còn lại 📄.
  **Docker (liệt kê + exec vào container)**: nút **🐳** ở toolbar tab mở **modal** liệt kê container đang chạy. Backend `ssh_docker_ps(cfg)` (`ssh.rs`) chạy `ssh_run_once` — một lệnh ssh **một-lần** trong ConPTY (tái dùng `PwState`/`handle_output` để tự điền mật khẩu, lọc ANSI, cột PTY=1000 để ít ngắt dòng). **Hai cái bẫy ConPTY đã xử lý:** (1) ConPTY thường KHÔNG trả EOF khi lệnh từ xa kết thúc → treo tới hết timeout; khắc phục bằng chạy `<cmd>; echo __DEVSTATION_DONE_7Qx9__` rồi reader dừng NGAY khi thấy marker. (2) ConPTY **giãn tab thành dấu cách** khi render → mọi delimiter `\t` biến mất; vì vậy `--format` dùng token ASCII `<%DS%>` (hằng `DOCKER_DELIM`) làm phân cách cột thay cho tab. `parse_docker_ps` tách theo `<%DS%>` (lọc dòng id-hex, bắt lỗi "command not found"/"cannot connect to the docker daemon"/"permission denied .sock"; parse ra 0 container mà output có nội dung thì trả raw output làm lỗi để chẩn đoán). Lệnh là **async + `spawn_blocking`**. Click/double-click/Exec một container → mở **tab terminal exec** chạy `ssh -tt → docker exec -it <tên> sh -lc 'bash||sh'` (`connectExec`; payload có `command`+`tty`+`exec:true`; `ConnectCfg` thêm `tty` → `ssh_connect` phát `-tt`). Tab exec có **panel duyệt file TRONG container** bên trái terminal (nút 📁, split dùng chung `ssh-files`), KHÔNG có stats.
  **Duyệt file trong container** (phần 2, qua `docker exec` — không phải sftp host): `SftpPanel` được **tham số hoá bằng `driver: FsDriver`** (api.ts) — mặc định object `sftp` (host), tab container truyền `dockerFs(cfg, container)`. Backend (ssh.rs, tái dùng `ssh_run_once` + `parse_ls`/`classify`/`preview_toolarge` của sftp đã `pub(crate)`): `docker_fs_list` (`ls -la`), `docker_fs_home` (`pwd`), `docker_fs_cd` (`cd … && pwd`), `docker_fs_read` (script in `__SZ__<size>` rồi `base64` nếu ≤ max — **base64 qua ConPTY an toàn** vì chỉ ASCII in được + xuống dòng, tránh méo như `cat`; decode ở Rust rồi `classify`), `docker_fs_get` (tải về qua base64, cap 64MB), `docker_fs_mkdir/touch/rm/rmdir/rename` (`mkdir/touch/rm -f/rm -rf/mv`). `ssh_run_once` thêm tham số `max_bytes`. Upload vào container CHƯA hỗ trợ (`dockerFs.put` reject; panel ẩn nút ⬆ qua prop `noUpload`). Mỗi thao tác là một lệnh ssh một-lần (không phiên bền → mỗi lần điều hướng tốn ~1-2s). Chưa có: upload vào container, panel đi theo `cd` gõ trong container, logs, start/stop/restart container.
  Chưa có: snippets, jump host, lưu vào SQLite.
- `src/apps/redis/` — app Redis (`src-tauri/src/redis.rs`, crate `redis` + ConnectionManager tự nối lại).
  Duyệt key bằng SCAN có phân trang, xem giá trị theo kiểu (string/hash/list/set/zset/stream), sửa string,
  xoá key (hỏi lại, cảnh báo PROD), chọn db, INFO. Mọi lệnh đọc đều chặn số lượng.
  **Cây key gấp theo `:`** (kiểu RedisInsight, `treeRows` dựng cây từ danh sách phẳng): folder có mũi tên ▸/▾ + số key, leaf hiện đoạn cuối (title = full key); nút 🗂/☰ ở `pane-title` chuyển **tree ↔ list phẳng** (nhớ localStorage `redis.treeView`). Mở folder lưu trong `openFolders`.
  **Form cấu hình kết nối mở dạng MODAL** (`ConnForm`/`ConnFormHost`, store `formReq`/`openForm`/`closeForm`/`useFormReq` — giống app DB), không phải tab.
  **SSH tunnel cho Redis** (kiểu Navicat, `conn.ssh: RedisSsh`): bật thì `redisConnectMaybeTunnel` mở `ssh -L <cổng local ngẫu nhiên>:<redis host>:<redis port>` (tái dùng `ssh_tunnel_open`, BatchMode nên cần key/agent) rồi nối Redis tới `127.0.0.1:<cổng local>` (thử lại vài lần); disconnect/unmount/Ngắt đóng cả tunnel. Form có mục SSH Host/Port/User/key (như DB).
- `src/apps/db/` — app Database: PostgreSQL/MySQL/SQLite qua `sqlx` (`src-tauri/src/db.rs`).
  **Cassandra / ScyllaDB** qua crate `scylla` 0.13 (sqlx không hỗ trợ CQL): `Pool::Cass(Arc<scylla::Session>)`, chạy `session.query(cql, &[])`, mỗi ô map `CqlValue` → chuỗi (`cql_to_string`). Cây keyspace/bảng/cột đọc từ `system_schema.*` (bỏ keyspace `system*`); "database" trong form là **Keyspace**; schema = keyspace, nên định danh `"ks"."table"`. Với Cassandra ẩn các nút đặc thù SQL (struct sync, EXPLAIN, dump, thêm cột/index/bảng mới, F2 đổi tên) — chỉ giữ xem dữ liệu / cấu trúc / TRUNCATE / DROP. Xem bảng không dùng `LIMIT` của driver mà cắt ở Rust (`limit`).
  Chạy SQL bằng `raw_sql` (giao thức text) nên mọi ô trả về dạng chuỗi/NULL, không phải map kiểu.
  Cấu hình kết nối lưu tạm localStorage (KHÔNG lưu mật khẩu; mật khẩu chỉ giữ RAM) — sau chuyển SQLite + keyring.
  **SSH tunnel cho DB** (kiểu Navicat, `conn.ssh`): bật thì `dbConnectMaybeTunnel` mở `ssh -L <cổng local ngẫu nhiên>:<db host>:<db port>` (tái dùng `ssh_tunnel_open`, BatchMode nên cần key/agent)
  rồi nối sqlx tới `127.0.0.1:<cổng local>` (thử lại vài lần chờ forward sẵn sàng); disconnect thì đóng cả tunnel. Form có mục SSH Host/Port/User/key.
  **Lưu mật khẩu DB** (giống Navicat): checkbox **"Lưu mật khẩu"** (`conn.savePw`, mặc định bật) ngay trong **form tạo/sửa** — tick thì submit ghi keyring (`db_save_password`), bỏ tick thì `db_forget_password`.
  Khi mở (`autoTried`): ưu tiên mật khẩu RAM (`sessionPasswords`) → keyring (`db_get_password`) → nếu không có mà `savePw` bật (kể cả DB không mật khẩu) thì **tự nối với mật khẩu rỗng, không hỏi**; chỉ khi `savePw` tắt và chưa có mật khẩu (hoặc mật khẩu sai) mới hiện **MODAL nhập mật khẩu** (`needPw`, có nút Huỷ = đóng tab). Nền lúc nối là **spinner** (`.db-connecting`). **Redis y hệt** (`redis_save_password/get/forget`, service keyring `"DevStation Redis"`).
  **Cây database (lazy)**: config có nhập `database` → **hiện thẳng danh sách bảng, bỏ node database ở gốc** (`singleDb`); để trống → liệt kê mọi database (`db_databases`), mở db nào mới tải bảng db đó (`db_tables` nhận `schema`). Mở bảng dùng tên đủ `schema.table` (MySQL `` `schema`.`table` ``).
  **Database đang chạy query** (`activeDb`): toolbar có Picker **🗃 <db>** chọn database/schema dùng để query; node database đang active có nhãn **USE** (xanh) + highlight. Vì pool nhiều kết nối và `exec` chạy TỪNG câu trên kết nối riêng, mỗi câu được **prepend** `USE \`db\`;` (MySQL) / `SET search_path TO "db";` (Postgres) qua `withActiveDb` — chạy chung một `raw_sql` nên context áp đúng, `run_on!` giữ kết quả câu cuối nên SELECT vẫn ra đúng. SQLite (1 db) / Cassandra (đã qualify ks.table) không prepend.
  **Chuột phải một database** (`databaseMenu`): **Open** (đặt làm db active + mở), **Edit** charset/collation (MySQL, `AlterDbModal` → `ALTER DATABASE`), **New** (MySQL: `NewDbModal`→CREATE DATABASE; Postgres: CREATE SCHEMA), **Dump SQL (cấu trúc / +dữ liệu)** cả database (`dumpDatabase` lặp `buildTableDump` mọi bảng), Refresh, Copy tên. `buildTableDump` tách từ `dumpTable` để dùng chung.
  **Form cấu hình kết nối mở dạng MODAL** (`ConnForm`/`ConnFormHost`, store `formReq`/`openForm`/`closeForm`), không phải tab.
  Bảng kết quả `ResultGrid` được **memo** (không vẽ lại khi gõ SQL). **Chuột phải kết nối** (sidebar): mở / sửa / nhân bản / chuyển vào thư mục / quên mật khẩu / xoá.
  **Gợi ý khi gõ SQL** (kiểu Navicat): popup theo con trỏ (`.sql-sug`, `caretXY` đo toạ độ bằng mirror div) gợi ý **tên bảng / cột / database + từ khoá SQL**; gõ `bảng.` thì chỉ gợi ý cột của bảng đó. Chọn bằng ↑/↓ + Tab/Enter, Esc đóng. Dữ liệu cột lấy từ `db_columns` (tải kèm khi mở db).
  **Nhiều câu lệnh → nhiều kết quả** (`splitStatements` tôn trọng chuỗi/comment/dollar-quote): mỗi câu một `ResultGrid`, xếp dọc. **Ctrl+R / Ctrl+Enter** chạy câu (chạy đoạn bôi đen nếu có). Lỗi báo rõ câu nào kèm nội dung câu đó.
  **Hủy query + statement timeout** (query chậm không đơ app vì mọi lệnh async/threaded, nhưng tab đó treo tới khi DB trả): mỗi câu gửi kèm `queryId` + `timeoutSecs`; backend đăng ký `Notify` theo `queryId` trong `DbState.cancels`, chạy `tokio::select!{ run, notify }` bọc `tokio::time::timeout`. Nút **■ Hủy** (đỏ, thay nút Run khi đang chạy) gọi `db_cancel` → drop future → sqlx đóng kết nối → server dừng. Ô **⏱ [n]s** ở toolbar đặt timeout (0 = không giới hạn, nhớ localStorage). Chưa có: KILL/`pg_cancel_backend` phía server (hiện dựa vào đóng kết nối).
  **EXPLAIN** nút riêng (bọc `EXPLAIN` quanh câu chọn). **Struct sync** (nút ⇄, kiểu Navicat): mỗi đầu **chọn server (kết nối) → chọn database** trong đó — đồng bộ được **cross-server**; server khác session mở tạm bằng mật khẩu đã lưu (keyring/RAM), đóng khi tắt modal. So sánh `db_struct` hai bên, sinh SQL đồng bộ (CREATE TABLE thiếu, ADD/MODIFY/ALTER COLUMN, tuỳ chọn DROP cột thừa), textarea sửa được; **Đồng bộ** chạy lên server đích (confirm, PROD cảnh báo).
  **Chuột phải bảng** (kiểu Navicat): xem dữ liệu · **Edit table** (xem cấu trúc cột qua `db_table_columns`) · **Bảng mới…** · **Thêm cột** (`ALTER TABLE ADD COLUMN`) · **Thêm index** (`CREATE [UNIQUE] INDEX`) · **Dump SQL (cấu trúc)** / **(cấu trúc + dữ liệu)** → chọn đường dẫn bằng `saveDialog` rồi `write_text_file` (MySQL dùng `SHOW CREATE TABLE`, SQLite dùng `sqlite_master`, Postgres dựng từ metadata; data dump 5000 dòng INSERT) · **Empty** (`DELETE`) · **Truncate** · **Delete table** (`DROP`) — các thao tác xoá đều confirm. Modal `DdlModal`/`NewTableModal` hiện SQL trước khi chạy.
  **Thư mục gom kết nối** kiểu Navicat (`db/folders.ts`, `conn.folderId`): tạo/đổi tên/xoá thư mục, kết nối gộp theo thư mục (gập/mở), chuột phải thư mục, Picker thư mục trong form.
  **Lưu query** (`db/queries.ts`, localStorage theo `connId`): toolbar có Picker **📑 Queries** (nạp query đã lưu; chuột phải mục → đổi tên/xoá) + nút **💾 Lưu** (modal đặt tên, trùng tên thì ghi đè). `curQueryName` nhớ query đang mở để điền sẵn khi Lưu.
  **Chuột phải DROP database** trong cây (MySQL `DROP DATABASE`, Postgres `DROP SCHEMA … CASCADE`, Cassandra `DROP KEYSPACE`) — confirm mạnh, tự gập node + bỏ USE + reload.
  **Chuột phải server (sidebar) → Database mới (chạy SQL)…**: mở phiên rồi tự mở `NewDbModal` (store `requestNewDb`/`useNewDbReq` + token để chạy cả khi tab đã mở).
  **Procedure / Function / Event** (MySQL & Postgres): mỗi database mở ra có thêm nhóm **Procedures / Functions / Events** (Postgres không có Events) nạp lười qua `db_query` (`information_schema.ROUTINES`/`.EVENTS`, Postgres `pg_proc`+`pg_namespace`). Chuột phải database → **New procedure/function/event…** mở `RoutineModal` với mẫu đã qualify theo db; chuột phải một routine → **Xem/sửa định nghĩa** (`SHOW CREATE …` / `pg_get_functiondef`, MySQL chèn db vào tên + DROP trước khi tạo lại) hoặc **DROP** (confirm). `RoutineModal` chạy DDL như **MỘT câu** (`runRoutine` gọi thẳng `db_query`, KHÔNG qua `splitStatements` vì thân `BEGIN…END` chứa `;`); event cần `SET GLOBAL event_scheduler = ON`.
- `src/apps/tools/` — gộp các tool nhẹ (Base64, JSON, JWT...) vào một app có sidebar; tool mới thêm vào `TOOLS`.
- `src-tauri/src/main.rs` — đăng ký lệnh Tauri: `app_info`, `db_*` (module `db.rs`).

## Quy ước giao diện
- Bảng màu, kiểu nút/ô nhập lấy theo **GitHub Desktop (Primer)**: nền tối #0d1117, viền #30363d,
  nút chính màu xanh dương #1f6feb (như nút Commit/Pull của GitHub Desktop), bo góc 6px. Bố cục giữ nguyên kiểu IDE.
- **Ngôn ngữ EN/VI** (`src/store/lang.ts`, mặc định **en**, lưu localStorage): `useT()` trả `tr(en, vi)` (re-render khi đổi), `t(en,vi)`/`getLang()` cho chỗ không hook. Nút **EN/VI** ở status bar (`.sb-lang`). `AppManifest` có `titleVi`/`descriptionVi`. **Đang dịch dần theo đợt**: xong shell/launcher/registry + các bề mặt chính của app Database; còn menu/modal sâu của DB và các app khác.
- **Theme sáng/tối** toàn app (`src/store/theme.ts`): biến CSS theo `:root[data-theme=light|dark]`, lưu localStorage,
  đồng bộ cả thanh tiêu đề native (`window.setTheme`). Nút đổi nền ở status bar là **icon mặt trời/mặt trăng** SVG line-art (`.theme-btn`, học từ PonTea Toolkit: tối→mặt trời vàng, sáng→mặt trăng xanh). Nền sáng dùng xám dịu (`--bg: #f4f5f7`, không trắng gắt). Mặc định tối.
- Mỗi chức năng là một **mini app** chiếm toàn cửa sổ. Mở máy vào màn hình chính (launcher), chưa tải app nào.
  App đã vào được giữ trong DOM khi chuyển đi; "Đóng app" trong launcher để giải phóng bộ nhớ.
- Mọi thứ mở ra trong app là một **tab** (repo, request, phiên SSH, tool). Tab giữ trong DOM khi ẩn.
- Host/environment gắn nhãn prod → viền đỏ (`tab.danger`). Trong sidebar, môi trường hiện **nhãn chữ** `DEV`/`STAGING`/`PROD` (`.env-tag`, màu ok/warn/danger) thay cho chấm màu (chấm đỏ dễ nhầm là mất kết nối); hàng PROD tô nền đỏ nhạt (`.side-item.prod`). SSH host PROD dùng `.prod-tag`.
- **Double-click** để mở/truy cập một kết nối (DB, Redis, SSH host) — **click đơn = chọn hàng** (`.side-item.sel`, hiện đang chọn cái nào), không mở (kiểu Navicat). Bảng trong cây DB vẫn mở bằng click đơn.
- **Mọi thao tác xoá phải xác nhận**: dùng `confirmDialog()` dùng chung (`src/shell/confirm.tsx`, `<ConfirmHost/>` đặt ở Shell) trả `Promise<boolean>` — host/tunnel/folder/connection/collection đều hỏi trước khi xoá. (Các xoá của Git/Redis key đã có modal xác nhận riêng.)
- Cây folder (SSH host / DB connection / HTTP collection): **F2** đổi tên khi hàng đang focus (`.tree-row` có `tabIndex=0`, style focus riêng); double-click KHÔNG đổi tên.
- **Kéo-thả sắp vị trí** (không auto-sort): kéo hàng → thả lên hàng khác (chèn trước, `.drop-before`), thả lên thư mục (vào trong, `.drop-into`), thả vùng trống (về gốc/cuối). DB (`setAll`), SSH host (`setHosts`), HTTP collection (`moveNode` — folder=vào trong, request=chèn trước, chặn thả folder vào con của nó). Thứ tự lưu localStorage.
- Thao tác nguy hiểm (force push, reset hard, gửi request lên prod) phải xác nhận.
- Lỗi là kết quả bình thường, hiển thị tại chỗ, không popup.
- Sidebar của app thu gọn được bằng nút ☰ trên thanh tab hoặc Ctrl+B; trạng thái được nhớ lại
  (Git mặc định thu gọn). Các khối lớn kéo giãn được bằng thanh ngăn (`src/shell/Resizable.tsx`),
  double-click để về mặc định, kích thước nhớ trong localStorage.
- Phím tắt: Ctrl+K danh sách app + tìm kiếm, Ctrl+1..9 vào thẳng app, Ctrl+Tab / Ctrl+PageUp/PageDown
  chuyển tab trong app, Ctrl+B sidebar, Ctrl+` panel, Ctrl+W đóng tab, Ctrl+Shift+W tắt app đang chạy.
- Tắt (unload) app đang chạy: nút × cạnh tên app ở status bar, hoặc menu "N app đang chạy", hoặc × trong Ctrl+K.

## Lộ trình
1. Khung ✅ — còn: workspace (nhiều dự án), lưu SQLite, keyring.
2. HTTP client: reqwest phía Rust, dán curl → tự tách, copy as curl, environment `{{var}}`, history.
3. SSH: russh + xterm.js, kết nối lại khi rớt, snippets; sau đó SFTP, port forward, jump host.
4. Git: đọc (status/diff/log) → ghi (stage/commit/pull/push) → giải conflict.
5. Liên kết giữa các app (response có JWT → mở tool JWT, repo → mở terminal...).

## Tự cập nhật (tauri-plugin-updater)
- App đọc `https://github.com/thang997/devstation/releases/latest/download/latest.json` (repo public; updater KHÔNG đọc được repo private), so version, kiểm chữ ký bằng `plugins.updater.pubkey` trong `tauri.conf.json`. `bundle.createUpdaterArtifacts: true` sinh `*.sig` khi build có `TAURI_SIGNING_PRIVATE_KEY`.
- **Private key ở `~/.tauri/devstation.key` (không mật khẩu), NGOÀI repo** — `*.key` đã gitignore. Mất khoá = các máy đã cài không nhận update được nữa → phải sao lưu.
- UI: `src/shell/updater.tsx` — Shell kiểm tra ngầm 3s sau khi mở (lỗi mạng im lặng; bỏ qua ở `app:dev`), có bản mới → nút **⬆ vX** ở status bar → modal (ghi chú, tiến trình tải, **Cập nhật & khởi động lại** qua `downloadAndInstall` + `relaunch` của `plugin-process`). Ctrl+K có lệnh **Kiểm tra cập nhật**. Windows cài kiểu `passive`.
- Capabilities: `updater:default`, `process:allow-restart`.
- Bản 0.1.0 không có updater → máy nào cài 0.1.0 phải cài tay ≥ 0.2.0 một lần.

## Đa nền tảng (Windows · Linux · macOS)
App chạy được cả 3 nền tảng; mọi thứ đặc thù Windows đều nằm trong `#[cfg(windows)]`.
- **Không gọi `.exe`**: dùng `git`, `ssh`, `sftp` từ PATH (Windows tự thêm `.exe`).
- **keyring**: khai báo theo target trong `Cargo.toml` — `windows-native` (Credential Manager) / `sync-secret-service` + `crypto-rust` (Linux, GNOME Keyring/KWallet) / `apple-native` (macOS Keychain). Không có Secret Service thì tính năng lưu mật khẩu tự tắt (lỗi bị bỏ qua, app vẫn chạy).
- **Đường dẫn/mở file**: `explorer.exe` (Windows) · `xdg-open` (Linux) · `open`/`open -R` (macOS) — xem `git_reveal`/`open_url`.
- **Private key**: `prepared_key` — Windows: chép + `icacls` + convert PPK; Linux/macOS: convert PPK sang `$TMP/devstation-keys` với quyền `0600` (`prepare_key_unix`).
- **Icon**: `node scripts/make-icons.mjs` sinh `icon.ico` + `32x32.png`/`128x128.png`/`128x128@2x.png`/`icon.png` + `icon.icns`; `bundle.targets` = `"all"`.
- **Font**: stack có cả `Menlo`/`DejaVu Sans Mono`/`Ubuntu Mono` (Mac/Linux).
- **Build Linux** cần gói hệ thống: `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` (Ubuntu 22.04+). Không cần OpenSSL cho các crate Rust (dùng rustls; `dbus-secret-service` dùng `crypto-rust`).
- **Chưa kiểm chứng**: phần Linux/macOS được viết theo cfg nhưng mới build thử trên Windows — cần chạy `npm run app:build` trên từng OS để xác nhận.

## Lệnh
- `npm run app:dev` — chạy app (Vite port 1430, khác PonTea 1420 nên chạy song song được).
- `npm run build` — typecheck + build frontend.
- `npm run app:build` — build bộ cài cho **nền tảng đang chạy** (Windows: NSIS/MSI · Linux: deb/AppImage · macOS: dmg/app).
- `npm run release -- --notes "…"` — **phát hành bản tự cập nhật**: tăng `version` (tauri.conf.json + package.json + Cargo.toml) trước, script build có ký → `release/v<version>/` (setup.exe + `latest.json`); có token (`GITHUB_TOKEN` hoặc file `~/.tauri/github-token`) thì tự tạo GitHub Release `v<version>` + upload, không có thì upload tay 2 file vào Release (KHÔNG tick pre-release). `--skip-build` để chỉ gom lại.
- `node scripts/make-icons.mjs` — sinh lại toàn bộ icon (`icon.ico`, PNG cho Linux, `icon.icns` cho macOS) + `public/favicon.png` (icon vẽ bằng code, không cần file thiết kế).
