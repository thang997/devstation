//! Kết nối database (PostgreSQL / MySQL / SQLite) cho app Database.
//!
//! Chạy câu lệnh bằng `raw_sql` (giao thức text, không prepare) nên:
//! - chạy được nhiều câu lệnh một lần, kết quả lấy theo câu cuối cùng trả về dòng;
//! - mọi giá trị đọc ra dạng chuỗi đúng như DB định dạng → không cần map từng kiểu dữ liệu.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use tokio::sync::Notify;
use tokio::time::timeout;
use serde::{Deserialize, Serialize};
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Column, Either, Executor, Row};
use base64::Engine;
use tauri::State;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnConfig {
    driver: String,
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    user: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    database: String,
    /// Đường dẫn file khi driver = sqlite.
    #[serde(default)]
    file: String,
    /// Postgres: schema mặc định (search_path) đặt ngay lúc kết nối — dùng cho pool theo schema.
    #[serde(skip)]
    search_path: Option<String>,
}

#[derive(Clone)]
enum Pool {
    Pg(sqlx::PgPool),
    My(sqlx::MySqlPool),
    Lite(sqlx::SqlitePool),
    /// Cassandra/ScyllaDB (CQL) — không qua sqlx mà dùng crate `scylla`.
    Cass(Arc<scylla::Session>),
}

