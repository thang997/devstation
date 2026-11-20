import { describe, it, expect } from "vitest";
import { alterColSql, alterFkSql, alterIdxSql, filterTypes, parseIndexDef, parseMysqlColDef, parsePgFkDef, splitColList, TYPE_LIST } from "./tableEdit";

describe("parseMysqlColDef", () => {
  it("tách kiểu, NOT NULL, AUTO_INCREMENT, COMMENT", () => {
    expect(parseMysqlColDef("`id` bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT 'mã ''x'''"))
      .toEqual({ name: "id", type: "bigint(20) unsigned", pre: "", notNull: true, def: "", post: "AUTO_INCREMENT", comment: "mã 'x'" });
  });
  it("giữ charset/collate ở pre, ON UPDATE ở post", () => {
    const q = parseMysqlColDef("`n` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT 'a b' ON UPDATE x,");
    expect(q.type).toBe("varchar(50)");
    expect(q.pre).toBe("CHARACTER SET utf8mb4 COLLATE utf8mb4_bin");
    expect(q.def).toBe("'a b'");
    expect(q.post).toBe("ON UPDATE x");
  });
  it("DEFAULT hàm + enum có dấu cách", () => {
    const r = parseMysqlColDef("`t` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()");
    expect(r.def).toBe("current_timestamp()");
    expect(r.post).toBe("ON UPDATE current_timestamp()");
    expect(parseMysqlColDef("`e` enum('a','b c') DEFAULT NULL").type).toBe("enum('a','b c')");
  });
});

describe("alterColSql", () => {
  it("MySQL: CHANGE COLUMN giữ AUTO_INCREMENT", () => {
    const p = parseMysqlColDef("`id` int(11) NOT NULL AUTO_INCREMENT");
    expect(alterColSql("mysql", "`t`", { key: "k", name: "uid", type: p.type, notNull: true, def: "", comment: "c", pre: p.pre, post: p.post, orig: { name: "id", type: p.type, notNull: true, def: "", comment: "" } }))
      .toEqual(["ALTER TABLE `t` CHANGE COLUMN `id` `uid` int(11) NOT NULL AUTO_INCREMENT COMMENT 'c';"]);
  });
  it("MySQL: đổi kiểu thì bỏ charset", () => {
    expect(alterColSql("mysql", "`t`", { key: "k", name: "a", type: "int", notNull: false, def: "", comment: "", pre: "CHARACTER SET utf8mb4 COLLATE x", orig: { name: "a", type: "varchar(5)", notNull: false, def: "", comment: "" } }))
      .toEqual(["ALTER TABLE `t` CHANGE COLUMN `a` `a` int NULL;"]);
  });
  it("không đổi gì → không có câu", () => {
    expect(alterColSql("mysql", "`t`", { key: "k", name: "a", type: "A", notNull: false, def: "", comment: "", orig: { name: "a", type: "a", notNull: false, def: "", comment: "" } })).toEqual([]);
  });
  it("Postgres: từng phần", () => {
    expect(alterColSql("postgres", '"t"', { key: "k", name: "b", type: "bigint", notNull: true, def: "", comment: "", orig: { name: "a", type: "integer", notNull: false, def: "0", comment: "" } })).toEqual([
      'ALTER TABLE "t" RENAME COLUMN "a" TO "b";',
      'ALTER TABLE "t" ALTER COLUMN "b" TYPE bigint USING "b"::bigint;',
      'ALTER TABLE "t" ALTER COLUMN "b" SET NOT NULL;',
      'ALTER TABLE "t" ALTER COLUMN "b" DROP DEFAULT;',
    ]);
  });
});

describe("alterIdxSql / alterFkSql", () => {
  const x = { ref: "`t`", schema: "s", table: "t" };
  it("MySQL index: DROP + ADD một câu", () => {
    expect(alterIdxSql("mysql", x, { key: "k", name: "ix", cols: ["a", "b"], kind: "UNIQUE", orig: { name: "ix", cols: ["a"], kind: "INDEX" } }))
      .toEqual(["ALTER TABLE `t` DROP INDEX `ix`, ADD UNIQUE INDEX `ix` (`a`, `b`);"]);
    expect(alterIdxSql("mysql", x, { key: "k", name: "PRIMARY", cols: ["a", "b"], kind: "PRIMARY", orig: { name: "PRIMARY", cols: ["a"], kind: "PRIMARY" } }))
      .toEqual(["ALTER TABLE `t` DROP PRIMARY KEY, ADD PRIMARY KEY (`a`, `b`);"]);
  });
  it("MySQL FK: hai câu", () => {
    expect(alterFkSql("mysql", { table: "t", schema: "s", ref: "`s`.`t`", cols: [], idx: [], fks: [] }, { key: "k", name: "fk1", cols: ["u"], refTable: "users", refCols: ["id"], onDelete: "CASCADE", onUpdate: "", orig: { name: "fk1", cols: ["u"], refTable: "users", refCols: ["id"], onDelete: "RESTRICT", onUpdate: "" } }))
      .toEqual(["ALTER TABLE `s`.`t` DROP FOREIGN KEY `fk1`;", "ALTER TABLE `s`.`t` ADD CONSTRAINT `fk1` FOREIGN KEY (`u`) REFERENCES `s`.`users` (`id`) ON DELETE CASCADE;"]);
  });
});

describe("parsers + types", () => {
  it("index def / fk def / col list", () => {
    expect(parseIndexDef('CREATE UNIQUE INDEX ix ON public.t USING btree (a, "b c")')).toEqual({ unique: true, cols: ["a", "b c"] });
    expect(parseIndexDef("CREATE INDEX ix ON t (lower(a))")).toBeNull();
    expect(parsePgFkDef("FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE")).toEqual({ cols: ["user_id"], refTable: "users", refCols: ["id"], onDelete: "CASCADE", onUpdate: "" });
    expect(splitColList("a, b, c")).toEqual(["a", "b", "c"]);
  });
  it("filterTypes: khớp đầu trước", () => {
    const r = filterTypes(TYPE_LIST.mysql, "int").map((t) => t.name);
    expect(r[0]).toBe("int");
    expect(r).toContain("bigint");
    expect(r.indexOf("int") < r.indexOf("bigint")).toBe(true);
  });
});
