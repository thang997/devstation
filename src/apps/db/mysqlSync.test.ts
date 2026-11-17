import { describe, expect, it } from "vitest";
import { assembleSync, buildMysqlSync, normDef, parseCreateTable, planMysqlSync } from "./mysqlSync";

const SRC = `CREATE TABLE \`orders\` (
  \`id\` bigint(20) NOT NULL AUTO_INCREMENT,
  \`code\` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'mã đơn',
  \`status\` tinyint(4) NOT NULL DEFAULT 0,
  \`updated_at\` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  \`user_id\` bigint(20) DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_code\` (\`code\`),
  KEY \`idx_status\` (\`status\`),
  CONSTRAINT \`fk_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`)
) ENGINE=InnoDB AUTO_INCREMENT=1234 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Đơn hàng'`;

// Đích: thiếu AUTO_INCREMENT + PK, thiếu cột updated_at, khác comment cột, thiếu index/FK, thừa cột old.
const DST = `CREATE TABLE \`orders\` (
  \`id\` bigint(20) NOT NULL,
  \`code\` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  \`status\` tinyint(4) NOT NULL DEFAULT 0,
  \`user_id\` bigint(20) DEFAULT NULL,
  \`old\` int(11) DEFAULT NULL,
  KEY \`idx_status\` (\`status\`,\`code\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

describe("parseCreateTable", () => {
  it("tách cột, index, FK, tuỳ chọn bảng (bỏ AUTO_INCREMENT=n)", () => {
    const p = parseCreateTable(SRC);
    expect(p.cols.map((c) => c.name)).toEqual(["id", "code", "status", "updated_at", "user_id"]);
    expect([...p.keys.keys()]).toEqual(["PRIMARY", "IDX:uq_code", "IDX:idx_status", "FK:fk_user"]);
    expect(p.options).toBe("ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Đơn hàng'");
  });
  it("chuẩn hoá MySQL/MariaDB khi so sánh", () => {
    expect(normDef("`id` int(11) NOT NULL")).toBe(normDef("`id` int NOT NULL"));
    expect(normDef("DEFAULT current_timestamp()")).toBe(normDef("DEFAULT CURRENT_TIMESTAMP"));
  });
});

describe("buildMysqlSync", () => {
  it("giữ AUTO_INCREMENT, thêm cột đúng vị trí, sửa comment, index, FK, tuỳ chọn bảng", () => {
    const r = buildMysqlSync({ orders: SRC }, { orders: DST }, "shop", true);
    const sql = r.sql;
    expect(sql.includes("MODIFY COLUMN `id` bigint(20) NOT NULL AUTO_INCREMENT")).toBe(true);
    expect(sql.includes("ADD PRIMARY KEY (`id`)")).toBe(true);
    expect(sql.includes("MODIFY COLUMN `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'mã đơn'")).toBe(true);
    expect(sql.includes("ADD COLUMN `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp() AFTER `status`")).toBe(true);
    expect(sql.includes("DROP COLUMN `old`")).toBe(true);
    expect(sql.includes("DROP INDEX `idx_status`") && sql.includes("ADD KEY `idx_status` (`status`)")).toBe(true);
    expect(sql.includes("ADD UNIQUE KEY `uq_code` (`code`)")).toBe(true);
    // AUTO_INCREMENT và PRIMARY KEY nằm CHUNG một câu ALTER (tránh lỗi "auto column must be defined as a key")
    const main = sql.split(";").find((x) => x.includes("AUTO_INCREMENT"))!;
    expect(main.includes("ADD PRIMARY KEY")).toBe(true);
    // FK thêm ở câu riêng, sau cùng
    expect(sql.indexOf("ADD CONSTRAINT `fk_user`") > sql.indexOf("ADD PRIMARY KEY")).toBe(true);
    expect(sql.includes("ALTER TABLE `shop`.`orders` ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Đơn hàng';")).toBe(true);
  });
  it("bảng thiếu ở đích → CREATE TABLE (không FK), đổi schema, bỏ AUTO_INCREMENT=n; FK thêm ở pha cuối", () => {
    const r = buildMysqlSync({ orders: SRC }, {}, "shop", false);
    expect(r.sql.includes("CREATE TABLE `shop`.`orders` (")).toBe(true);
    const create = r.sql.slice(r.sql.indexOf("CREATE TABLE"), r.sql.indexOf(";", r.sql.indexOf("CREATE TABLE")));
    expect(create.includes("FOREIGN KEY")).toBe(false);
    expect(/KEY `idx_status` \(`status`\)\n\) ENGINE/.test(create)).toBe(true); // dấu phẩy thừa đã bỏ
    expect(r.sql.indexOf("ADD CONSTRAINT `fk_user`") > r.sql.indexOf("CREATE TABLE")).toBe(true);
    expect(r.sql.includes("AUTO_INCREMENT=1234")).toBe(false);
    expect(r.sql.includes("`id` bigint(20) NOT NULL AUTO_INCREMENT")).toBe(true);
  });
  it("bảng mới trỏ vòng nhau (A→B, B→A) → tạo cả hai trước, FK sau cùng", () => {
    const A = "CREATE TABLE `a` (\n  `id` int NOT NULL,\n  `b_id` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_ab` (`b_id`),\n  CONSTRAINT `fk_ab` FOREIGN KEY (`b_id`) REFERENCES `b` (`id`)\n) ENGINE=InnoDB";
    const B = "CREATE TABLE `b` (\n  `id` int NOT NULL,\n  `a_id` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_ba` (`a_id`),\n  CONSTRAINT `fk_ba` FOREIGN KEY (`a_id`) REFERENCES `a` (`id`)\n) ENGINE=InnoDB";
    const sql = buildMysqlSync({ a: A, b: B }, {}, "s", false).sql;
    const lastCreate = sql.lastIndexOf("CREATE TABLE");
    expect(sql.indexOf("ADD CONSTRAINT `fk_ab`") > lastCreate && sql.indexOf("ADD CONSTRAINT `fk_ba`") > lastCreate).toBe(true);
  });
  it("giống nhau (khác hiển thị int(11)/int) → không sinh gì; không dropExtra thì giữ cột thừa", () => {
    const a = "CREATE TABLE `t` (\n  `id` int(11) NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB";
    const b = "CREATE TABLE `t` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `x` int DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB";
    expect(buildMysqlSync({ t: a }, { t: b }, "s", false).sql).toBe("");
  });
});