#[derive(Default)]
pub struct DbState {
    pools: Mutex<HashMap<String, Pool>>,
    /// Cấu hình đã dùng để mở từng kết nối — để mở thêm pool theo database/schema đang chọn.
    cfgs: Mutex<HashMap<String, ConnConfig>>,
    /// Pool theo (id kết nối, database/schema): database đặt sẵn lúc bắt tay kết nối (MySQL) /
    /// search_path trong tham số kết nối (Postgres) → KHÔNG cần câu USE (ProxySQL từ chối
    /// "multi-statements command with USE", lỗi 1148).
    schema_pools: Mutex<HashMap<(String, String), Pool>>,
    next_id: Mutex<u64>,
    /// Kênh hủy cho từng query đang chạy (query_id → Notify) — để nút Cancel dừng câu lệnh treo.
    cancels: Mutex<HashMap<String, Arc<Notify>>>,
    /// Kết nối đi qua ProxySQL (nhận diện lúc connect) → không gắn thẻ hủy / không gửi KILL.
    proxysql: Mutex<std::collections::HashSet<String>>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryOut {
    columns: Vec<String>,
    /// null = NULL trong DB; còn lại là chuỗi.
    rows: Vec<Vec<Option<String>>>,
    rows_affected: u64,
    elapsed_ms: u128,
    /// Có nhiều dòng hơn `limit`, đã cắt bớt.
    truncated: bool,
    /// Cassandra phân trang bằng driver: token (base64) để lấy trang kế; None = hết dữ liệu.
    paging_state: Option<String>,
}

#[derive(Serialize)]
pub struct TableInfo {
    schema: String,
    name: String,
    kind: String,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/** Đóng kết nối rảnh lâu (server/NAT/firewall hay cắt kết nối im lặng sau vài phút). */
const IDLE_TIMEOUT: Duration = Duration::from_secs(240);

/** Lỗi do kết nối trong pool đã chết (bị server/mạng cắt khi đang rảnh) — câu lệnh chưa tới server. */
fn is_stale_conn_err(e: &str) -> bool {
    let l = e.to_lowercase();
    ["broken pipe", "connection reset", "forcibly closed", "connection aborted", "gone away",
     "unexpected eof", "unexpectedeof", "connection closed", "os error 10054", "os error 10053"]
        .iter()
        .any(|p| l.contains(p))
}

/** Câu chỉ đọc (bỏ qua USE/SET search_path chèn ở đầu) — chỉ những câu này mới tự thử lại khi kết nối chết. */
fn is_read_only(sql: &str) -> bool {
    let body = strip_lead_comments(sql)
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .find(|s| {
            let l = s.to_lowercase();
            !(l.starts_with("use ") || l.starts_with("set search_path"))
        })
        .unwrap_or("")
        .to_lowercase();
    ["select", "show", "explain", "describe", "desc ", "pragma"].iter().any(|k| body.starts_with(k))
}

/** Bỏ các comment `/* … */` ở đầu câu (vd. thẻ hủy `/*ds-q:…*/`). */
fn strip_lead_comments(sql: &str) -> &str {
    let mut s = sql.trim_start();
    while let Some(rest) = s.strip_prefix("/*") {
        match rest.find("*/") {
            Some(i) => s = rest[i + 2..].trim_start(),
            None => break,
        }
    }
    s
}

/** Thẻ đánh dấu câu lệnh (comment đặt đầu câu) để tìm lại đúng câu đó trên server khi hủy / hết timeout. */
fn cancel_tag(query_id: &str) -> String {
    let safe: String = query_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    format!("/*ds-q:{safe}*/")
}

/** Dừng câu lệnh mang thẻ `tag` NGAY TRÊN SERVER (hủy phía app chỉ đóng kết nối — MySQL/Postgres vẫn chạy tiếp
    tới khi xong, query nặng sẽ ngốn CPU server). MySQL/MariaDB: tìm trong PROCESSLIST → `KILL QUERY`;
    Postgres: `pg_cancel_backend`. Qua **ProxySQL** thì KHÔNG gửi KILL (ProxySQL hiểu id là session của chính nó
    → có thể dừng nhầm phiên khác); ProxySQL tự kill query ở backend khi client ngắt kết nối.
    Trả về số câu đã dừng. */
/** Kết nối MySQL này có đi qua ProxySQL không — ProxySQL tự trả lời đúng câu này bằng "(ProxySQL)". */
async fn is_proxysql(pool: &Pool) -> bool {
    if !matches!(pool, Pool::My(_)) {
        return false;
    }
    let ver = run(pool, "select @@version_comment limit 1", 1).await.ok();
    ver.and_then(|o| o.rows.into_iter().next())
        .and_then(|r| r.into_iter().next().flatten())
        .is_some_and(|c| c.to_lowercase().contains("proxysql"))
}

async fn kill_server_query(pool: &Pool, tag: &str) -> usize {
    let work = async {
        match pool {
            Pool::My(_) => {
                if is_proxysql(pool).await {
                    return 0;
                }
                let find = format!("SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE '%{tag}%' AND ID <> CONNECTION_ID()");
                let ids: Vec<u64> = match run(pool, &find, 50).await {
                    Ok(o) => o.rows.into_iter().filter_map(|r| r.into_iter().next().flatten()?.parse().ok()).collect(),
                    Err(_) => return 0,
                };
                let mut n = 0;
                for id in ids {
                    if run(pool, &format!("KILL QUERY {id}"), 1).await.is_ok() {
                        n += 1;
                    }
                }
                n
            }
            Pool::Pg(_) => {
                let sql = format!("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query LIKE '%{tag}%' AND pid <> pg_backend_pid()");
                match run(pool, &sql, 50).await {
                    Ok(o) => o.rows.iter().filter(|r| matches!(r.first(), Some(Some(v)) if v == "t" || v == "true")).count(),
                    Err(_) => 0,
                }
            }
            _ => 0,
        }
    };
    timeout(Duration::from_secs(8), work).await.unwrap_or(0)
}

async fn open(cfg: &ConnConfig) -> Result<Pool, sqlx::Error> {
    let host = if cfg.host.is_empty() { "localhost" } else { &cfg.host };
    Ok(match cfg.driver.as_str() {
        "postgres" => {
            let mut o = PgConnectOptions::new()
                .host(host)
                .port(cfg.port.unwrap_or(5432))
                .username(&cfg.user)
                .password(&cfg.password);
            if !cfg.database.is_empty() {
                o = o.database(&cfg.database);
            }
            if let Some(sp) = cfg.search_path.as_deref().filter(|s| !s.is_empty()) {
                o = o.options([("search_path", format!("\"{}\"", sp.replace('"', "\"\"")))]);
            }
            Pool::Pg(PgPoolOptions::new().max_connections(3).acquire_timeout(CONNECT_TIMEOUT)
                // Không ping trước mỗi query (tiết kiệm 1 vòng mạng/câu — đáng kể qua SSH tunnel / server xa);
                // kết nối rảnh >4 phút tự đóng trước khi server/firewall cắt ngầm. Câu đọc gặp kết nối chết thì db_query thử lại 1 lần.
                .test_before_acquire(false).idle_timeout(Some(IDLE_TIMEOUT))
                .connect_with(o).await?)
        }
        "mysql" => {
            let mut o = MySqlConnectOptions::new()
                .host(host)
                .port(cfg.port.unwrap_or(3306))
                .username(&cfg.user)
                .password(&cfg.password);
            if !cfg.database.is_empty() {
                o = o.database(&cfg.database);
            }
            Pool::My(MySqlPoolOptions::new().max_connections(3).acquire_timeout(CONNECT_TIMEOUT)
                .test_before_acquire(false).idle_timeout(Some(IDLE_TIMEOUT))
                .connect_with(o).await?)
        }
        "sqlite" => {
            let o = SqliteConnectOptions::new().filename(&cfg.file).create_if_missing(false);
            Pool::Lite(SqlitePoolOptions::new().max_connections(1).connect_with(o).await?)
        }
        "cassandra" => {
            let node = format!("{host}:{}", cfg.port.unwrap_or(9042));
            let mut b = scylla::SessionBuilder::new().known_node(node);
            if !cfg.user.is_empty() {
                b = b.user(&cfg.user, &cfg.password);
            }
            let session = b
                .build()
                .await
                .map_err(|e| sqlx::Error::Configuration(format!("Cassandra: {e}").into()))?;
            if !cfg.database.is_empty() {
                let _ = session.use_keyspace(&cfg.database, false).await;
            }
            Pool::Cass(Arc::new(session))
        }
        other => return Err(sqlx::Error::Configuration(format!("driver không hỗ trợ: {other}").into())),
    })
}

/// Đọc một ô thành chuỗi; dữ liệu nhị phân không phải UTF-8 thì hiện dạng hex.
macro_rules! cell {
    ($row:expr, $i:expr) => {
        match $row.try_get_unchecked::<Option<String>, _>($i) {
            Ok(v) => v,
            Err(_) => match $row.try_get_unchecked::<Option<Vec<u8>>, _>($i) {
                Ok(Some(b)) => Some(format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())),
                Ok(None) => None,
                Err(_) => Some("<không đọc được>".into()),
            },
        }
    };
}

/// Chạy SQL trên một pool cụ thể. Viết bằng macro để khỏi phải khai báo trait bound generic của sqlx.
macro_rules! run_on {
    ($pool:expr, $sql:expr, $limit:expr) => {{
        let mut out = QueryOut::default();
        let mut stream = sqlx::raw_sql($sql).fetch_many($pool);
        // Câu lệnh mới bắt đầu trả dòng → bỏ kết quả của câu trước, chỉ giữ câu cuối.
        let mut fresh = true;
        while let Some(item) = stream.try_next().await.map_err(|e| e.to_string())? {
            match item {
                Either::Left(done) => {
                    // Câu vừa trả dòng (SELECT) thì bỏ qua: SQLite báo lại số dòng của câu ghi trước đó.
                    if fresh {
                        out.rows_affected += done.rows_affected();
                    }
                    fresh = true;
                }
                Either::Right(row) => {
                    if fresh {
                        out.columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                        out.rows.clear();
                        out.truncated = false;
                        fresh = false;
                    }
                    if out.rows.len() >= $limit {
                        out.truncated = true;
                        continue;
                    }
                    out.rows.push((0..row.len()).map(|i| cell!(row, i)).collect());
                }
            }
        }
        Ok::<QueryOut, String>(out)
    }};
}

/** Câu dạng truy vấn (trả bảng) — để biết cần lấy tên cột khi kết quả 0 dòng. */
fn looks_like_query(sql: &str) -> bool {
    let l = strip_lead_comments(sql).trim_start().to_lowercase();
    ["select", "with", "show", "explain", "describe", "desc ", "pragma", "values", "table "].iter().any(|k| l.starts_with(k))
}

async fn run(pool: &Pool, sql: &str, limit: usize) -> Result<QueryOut, String> {
    let started = Instant::now();
    let mut out = match pool {
        Pool::Pg(p) => run_on!(p, sql, limit),
        Pool::My(p) => run_on!(p, sql, limit),
        Pool::Lite(p) => run_on!(p, sql, limit),
        Pool::Cass(s) => run_cass(s, sql, limit).await,
    }?;
    // SELECT trả 0 dòng: raw_sql không cho biết tên cột (chỉ có khi có dòng) → hỏi cấu trúc bằng describe
    // (chuẩn bị câu, KHÔNG chạy lại) để UI vẫn hiện bảng rỗng có tiêu đề cột. Lỗi (câu không prepare được) thì bỏ qua.
    if out.columns.is_empty() && out.rows.is_empty() && looks_like_query(sql) {
        let cols: Option<Vec<String>> = match pool {
            Pool::Pg(p) => p.describe(sql).await.ok().map(|d| d.columns().iter().map(|c| c.name().to_string()).collect()),
            Pool::My(p) => p.describe(sql).await.ok().map(|d| d.columns().iter().map(|c| c.name().to_string()).collect()),
            Pool::Lite(p) => p.describe(sql).await.ok().map(|d| d.columns().iter().map(|c| c.name().to_string()).collect()),
            Pool::Cass(_) => None,
        };
        if let Some(c) = cols { out.columns = c; }
    }
    out.elapsed_ms = started.elapsed().as_millis();
    Ok(out)
}

/// Cassandra: lấy MỘT trang (page_size dòng) bằng paging state của driver, consistency LOCAL_ONE —
/// giống TablePlus / driver DataStax. Truy vấn không phân trang (session.query) nặng hơn nhiều trên
/// ScyllaDB và dễ "Operation timed out … CL=LOCAL_QUORUM" với bảng lớn.
async fn run_cass_page(session: &scylla::Session, cql: &str, page_size: i32, state: Option<&str>) -> Result<QueryOut, String> {
    let started = Instant::now();
    let mut q = scylla::query::Query::new(cql.trim().trim_end_matches(';').to_string());
    q.set_page_size(page_size.clamp(1, 5000));
    q.set_consistency(scylla::statement::Consistency::LocalOne);
    let ps = match state.filter(|s| !s.is_empty()) {
        Some(s) => Some(bytes::Bytes::from(
            base64::engine::general_purpose::STANDARD.decode(s).map_err(|e| format!("paging state: {e}"))?,
        )),
        None => None,
    };
    let res = session.query_paged(q, &[], ps).await.map_err(|e| e.to_string())?;
    let mut out = QueryOut::default();
    out.columns = res.col_specs.iter().map(|c| c.name.clone()).collect();
    if let Some(rows) = res.rows {
        for row in rows {
            out.rows.push(row.columns.into_iter().map(|c| c.map(cql_to_string)).collect());
        }
    }
    out.paging_state = res.paging_state.map(|b| base64::engine::general_purpose::STANDARD.encode(&b));
    out.elapsed_ms = started.elapsed().as_millis();
    Ok(out)
}

/// Chọn cách chạy: Cassandra có page_size → lấy một trang bằng driver; còn lại như thường.
async fn run_any(pool: &Pool, sql: &str, lim: usize, page_size: Option<i32>, page_state: Option<&str>) -> Result<QueryOut, String> {
    if let (Pool::Cass(sess), Some(ps)) = (pool, page_size) {
        return run_cass_page(sess, sql, ps, page_state).await;
    }
    run_retry(pool, sql, lim).await
}

/// Một giá trị CQL → chuỗi (các kiểu phổ biến đẹp, còn lại fallback Debug).
fn cql_to_string(v: scylla::frame::response::result::CqlValue) -> String {
    use scylla::frame::response::result::CqlValue as V;
    match v {
        V::Ascii(s) | V::Text(s) => s,
        V::Boolean(b) => b.to_string(),
        V::Int(n) => n.to_string(),
        V::BigInt(n) => n.to_string(),
        V::SmallInt(n) => n.to_string(),
        V::TinyInt(n) => n.to_string(),
        V::Float(f) => f.to_string(),
        V::Double(f) => f.to_string(),
        V::Uuid(u) => u.to_string(),
        V::Inet(ip) => ip.to_string(),
        V::Blob(b) => format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()),
        // date: số ngày, gốc 2^31 = 1970-01-01.
        V::Date(d) => cql_fmt_date(d.0 as i64 - (1i64 << 31)),
        // timestamp: mili-giây UTC → hiện UTC kèm "+0000" như cqlsh (dán lại vào WHERE vẫn đúng).
        V::Timestamp(t) => cql_fmt_timestamp(t.0),
        V::Time(t) => cql_fmt_time(t.0),
        V::Timeuuid(u) => u.to_string(),
        V::Counter(c) => c.0.to_string(),
        V::Varint(v) => cql_big_int(v.as_signed_bytes_be_slice()).unwrap_or_else(|| format!("{v:?}")),
        V::Decimal(d) => {
            let (bytes, scale) = d.as_signed_be_bytes_slice_and_exponent();
            cql_big_int(bytes).map(|n| cql_apply_scale(&n, scale)).unwrap_or_else(|| format!("{d:?}"))
        }
        V::Duration(d) => cql_fmt_duration(d.months, d.days, d.nanoseconds),
        V::Empty => String::new(),
        V::List(items) | V::Set(items) => format!("[{}]", items.into_iter().map(cql_inner).collect::<Vec<_>>().join(", ")),
        V::Map(kv) => format!(
            "{{{}}}",
            kv.into_iter().map(|(k, v)| format!("{}: {}", cql_inner(k), cql_inner(v))).collect::<Vec<_>>().join(", ")
        ),
        V::Tuple(items) => format!(
            "({})",
            items.into_iter().map(|v| v.map(cql_inner).unwrap_or_else(|| "null".into())).collect::<Vec<_>>().join(", ")
        ),
        V::UserDefinedType { fields, .. } => format!(
            "{{{}}}",
            fields
                .into_iter()
                .map(|(k, v)| format!("{k}: {}", v.map(cql_inner).unwrap_or_else(|| "null".into())))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// Phần tử bên trong collection: chuỗi bọc nháy đơn (như cqlsh) để phân biệt với số.
fn cql_inner(v: scylla::frame::response::result::CqlValue) -> String {
    use scylla::frame::response::result::CqlValue as V;
    match v {
        V::Ascii(s) | V::Text(s) => format!("'{}'", s.replace('\'', "''")),
        other => cql_to_string(other),
    }
}

/// Ngày dương lịch từ số ngày kể từ 1970-01-01 (thuật toán civil_from_days của Howard Hinnant).
fn cql_civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

fn cql_fmt_date(days: i64) -> String {
    let (y, m, d) = cql_civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn cql_fmt_timestamp(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    format!(
        "{} {:02}:{:02}:{:02}.{:03}+0000",
        cql_fmt_date(days),
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1_000 % 60,
        rem % 1_000
    )
}

/// time: nano-giây kể từ nửa đêm → HH:MM:SS[.phần lẻ].
fn cql_fmt_time(ns: i64) -> String {
    let secs = ns / 1_000_000_000;
    let frac = ns % 1_000_000_000;
    let base = format!("{:02}:{:02}:{:02}", secs / 3_600, secs / 60 % 60, secs % 60);
    if frac == 0 { base } else { format!("{base}.{}", format!("{frac:09}").trim_end_matches('0')) }
}

/// Số nguyên có dấu big-endian (varint/decimal) → chuỗi; dài quá 16 byte thì bỏ (None).
fn cql_big_int(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return Some("0".into());
    }
    if bytes.len() > 16 {
        return None;
    }
    let mut buf = if bytes[0] & 0x80 != 0 { [0xffu8; 16] } else { [0u8; 16] };
    buf[16 - bytes.len()..].copy_from_slice(bytes);
    Some(i128::from_be_bytes(buf).to_string())
}

/// Chèn dấu thập phân theo scale của decimal (scale âm = thêm số 0).
fn cql_apply_scale(n: &str, scale: i32) -> String {
    let (neg, digits) = n.strip_prefix('-').map_or((false, n), |d| (true, d));
    let s = if scale <= 0 {
        format!("{digits}{}", "0".repeat((-scale) as usize))
    } else {
        let sc = scale as usize;
        let padded = format!("{digits:0>width$}", width = sc + 1);
        let (int, frac) = padded.split_at(padded.len() - sc);
        format!("{int}.{frac}")
    };
    if neg { format!("-{s}") } else { s }
}

/// duration → dạng cqlsh: 1mo2d3h4m5s6ms…
fn cql_fmt_duration(months: i32, days: i32, nanos: i64) -> String {
    let mut out = String::new();
    if months != 0 { out.push_str(&format!("{months}mo")); }
    if days != 0 { out.push_str(&format!("{days}d")); }
    let mut n = nanos;
    for (unit, size) in [("h", 3_600_000_000_000i64), ("m", 60_000_000_000), ("s", 1_000_000_000), ("ms", 1_000_000), ("us", 1_000), ("ns", 1)] {
        let q = n / size;
        if q != 0 {
            out.push_str(&format!("{q}{unit}"));
            n -= q * size;
        }
    }
    if out.is_empty() { "0s".into() } else { out }
}

/// Chạy một câu CQL trên phiên Cassandra. Cassandra không trả "rows affected" nên để 0.
async fn run_cass(session: &scylla::Session, cql: &str, limit: usize) -> Result<QueryOut, String> {
    let res = session.query(cql, &[]).await.map_err(|e| e.to_string())?;
    let mut out = QueryOut::default();
    out.columns = res.col_specs.iter().map(|c| c.name.clone()).collect();
    if let Some(all) = res.rows {
        let total = all.len();
        for row in all.into_iter().take(limit) {
            out.rows.push(row.columns.into_iter().map(|c| c.map(cql_to_string)).collect());
        }
        out.truncated = total > limit;
    }
    Ok(out)
}

fn get(state: &DbState, id: &str) -> Result<Pool, String> {
    state.pools.lock().unwrap().get(id).cloned().ok_or_else(|| "Kết nối đã đóng, hãy kết nối lại".into())
}

/// Pool chạy query trong database/schema `schema` (MySQL/Postgres). Không có schema / SQLite / Cassandra
/// → pool gốc. Pool theo schema mở lười lần đầu cần, dùng lại sau đó; đóng khi db_disconnect.
async fn get_ctx(state: &DbState, id: &str, schema: Option<&str>) -> Result<Pool, String> {
    let base = get(state, id)?;
    let Some(schema) = schema.map(str::trim).filter(|s| !s.is_empty()) else { return Ok(base) };
    if !matches!(base, Pool::My(_) | Pool::Pg(_)) {
        return Ok(base);
    }
    let key = (id.to_string(), schema.to_string());
    if let Some(p) = state.schema_pools.lock().unwrap().get(&key).cloned() {
        return Ok(p);
    }
    let mut cfg = state.cfgs.lock().unwrap().get(id).cloned().ok_or("Kết nối đã đóng, hãy kết nối lại")?;
    match base {
        Pool::My(_) => cfg.database = schema.to_string(), // MySQL: "database" = schema, gửi trong handshake
        _ => cfg.search_path = Some(schema.to_string()),  // Postgres: schema trong database hiện tại
    }
    let pool = open(&cfg).await.map_err(|e| e.to_string())?;
    // Hai query song song có thể cùng mở → giữ pool vào trước, pool thừa tự đóng khi drop.
    Ok(state.schema_pools.lock().unwrap().entry(key).or_insert(pool).clone())
}

#[tauri::command]
pub async fn db_connect(app: tauri::AppHandle, window: tauri::Window, state: State<'_, DbState>, cfg: ConnConfig) -> Result<String, String> {
    let pool = open(&cfg).await.map_err(|e| e.to_string())?;
    let via_proxysql = is_proxysql(&pool).await;
    let id = {
        let mut n = state.next_id.lock().unwrap();
        *n += 1;
        format!("db{}", *n)
    };
    state.pools.lock().unwrap().insert(id.clone(), pool);
    state.cfgs.lock().unwrap().insert(id.clone(), cfg);
    if via_proxysql {
        state.proxysql.lock().unwrap().insert(id.clone());
    }
    crate::owners::track(&app, window.label(), crate::owners::Kind::Db, &id);
    Ok(id)
}

#[tauri::command]
pub async fn db_disconnect(state: State<'_, DbState>, id: String) -> Result<(), String> {
    state.cfgs.lock().unwrap().remove(&id);
    state.proxysql.lock().unwrap().remove(&id);
    let extra: Vec<Pool> = {
        let mut m = state.schema_pools.lock().unwrap();
        let keys: Vec<_> = m.keys().filter(|(i, _)| i == &id).cloned().collect();
        keys.into_iter().filter_map(|k| m.remove(&k)).collect()
    };
    for p in extra {
        match p {
            Pool::Pg(p) => p.close().await,
            Pool::My(p) => p.close().await,
            _ => {}
        }
    }
    let pool = state.pools.lock().unwrap().remove(&id);
    match pool {
        Some(Pool::Pg(p)) => p.close().await,
        Some(Pool::My(p)) => p.close().await,
        Some(Pool::Lite(p)) => p.close().await,
        Some(Pool::Cass(_)) => {} // scylla Session: drop là đóng.
        None => {}
    }
    Ok(())
}

#[tauri::command]
pub async fn db_query(
    state: State<'_, DbState>,
    id: String,
    sql: String,
    limit: Option<usize>,
    query_id: Option<String>,
    timeout_secs: Option<u64>,
    schema: Option<String>,
    page_size: Option<i32>,
    page_state: Option<String>,
) -> Result<QueryOut, String> {
    let pool = get_ctx(&state, &id, schema.as_deref()).await?;
    let lim = limit.unwrap_or(1000);

    // Đăng ký kênh hủy (nếu UI cấp query_id) để nút Cancel dừng được câu lệnh này.
    let notify = query_id.as_ref().map(|qid| {
        let n = Arc::new(Notify::new());
        state.cancels.lock().unwrap().insert(qid.clone(), n.clone());
        n
    });

    // MySQL/Postgres: gắn thẻ comment vào đầu câu để khi hủy/timeout tìm lại được và dừng NGAY TRÊN SERVER.
    // Qua ProxySQL thì không gắn (comment đầu câu có thể làm lệch query rule kiểu `^SELECT` → sai hostgroup).
    let via_proxysql = state.proxysql.lock().unwrap().contains(&id);
    let tag = query_id
        .as_deref()
        .filter(|_| !via_proxysql && matches!(pool, Pool::My(_) | Pool::Pg(_)))
        .map(cancel_tag);
    let sql = match &tag {
        Some(t) => format!("{t} {sql}"),
        None => sql,
    };

    // Query + hủy: Notify bắn → bỏ future (sqlx đóng kết nối). Err(None) = hủy, Err(Some(s)) = timeout.
    let run_cancellable = async {
        match &notify {
            Some(n) => tokio::select! {
                r = run_any(&pool, &sql, lim, page_size, page_state.as_deref()) => Ok(r),
                _ = n.notified() => Err(None),
            },
            None => Ok(run_any(&pool, &sql, lim, page_size, page_state.as_deref()).await),
        }
    };

    // Statement timeout: >0 giây thì bọc timeout; 0/None = không giới hạn.
    let res = match timeout_secs.filter(|s| *s > 0) {
        Some(secs) => timeout(Duration::from_secs(secs), run_cancellable).await.unwrap_or(Err(Some(secs))),
        None => run_cancellable.await,
    };
    let out = match res {
        Ok(r) => r,
        Err(stopped) => {
            let killed = match &tag {
                Some(t) => kill_server_query(&pool, t).await,
                None => 0,
            };
            let base = match stopped {
                None => "Đã hủy câu lệnh".to_string(),
                Some(secs) => format!("Câu lệnh vượt {secs}s — đã dừng (timeout)"),
            };
            Err(if killed > 0 { format!("{base} · đã dừng trên server") } else { base })
        }
    };

    if let Some(qid) = &query_id {
        state.cancels.lock().unwrap().remove(qid);
    }
    out
}

/// Chạy câu lệnh; câu đọc gặp kết nối chết (rảnh lâu bị cắt) thì thử lại 1 lần trên kết nối mới.
async fn run_retry(pool: &Pool, sql: &str, lim: usize) -> Result<QueryOut, String> {
    match run(pool, sql, lim).await {
        Err(e) if is_stale_conn_err(&e) && is_read_only(sql) => run(pool, sql, lim).await,
        r => r,
    }
}

/// Hủy một query đang chạy theo `query_id` (nút Cancel).
#[tauri::command]
pub fn db_cancel(state: State<DbState>, query_id: String) -> Result<(), String> {
    if let Some(n) = state.cancels.lock().unwrap().get(&query_id) {
        n.notify_one();
    }
    Ok(())
}

/// Danh sách database/schema của người dùng (để hiện cây, tải bảng theo từng db khi mở).
#[tauri::command]
pub async fn db_databases(state: State<'_, DbState>, id: String) -> Result<Vec<String>, String> {
    let pool = get(&state, &id)?;
    let sql = match pool {
        Pool::Pg(_) => "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN ('pg_catalog', 'information_schema') AND schema_name NOT LIKE 'pg_%' ORDER BY 1",
        // Hiện MỌI database kể cả hệ thống (mysql, sys, information_schema, performance_schema) — như Navicat.
        Pool::My(_) => "SELECT schema_name FROM information_schema.schemata ORDER BY 1",
        Pool::Lite(_) => "SELECT 'main'",
        Pool::Cass(_) => "SELECT keyspace_name FROM system_schema.keyspaces",
    };
    let out = run(&pool, sql, 100_000).await?;
    let mut names: Vec<String> = out.rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect();
    // Cassandra: bỏ các keyspace hệ thống.
    if matches!(pool, Pool::Cass(_)) {
        names.retain(|n| !n.starts_with("system"));
    }
    Ok(names)
}

/// Danh sách cột (schema, table, column) để gợi ý khi gõ SQL. Lọc theo schema nếu có.
#[tauri::command]
pub async fn db_columns(state: State<'_, DbState>, id: String, schema: Option<String>) -> Result<Vec<String>, String> {
    let pool = get(&state, &id)?;
    let esc = schema.as_deref().filter(|s| !s.is_empty()).map(|s| s.replace('\'', "''"));
    let sql: String = match pool {
        Pool::Pg(_) | Pool::My(_) => {
            let cond = match &esc {
                Some(s) => format!("table_schema = '{s}'"),
                None => "table_schema NOT IN ('pg_catalog','information_schema','performance_schema','mysql','sys')".into(),
            };
            format!("SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE {cond} ORDER BY 1,2,ordinal_position")
        }
        Pool::Lite(_) => "SELECT 'main', m.name, p.name FROM sqlite_master m \
             JOIN pragma_table_info(m.name) p WHERE m.type IN ('table','view') ORDER BY 2, p.cid"
            .into(),
        Pool::Cass(_) => match &esc {
            Some(s) => format!("SELECT keyspace_name, table_name, column_name FROM system_schema.columns WHERE keyspace_name = '{s}'"),
            None => "SELECT keyspace_name, table_name, column_name FROM system_schema.columns".into(),
        },
    };
    let out = run(&pool, &sql, 500_000).await?;
    // Ghép thành "schema\u{1f}table\u{1f}column" để UI tự tách (không phụ thuộc kiểu map).
    Ok(out
        .rows
        .into_iter()
        .filter_map(|r| {
            let mut it = r.into_iter().map(Option::unwrap_or_default);
            let s = it.next()?;
            let t = it.next()?;
            let c = it.next()?;
            Some(format!("{s}\u{1f}{t}\u{1f}{c}"))
        })
        .collect())
}

/// Cấu trúc cột của một bảng — cho "Edit table" và dump cấu trúc.
/// Trả mỗi cột: "name\u{1f}type\u{1f}nullable\u{1f}default\u{1f}key".
#[tauri::command]
pub async fn db_table_columns(
    state: State<'_, DbState>,
    id: String,
    schema: String,
    table: String,
) -> Result<Vec<String>, String> {
    let pool = get(&state, &id)?;
    let s = schema.replace('\'', "''");
    let t = table.replace('\'', "''");
    let sql: String = match pool {
        Pool::Pg(_) => format!(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod), \
             CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END, \
             COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), \
             CASE WHEN pk.attnum IS NOT NULL THEN 'PRI' ELSE '' END \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid=c.relnamespace \
             JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped \
             LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum \
             LEFT JOIN (SELECT conrelid, unnest(conkey) AS attnum FROM pg_constraint WHERE contype='p') pk \
               ON pk.conrelid=c.oid AND pk.attnum=a.attnum \
             WHERE n.nspname='{s}' AND c.relname='{t}' ORDER BY a.attnum"
        ),
        Pool::My(_) => format!(
            "SELECT column_name, column_type, is_nullable, COALESCE(column_default,''), column_key \
             FROM information_schema.columns WHERE table_schema='{s}' AND table_name='{t}' ORDER BY ordinal_position"
        ),
        Pool::Lite(_) => format!("SELECT name, type, notnull, COALESCE(dflt_value,''), pk FROM pragma_table_info('{t}')"),
        Pool::Cass(_) => format!("SELECT column_name, type, kind FROM system_schema.columns WHERE keyspace_name='{s}' AND table_name='{t}'"),
    };
    let out = run(&pool, &sql, 10_000).await?;
    // Cassandra: cột trả về (column_name, type, kind) → dựng 5 trường cho UI.
    if matches!(pool, Pool::Cass(_)) {
        return Ok(out
            .rows
            .into_iter()
            .filter_map(|r| {
                let mut it = r.into_iter().map(Option::unwrap_or_default);
                let name = it.next()?;
                let ty = it.next()?;
                let kind = it.next().unwrap_or_default();
                let is_key = kind == "partition_key" || kind == "clustering";
                let nl = if is_key { "NO" } else { "YES" };
                let key = if kind == "partition_key" { "PRI" } else { "" };
                Some(format!("{name}\u{1f}{ty}\u{1f}{nl}\u{1f}\u{1f}{key}"))
            })
            .collect());
    }
    Ok(out
        .rows
        .into_iter()
        .filter_map(|r| {
            let mut it = r.into_iter().map(Option::unwrap_or_default);
            let name = it.next()?;
            let ty = it.next()?;
            let nl = it.next()?;
            let def = it.next()?;
            let key = it.next()?;
            Some(format!("{name}\u{1f}{ty}\u{1f}{nl}\u{1f}{def}\u{1f}{key}"))
        })
        .collect())
}

/// Toàn bộ cột của một database/schema (dùng cho Struct sync).
/// Mỗi dòng: "table\u{1f}column\u{1f}type\u{1f}nullable\u{1f}default\u{1f}key".
#[tauri::command]
pub async fn db_struct(state: State<'_, DbState>, id: String, schema: String) -> Result<Vec<String>, String> {
    let pool = get(&state, &id)?;
    let s = schema.replace('\'', "''");
    let sql: String = match pool {
        // format_type giữ nguyên độ dài kiểu (varchar(255)…), pg_get_expr lấy đúng biểu thức DEFAULT.
        Pool::Pg(_) => format!(
            "SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), \
             CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END, \
             COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), \
             CASE WHEN pk.attnum IS NOT NULL THEN 'PRI' ELSE '' END \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid=c.relnamespace \
             JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped \
             LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum \
             LEFT JOIN (SELECT conrelid, unnest(conkey) AS attnum FROM pg_constraint WHERE contype='p') pk \
               ON pk.conrelid=c.oid AND pk.attnum=a.attnum \
             WHERE n.nspname='{s}' AND c.relkind IN ('r','p','v','m') \
             ORDER BY c.relname, a.attnum"
        ),
        Pool::My(_) => format!(
            "SELECT table_name, column_name, column_type, is_nullable, COALESCE(column_default,''), column_key \
             FROM information_schema.columns WHERE table_schema='{s}' ORDER BY table_name, ordinal_position"
        ),
        Pool::Lite(_) => "SELECT m.name, p.name, p.type, p.\"notnull\", COALESCE(p.dflt_value,''), p.pk \
             FROM sqlite_master m JOIN pragma_table_info(m.name) p \
             WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid"
            .into(),
        Pool::Cass(_) => return Err("Struct sync chưa hỗ trợ Cassandra".into()),
    };
    let out = run(&pool, &sql, 500_000).await?;
    Ok(out
        .rows
        .into_iter()
        .filter_map(|r| {
            let mut it = r.into_iter().map(Option::unwrap_or_default);
            let t = it.next()?;
            let c = it.next()?;
            let ty = it.next()?;
            let nl = it.next()?;
            let def = it.next()?;
            let key = it.next()?;
            Some(format!("{t}\u{1f}{c}\u{1f}{ty}\u{1f}{nl}\u{1f}{def}\u{1f}{key}"))
        })
        .collect())
}

/* ── Lưu mật khẩu DB vào Windows Credential Manager (giống Navicat "save password") ── */
fn pw_entry(id: &str) -> Option<keyring::Entry> {
    keyring::Entry::new("DevStation DB", id).ok()
}
#[tauri::command]
pub fn db_save_password(id: String, password: String) -> Result<(), String> {
    if let Some(e) = pw_entry(&id) {
        let _ = e.set_password(&password);
    }
    Ok(())
}
#[tauri::command]
pub fn db_get_password(id: String) -> Result<Option<String>, String> {
    Ok(pw_entry(&id).and_then(|e| e.get_password().ok()))
}
#[tauri::command]
pub fn db_forget_password(id: String) -> Result<(), String> {
    if let Some(e) = pw_entry(&id) {
        let _ = e.delete_credential();
    }
    Ok(())
}

#[tauri::command]
pub async fn db_tables(state: State<'_, DbState>, id: String, schema: Option<String>) -> Result<Vec<TableInfo>, String> {
    let pool = get(&state, &id)?;
    // Tên schema lấy từ server (db_databases) nhưng vẫn escape ' cho chắc vì dùng raw_sql (không bind param).
    let esc = schema.as_deref().filter(|s| !s.is_empty()).map(|s| s.replace('\'', "''"));
    let sql: String = match pool {
        Pool::Pg(_) => {
            let cond = match &esc {
                Some(s) => format!("table_schema = '{s}'"),
                None => "table_schema NOT IN ('pg_catalog', 'information_schema')".into(),
            };
            format!("SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE {cond} ORDER BY 1, 2")
        }
        Pool::My(_) => {
            let cond = match &esc {
                Some(s) => format!("table_schema = '{s}'"),
                None => "table_schema NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')".into(),
            };
            format!("SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE {cond} ORDER BY 1, 2")
        }
        Pool::Lite(_) => "SELECT 'main', name, type FROM sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY 2"
            .into(),
        Pool::Cass(_) => match &esc {
            // CQL (nhất là ScyllaDB) không cho SELECT chuỗi hằng ('table') → chỉ lấy 2 cột, loại gán ở dưới.
            Some(s) => format!("SELECT keyspace_name, table_name FROM system_schema.tables WHERE keyspace_name = '{s}'"),
            None => "SELECT keyspace_name, table_name FROM system_schema.tables".into(),
        },
    };
    let out = run(&pool, &sql, 100_000).await?;
    Ok(out
        .rows
        .into_iter()
        .map(|r| {
            let mut it = r.into_iter().map(Option::unwrap_or_default);
            TableInfo {
                schema: it.next().unwrap_or_default(),
                name: it.next().unwrap_or_default(),
                kind: match it.next().unwrap_or_default().to_lowercase().replace("base table", "table") {
                    k if k.is_empty() => "table".into(), // Cassandra: không có cột loại → luôn là bảng
                    k => k,
                },
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn mem() -> Pool {
        let o = SqliteConnectOptions::new().filename(":memory:");
        Pool::Lite(SqlitePoolOptions::new().max_connections(1).connect_with(o).await.unwrap())
    }

    #[tokio::test]
    async fn doc_moi_kieu_thanh_chuoi_va_lay_ket_qua_cau_cuoi() {
        let p = mem().await;
        let out = run(
            &p,
            "CREATE TABLE t (id INTEGER, name TEXT, score REAL, raw BLOB);
             INSERT INTO t VALUES (1, 'Thắng', 9.5, x'ff00'), (2, NULL, 7, NULL);
             SELECT * FROM t ORDER BY id;",
            1000,
        )
        .await
        .unwrap();
        assert_eq!(out.columns, ["id", "name", "score", "raw"]);
        assert_eq!(out.rows[0], [Some("1".into()), Some("Thắng".into()), Some("9.5".into()), Some("0xff00".into())]);
        assert_eq!(out.rows[1][1], None);
        assert_eq!(out.rows_affected, 2);
        assert!(!out.truncated);
    }

    #[tokio::test]
    async fn cat_bot_khi_qua_gioi_han_va_bao_loi_sql() {
        let p = mem().await;
        let out = run(&p, "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 50) SELECT x FROM n", 10)
            .await
            .unwrap();
        assert_eq!(out.rows.len(), 10);
        assert!(out.truncated);
        assert!(run(&p, "SELEC 1", 10).await.is_err());
    }

    #[test]
    fn cancel_tag_and_read_only() {
        let t = cancel_tag("q-12'; DROP x");
        assert_eq!(t, "/*ds-q:q-12DROPx*/");
        assert!(is_read_only(&format!("{t} SELECT 1")));
        assert!(!is_read_only(&format!("{t} UPDATE a SET b=1")));
        assert_eq!(strip_lead_comments("/*a*/ /*b*/ select"), "select");
    }

    #[test]
    fn read_only_detection() {
        assert!(is_read_only("SELECT 1"));
        assert!(is_read_only("USE `shop`;\nSELECT * FROM t"));
        assert!(is_read_only("SET search_path TO \"app\";\n  show tables"));
        assert!(is_read_only("EXPLAIN SELECT 1"));
        assert!(!is_read_only("USE `shop`;\nINSERT INTO t VALUES (1)"));
        assert!(!is_read_only("UPDATE t SET a = 1"));
        assert!(!is_read_only("DELETE FROM t"));
        assert!(!is_read_only("WITH x AS (SELECT 1) DELETE FROM t")); // WITH có thể ghi → không tự thử lại
        assert!(!is_read_only(""));
    }

    #[test]
    fn cassandra_date_time_formatting() {
        assert_eq!(cql_fmt_date(0), "1970-01-01");
        assert_eq!(cql_fmt_date(20_406), "2025-11-14");
        assert_eq!(cql_fmt_date(-1), "1969-12-31");
        assert_eq!(cql_fmt_date(11_016), "2000-02-29"); // năm nhuận
        // CqlDate gốc 2^31 → đúng 1970-01-01
        assert_eq!(cql_to_string(scylla::frame::response::result::CqlValue::Date(scylla::frame::value::CqlDate(1u32 << 31))), "1970-01-01");
        assert_eq!(cql_fmt_timestamp(0), "1970-01-01 00:00:00.000+0000");
        assert_eq!(cql_fmt_timestamp(1_763_110_487_123), "2025-11-14 08:54:47.123+0000");
        assert_eq!(cql_fmt_timestamp(-1), "1969-12-31 23:59:59.999+0000");
        assert_eq!(cql_fmt_time(13 * 3_600_000_000_000 + 5 * 60_000_000_000 + 7_000_000_000 + 500_000_000), "13:05:07.5");
        assert_eq!(cql_apply_scale("12345", 2), "123.45");
        assert_eq!(cql_apply_scale("-5", 3), "-0.005");
        assert_eq!(cql_apply_scale("7", -2), "700");
        assert_eq!(cql_big_int(&[0xff, 0x38]).as_deref(), Some("-200"));
        assert_eq!(cql_fmt_duration(1, 2, 3_723_000_000_000), "1mo2d1h2m3s");
    }

    #[test]
    fn stale_connection_errors() {
        assert!(is_stale_conn_err("error communicating with database: An existing connection was forcibly closed by the remote host. (os error 10054)"));
        assert!(is_stale_conn_err("io error: Broken pipe (os error 32)"));
        assert!(is_stale_conn_err("error returned from database: 2006 (HY000): MySQL server has gone away"));
        assert!(!is_stale_conn_err("error returned from database: 1146 (42S02): Table 'x.y' doesn't exist"));
        assert!(!is_stale_conn_err("Đã hủy câu lệnh"));
    }
}
