import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { sha256, sha256Pure } from "../src/core/hash";
import { createZip, crc32, readZip } from "../src/core/zip";

test("纯 TS SHA-256 与 node crypto 一致", async () => {
	const samples = [
		"",
		"hello world",
		"a".repeat(1000),
		"中文内容测试 🌍",
		"a".repeat(100000), // 触发多分块
	];
	for (const s of samples) {
		const buf = Buffer.from(s, "utf8");
		const expected = createHash("sha256").update(buf).digest("hex");
		assert.equal(sha256Pure(buf), expected, `mismatch for sample length ${s.length}`);
		assert.equal(await sha256(buf), expected);
	}
});

test("sha256 处理二进制数据", async () => {
	const buf = Buffer.from([0, 1, 2, 250, 255, 128]);
	assert.equal(await sha256(buf), createHash("sha256").update(buf).digest("hex"));
});

test("CRC32 已知值", () => {
	assert.equal(crc32(Buffer.from("")), 0);
	assert.equal(crc32(Buffer.from("The quick brown fox jumps over the lazy dog", "utf8")), 0x414fa339);
});

test("zip 写入后可读回，内容与名称一致", () => {
	const entries = [
		{ name: "hotkeys.json", data: Buffer.from(JSON.stringify({ a: 1 }), "utf8") },
		{ name: "plugins/dataview/main.js", data: Buffer.from("console.log('x')".repeat(50), "utf8") },
		{ name: "empty.txt", data: Buffer.alloc(0) },
		{ name: "中文目录/文件.css", data: Buffer.from("body{}", "utf8") },
	];
	const zip = createZip(entries);
	const out = readZip(zip);
	assert.equal(out.length, entries.length);
	const byName = new Map(out.map((e) => [e.name, e.data]));
	for (const e of entries) {
		assert.equal(byName.get(e.name)?.toString("utf8"), e.data.toString("utf8"), `content mismatch: ${e.name}`);
	}
});

test("zip 自动选择压缩或存储", () => {
	const compressible = Buffer.from("a".repeat(5000));
	const zip = createZip([{ name: "big.txt", data: compressible }]);
	assert.ok(zip.length < compressible.length, "可压缩内容应显著变小");
	assert.equal(readZip(zip)[0].data.length, compressible.length);
});