describe("chọn từng mục (planMysqlSync + assembleSync)", () => {
  it("bỏ chọn một cột → không có trong SQL; cột thêm sau nó lùi AFTER về cột có thật", () => {
    const src = "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `a` int DEFAULT NULL,\n  `b` int DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB";
    const dst = "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB";
    const plan = planMysqlSync({ t: src }, { t: dst }, "s", false);
    const ids = plan.tables[0].items.map((it) => it.id);
    expect(ids).toEqual(["t|col|a", "t|col|b"]);
    const sql = assembleSync(plan, new Set(["t|col|b"]));
    expect(sql.includes("`a`")).toBe(false);
    expect(sql.includes("ADD COLUMN `b` int DEFAULT NULL AFTER `id`")).toBe(true);
    // chọn cả hai → b đứng sau a
    expect(assembleSync(plan).includes("ADD COLUMN `b` int DEFAULT NULL AFTER `a`")).toBe(true);
  });
  it("không chọn gì → SQL rỗng; đổi FK = 1 mục gồm DROP (pha 1) + ADD (pha 5)", () => {
    const s1 = "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `u` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_u` (`u`),\n  CONSTRAINT `fk_u` FOREIGN KEY (`u`) REFERENCES `users` (`id`) ON DELETE CASCADE\n) ENGINE=InnoDB";
    const d1 = "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `u` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk_u` (`u`),\n  CONSTRAINT `fk_u` FOREIGN KEY (`u`) REFERENCES `users` (`id`)\n) ENGINE=InnoDB";
    const plan = planMysqlSync({ t: s1 }, { t: d1 }, "s", false);
    expect(plan.tables[0].items.map((it) => `${it.kind}:${it.action}:${it.name}`)).toEqual(["fk:modify:fk_u"]);
    expect(assembleSync(plan, new Set())).toBe("");
    const sql = assembleSync(plan);
    expect(sql.indexOf("DROP FOREIGN KEY `fk_u`") < sql.indexOf("ADD CONSTRAINT `fk_u`")).toBe(true);
  });
});
