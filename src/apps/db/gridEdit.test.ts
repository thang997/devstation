import { describe, expect, it } from "vitest";
import { bitLiteral, buildUpdates, countSql, isPageable, orderedSql, pagedSql, parseSourceTable, sortRows, sqlLiteral } from "./gridEdit";

describe("parseSourceTable", () => {
  it("nhận câu SELECT đơn bảng (có/không schema, alias, WHERE/ORDER/LIMIT)", () => {
    expect(parseSourceTable("SELECT * FROM users")).toEqual({ table: "users" });
    expect(parseSourceTable("select id, name from `shop`.`orders` where id > 5 limit 10;")).toEqual({ schema: "shop", table: "orders" });
    expect(parseSourceTable('SELECT * FROM "public"."Users" u ORDER BY 1')).toEqual({ schema: "public", table: "Users" });
    expect(parseSourceTable("-- note\nSELECT * FROM t AS x WHERE x.a = 1")).toEqual({ table: "t" });
  });
  it("từ chối câu không sửa được", () => {
    expect(parseSourceTable("SELECT * FROM a JOIN b ON a.id = b.a_id")).toBeNull();
    expect(parseSourceTable("SELECT * FROM a, b")).toBeNull();
    expect(parseSourceTable("SELECT dept, count(*) FROM e GROUP BY dept")).toBeNull();
    expect(parseSourceTable("SELECT DISTINCT a FROM t")).toBeNull();
    expect(parseSourceTable("SELECT * FROM (SELECT 1) x")).toBeNull();
    expect(parseSourceTable("UPDATE t SET a = 1")).toBeNull();
    expect(parseSourceTable("SELECT 1 UNION SELECT 2")).toBeNull();
  });
});

describe("sqlLiteral", () => {
  it("escape nháy đơn, NULL, và \\ cho MySQL", () => {
    expect(sqlLiteral(null, "mysql")).toBe("NULL");
    expect(sqlLiteral("O'Brien", "postgres")).toBe("'O''Brien'");
    expect(sqlLiteral("a\\b", "mysql")).toBe("'a\\\\b'");
    expect(sqlLiteral("a\\b", "postgres")).toBe("'a\\b'");
  });
});

describe("buildUpdates", () => {
  it("WHERE theo khoá chính GỐC, chỉ SET ô đã sửa", () => {
    const edits = new Map([[1, new Map<number, string | null>([[0, "99"], [2, null]])]]);
    const out = buildUpdates({
      driver: "mysql",
      tableRef: "`shop`.`users`",
      columns: ["id", "name", "note"],
      rows: [["1", "a", "x"], ["2", "b", "y"]],
      edits,
      pkCols: ["id"],
    });
    expect(out).toEqual([{ row: 1, sql: "UPDATE `shop`.`users` SET `id` = '99', `note` = NULL WHERE `id` = '2';" }]);
  });
  it("cột BIT (MySQL) ghi số trần, không bọc nháy", () => {
    const edits = new Map([[0, new Map<number, string | null>([[1, "0"], [2, "b'1'"], [3, "abc"]])]]);
    const out = buildUpdates({
      driver: "mysql",
      tableRef: "`t`",
      columns: ["id", "isactive", "flags", "name"],
      rows: [["1", "1", "0", "x"]],
      edits,
      pkCols: ["id"],
      bitCols: [1, 2],
    });
    expect(out[0].sql).toBe("UPDATE `t` SET `isactive` = 0, `flags` = b'1', `name` = 'abc' WHERE `id` = '1';");
    expect(bitLiteral("x'y", "mysql")).toBe("'x''y'");
    expect(bitLiteral(null, "mysql")).toBe("NULL");
  });
});

describe("phân trang", () => {
  it("nhận câu SELECT chưa có LIMIT", () => {
    expect(isPageable("SELECT * FROM t;", "mysql")).toBe(true);
    expect(isPageable("with x as (select 1) select * from x", "postgres")).toBe(true);
    expect(isPageable("-- c\nSELECT a FROM t ORDER BY a", "sqlite")).toBe(true);
  });
  it("bỏ qua câu đã có LIMIT / không phải SELECT / Cassandra", () => {
    expect(isPageable("SELECT * FROM t LIMIT 5", "mysql")).toBe(false);
    expect(isPageable("SELECT * FROM t OFFSET 10", "postgres")).toBe(false);
    expect(isPageable("SELECT * FROM t FOR UPDATE", "mysql")).toBe(false);
    expect(isPageable("UPDATE t SET a=1", "mysql")).toBe(false);
    expect(isPageable("SELECT * FROM t", "cassandra")).toBe(false);
  });
  it("ghép LIMIT/OFFSET (dư 1 dòng) và COUNT", () => {
    expect(pagedSql("SELECT * FROM t;", 200, 400)).toBe("SELECT * FROM t LIMIT 201 OFFSET 400");
    expect(pagedSql("SELECT * FROM t", 100, 0, { col: 2, desc: true })).toBe("SELECT * FROM t ORDER BY 3 DESC LIMIT 101 OFFSET 0");
    expect(orderedSql("SELECT a, b FROM t ORDER BY a", { col: 1, desc: false })).toBe("SELECT * FROM (SELECT a, b FROM t ORDER BY a) AS ds_sort ORDER BY 2 ASC");
    expect(orderedSql("SELECT * FROM t", null)).toBe("SELECT * FROM t");
    expect(sortRows([["10"], [null], ["9"], ["b"], ["A"]], { col: 0, desc: false })).toEqual([[null], ["9"], ["10"], ["A"], ["b"]]);
    expect(sortRows([["1"], ["3"], ["2"]], { col: 0, desc: true })).toEqual([["3"], ["2"], ["1"]]);
    expect(countSql("SELECT * FROM t ORDER BY a;")).toBe("SELECT COUNT(*) FROM (SELECT * FROM t ORDER BY a) AS ds_count");
  });
});
