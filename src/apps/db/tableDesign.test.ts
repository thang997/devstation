import { describe, expect, it } from "vitest";
import { defaultSql, designProblems, designSql, reorderSql, type Design } from "./tableDesign";

const base = (p: Partial<Design>): Design => ({ table: "orders", schema: "shop", ref: "`shop`.`orders`", cols: [], idx: [], fks: [], ...p });

describe("tableDesign", () => {
  it("DEFAULT: số / hàm / chuỗi", () => {
    expect(defaultSql("")).toBeNull();
    expect(defaultSql("0")).toBe("0");
    expect(defaultSql("current_timestamp")).toBe("CURRENT_TIMESTAMP");
    expect(defaultSql("uuid()")).toBe("uuid()");
    expect(defaultSql("abc")).toBe("'abc'");
    expect(defaultSql("O'Neil")).toBe("'O''Neil'");
    expect(defaultSql("'x'")).toBe("'x'");
  });

  it("MySQL: thêm cột + index + khoá ngoại (tên tự động)", () => {
    const sql = designSql("mysql", base({
      cols: [{ key: "1", name: "user_id", type: "BIGINT", notNull: true, def: "", comment: "người đặt" }],
      idx: [{ key: "2", name: "", cols: ["user_id"], kind: "INDEX" }],
      fks: [{ key: "3", name: "", cols: ["user_id"], refTable: "users", refCols: ["id"], onDelete: "CASCADE", onUpdate: "" }],
    }));
    expect(sql).toEqual([
      "ALTER TABLE `shop`.`orders` ADD COLUMN `user_id` BIGINT NOT NULL COMMENT 'người đặt';",
      "CREATE INDEX `idx_orders_user_id` ON `shop`.`orders` (`user_id`);",
      "ALTER TABLE `shop`.`orders` ADD CONSTRAINT `fk_orders_users` FOREIGN KEY (`user_id`) REFERENCES `shop`.`users` (`id`) ON DELETE CASCADE;",
    ]);
  });

  it("Postgres: COMMENT tách câu, UNIQUE, schema public không qualify", () => {
    const sql = designSql("postgres", { ...base({}), schema: "public", ref: '"orders"',
      cols: [{ key: "1", name: "code", type: "varchar(20)", notNull: false, def: "N/A", comment: "mã" }],
      idx: [{ key: "2", name: "uq_code", cols: ["code"], kind: "UNIQUE" }],
      fks: [{ key: "3", name: "fk_x", cols: ["a", "b"], refTable: "t", refCols: ["x", "y"], onDelete: "", onUpdate: "RESTRICT" }],
    });
    expect(sql).toEqual([
      `ALTER TABLE "orders" ADD COLUMN "code" varchar(20) DEFAULT 'N/A';`,
      `COMMENT ON COLUMN "orders"."code" IS 'mã';`,
      `CREATE UNIQUE INDEX "uq_code" ON "orders" ("code");`,
      `ALTER TABLE "orders" ADD CONSTRAINT "fk_x" FOREIGN KEY ("a", "b") REFERENCES "t" ("x", "y") ON UPDATE RESTRICT;`,
    ]);
  });

  it("SQLite: bỏ khoá ngoại (không ALTER được), dòng thiếu dữ liệu bị bỏ + báo lỗi", () => {
    const x = base({ ref: '"orders"', cols: [{ key: "1", name: "", type: "TEXT", notNull: false, def: "", comment: "" }], fks: [{ key: "2", name: "", cols: ["a"], refTable: "t", refCols: ["x"], onDelete: "", onUpdate: "" }] });
    expect(designSql("sqlite", x)).toEqual([]);
    expect(designProblems("sqlite", x)).toEqual(["col:0"]);
    expect(designProblems("mysql", base({ fks: [{ key: "2", name: "", cols: ["a", "b"], refTable: "t", refCols: ["x"], onDelete: "", onUpdate: "" }] }))).toEqual(["fk:0"]);
  });

  it("đổi thứ tự cột (MySQL): MODIFY … FIRST/AFTER chỉ cho cột đổi vị trí trước", () => {
    const defs = { a: "`a` int NOT NULL", b: "`b` varchar(10) DEFAULT NULL", c: "`c` text", d: "`d` date" };
    expect(reorderSql("`t`", ["a", "b", "c", "d"], ["b", "a", "c", "d"], defs)).toEqual([
      "ALTER TABLE `t` MODIFY COLUMN `b` varchar(10) DEFAULT NULL FIRST;",
      "ALTER TABLE `t` MODIFY COLUMN `a` int NOT NULL AFTER `b`;",
      "ALTER TABLE `t` MODIFY COLUMN `c` text AFTER `a`;",
    ]);
    expect(reorderSql("`t`", ["a", "b"], ["a", "b"], defs)).toEqual([]);
    // Mô phỏng chạy lần lượt → ra đúng thứ tự mới.
    const sim = (before: string[], after: string[]) => {
      let cur = [...before];
      for (const s of reorderSql("`t`", before, after, defs)) {
        const col = /MODIFY COLUMN `(\w)`/.exec(s)![1];
        cur = cur.filter((c) => c !== col);
        const m = /AFTER `(\w)`/.exec(s);
        cur.splice(m ? cur.indexOf(m[1]) + 1 : 0, 0, col);
      }
      return cur;
    };
    expect(sim(["a", "b", "c", "d"], ["d", "c", "b", "a"])).toEqual(["d", "c", "b", "a"]);
    expect(sim(["a", "b", "c", "d"], ["a", "c", "d", "b"])).toEqual(["a", "c", "d", "b"]);
  });
});
