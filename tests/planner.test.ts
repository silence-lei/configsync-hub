import { test } from "node:test";
import assert from "node:assert/strict";

import { FileEntry } from "../src/core/types";
import { planVault, planIsEmpty } from "../src/core/planner";

function entry(path: string, sha: string, size = 10): FileEntry {
	return { path, sha256: sha, size, mtime: new Date(0).toISOString() };
}

test("新增 / 更新 / 跳过 的判定", () => {
	const hub = new Map<string, FileEntry>([
		["plugins/a/main.js", entry("plugins/a/main.js", "h1")],
		["plugins/b/main.js", entry("plugins/b/main.js", "h2")],
		["hotkeys.json", entry("hotkeys.json", "h3")],
	]);
	const local = new Map<string, { h: string; s: number; m: number }>([
		["plugins/a/main.js", { h: "h1", s: 10, m: 0 }],
		["plugins/b/main.js", { h: "old", s: 10, m: 0 }],
	]);

	const plan = planVault("/vault", "vault", hub, local, { prune: false });
	assert.equal(plan.summary.create, 1);
	assert.equal(plan.summary.update, 1);
	assert.equal(plan.summary.skip, 1);
	assert.equal(plan.summary.delete, 0);
	assert.equal(planIsEmpty(plan), false);
});

test("无差异时不产生写操作", () => {
	const hub = new Map<string, FileEntry>([["hotkeys.json", entry("hotkeys.json", "same")]]);
	const local = new Map<string, { h: string; s: number; m: number }>([["hotkeys.json", { h: "same", s: 10, m: 0 }]]);
	const plan = planVault("/v", "v", hub, local, { prune: false });
	assert.equal(planIsEmpty(plan), true);
	assert.equal(plan.summary.bytes, 0);
});

test("prune 打开时才删除目标库多余文件", () => {
	const hub = new Map<string, FileEntry>();
	const local = new Map<string, { h: string; s: number; m: number }>([["themes/old/theme.css", { h: "x", s: 5, m: 0 }]]);
	assert.equal(planVault("/v", "v", hub, local, { prune: false }).summary.delete, 0);
	assert.equal(planVault("/v", "v", hub, local, { prune: true }).summary.delete, 1);
});

test("变更项排在跳过项之前", () => {
	const hub = new Map<string, FileEntry>([
		["a.json", entry("a.json", "same")],
		["z.json", entry("z.json", "new")],
	]);
	const local = new Map<string, { h: string; s: number; m: number }>([["a.json", { h: "same", s: 1, m: 0 }]]);
	const changes = planVault("/v", "v", hub, local, { prune: false }).changes;
	assert.equal(changes[0].action, "create");
	assert.equal(changes[changes.length - 1].action, "skip");
});
