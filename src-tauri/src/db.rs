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
use sqlx::{Column, Either, Row};
use tauri::State;

#[derive(Deserialize)]
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
    next_id: Mutex<u64>,
    /// Kênh hủy cho từng query đang chạy (query_id → Notify) — để nút Cancel dừng câu lệnh treo.
    cancels: Mutex<HashMap<String, Arc<Notify>>>,
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
}

#[derive(Serialize)]
pub struct TableInfo {
    schema: String,
    name: String,
    kind: String,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

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
            Pool::Pg(PgPoolOptions::new().max_connections(3).acquire_timeout(CONNECT_TIMEOUT).connect_with(o).await?)
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
            Pool::My(MySqlPoolOptions::new().max_connections(3).acquire_timeout(CONNECT_TIMEOUT).connect_with(o).await?)
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

async fn run(pool: &Pool, sql: &str, limit: usize) -> Result<QueryOut, String> {
    let started = Instant::now();
    let mut out = match pool {
        Pool::Pg(p) => run_on!(p, sql, limit),
        Pool::My(p) => run_on!(p, sql, limit),
        Pool::Lite(p) => run_on!(p, sql, limit),
        Pool::Cass(s) => run_cass(s, sql, limit).await,
    }?;
    out.elapsed_ms = started.elapsed().as_millis();
    Ok(out)
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
        other => format!("{other:?}"),
    }
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

#[tauri::command]
pub async fn db_connect(state: State<'_, DbState>, cfg: ConnConfig) -> Result<String, String> {
    let pool = open(&cfg).await.map_err(|e| e.to_string())?;
    let id = {
        let mut n = state.next_id.lock().unwrap();
        *n += 1;
        format!("db{}", *n)
    };
    state.pools.lock().unwrap().insert(id.clone(), pool);
    Ok(id)
}

#[tauri::command]
pub async fn db_disconnect(state: State<'_, DbState>, id: String) -> Result<(), String> {
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
) -> Result<QueryOut, String> {
    let pool = get(&state, &id)?;
    let lim = limit.unwrap_or(1000);

    // Đăng ký kênh hủy (nếu UI cấp query_id) để nút Cancel dừng được câu lệnh này.
    let notify = query_id.as_ref().map(|qid| {
        let n = Arc::new(Notify::new());
        state.cancels.lock().unwrap().insert(qid.clone(), n.clone());
        n
    });

    // Query + hủy: chạy query, nếu Notify được bắn thì bỏ (drop future → sqlx đóng kết nối, server dừng).
    let run_cancellable = async {
        match &notify {
            Some(n) => tokio::select! {
                r = run(&pool, &sql, lim) => r,
                _ = n.notified() => Err("Đã hủy câu lệnh".to_string()),
            },
            None => run(&pool, &sql, lim).await,
        }
    };

    // Statement timeout: >0 giây thì bọc timeout; 0/None = không giới hạn.
    let out = match timeout_secs.filter(|s| *s > 0) {
        Some(secs) => timeout(Duration::from_secs(secs), run_cancellable)
            .await
            .unwrap_or_else(|_| Err(format!("Câu lệnh vượt {secs}s — đã dừng (timeout)"))),
        None => run_cancellable.await,
    };

    if let Some(qid) = &query_id {
        state.cancels.lock().unwrap().remove(qid);
    }
    out
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
            Some(s) => format!("SELECT keyspace_name, table_name, 'table' FROM system_schema.tables WHERE keyspace_name = '{s}'"),
            None => "SELECT keyspace_name, table_name, 'table' FROM system_schema.tables".into(),
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
                kind: it.next().unwrap_or_default().to_lowercase().replace("base table", "table"),
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
}
