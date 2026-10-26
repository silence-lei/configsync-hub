import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { MemoryFs } from "./memoryFs";
import { defaultSettings } from "../src/core/types";
import { buildRuleSet } from "../src/core/rules";
import { applyPlan, planSync, pushToHub, checkHub, vaultStatus, readVaultState, markVaultSynced } from "../src/core/engine";
import { listBackups, restoreBackup } from "../src/core/backup";
import { readZip } from "../src/core/zip";
import { NullLogger } from "../src/core/logger";

const SOURCE = "/vaults/master";
const TARGET = "/vaults/notes";
const HUB = "/hub";

function seedSource(fs: MemoryFs): void {
	fs.seed(path.join(SOURCE, ".obsidian/plugins/dataview/main.js"), "console.log('dv')");
	fs.seed(path.join(SOURCE, ".obsidian/plugins/dataview/manifest.json"), JSON.stringify({ id: "dataview", version: "1.2.3" }));
	fs.seed(path.join(SOURCE, ".obsidian/plugins/dataview/data.json"), JSON.stringify({ path: "/Users/me/local" }));
	fs.seed(path.join(SOURCE, ".obsidian/plugins/templater/main.js"), "console.log('tp')");
	fs.seed(path.join(SOURCE, ".obsidian/themes/blue/theme.css"), "body{color:blue}");
	fs.seed(path.join(SOURCE, ".obsidian/snippets/note.css"), ".x{}");
	fs.seed(path.join(SOURCE, ".obsidian/hotkeys.json"), JSON.stringify({ a: 1 }));
	fs.seed(path.join(SOURCE, ".obsidian/community-plugins.json"), JSON.stringify(["dataview", "templater"]));
	fs.seed(path.join(SOURCE, ".obsidian/app.json"), JSON.stringify({ attachmentFolderPath: "assets" }));
	fs.seed(path.join(SOURCE, ".obsidian/workspace.json"), JSON.stringify({ layout: "source" }));
	fs.seed(path.join(SOURCE, ".obsidian/plugins/configsync-hub/data.json"), JSON.stringify({ hubPath: HUB }));
}

function seedTarget(fs: MemoryFs): void {
	fs.seed(path.join(TARGET, ".obsidian/workspace.json"), JSON.stringify({ layout: "target" }));
	fs.seed(path.join(TARGET, ".obsidian/plugins/configsync-hub/data.json"), JSON.stringify({ hubPath: "" }));
}

function makeSettings() {
	const s = defaultSettings();
	s.hubPath = HUB;
	s.targets = [{ path: TARGET, name: "notes", enabled: true }];
	return s;
}

test("AC-01/AC-06：推送到 Hub 后同步到新库，工作区文件不受影响", async () => {
	const fs = new MemoryFs();
	seedSource(fs);
	seedTarget(fs);
	const s = makeSettings();
	const rules = buildRuleSet(s);

	const push = await pushToHub(fs, { hubPath: HUB, sourceVaultPath: SOURCE, rules, sourceVaultName: "master" }, new NullLogger());
	assert.equal(push.configVersion.split("-")[1], "1");
	const paths = push.manifest.files.map((f) => f.path);
	assert.ok(paths.includes("plugins/dataview/main.js"));
	assert.ok(paths.includes("plugins/dataview/data.json"));
	assert.ok(paths.includes("hotkeys.json"));
	assert.ok(!paths.includes("workspace.json"), "workspace.json 不应进入 Hub");
	assert.ok(!paths.includes("plugins/configsync-hub/data.json"), "插件自身配置不应进入 Hub");
	assert.ok(!paths.includes("app.json"), "app.json 默认关闭");

	// 插件版本号被写入 manifest
	const dv = push.manifest.files.find((f) => f.path === "plugins/dataview/manifest.json");
	assert.equal(dv?.pluginVersion, "1.2.3");

	const plan = await planSync(fs, { hubPath: HUB, targets: s.targets, rules, prune: false }, new NullLogger());
	const report = await applyPlan(fs, plan, { hubPath: HUB, backup: s.backup, dryRun: false, rules, logger: new NullLogger() });

	assert.equal(report.totals.success, 1);
	assert.equal(report.totals.failed, 0);
	assert.ok(fs.has(path.join(TARGET, ".obsidian/plugins/dataview/main.js")));
	assert.equal(
		fs.read(path.join(TARGET, ".obsidian/workspace.json")),
		JSON.stringify({ layout: "target" }),
		"workspace.json 必须保持原样"
	);
	assert.equal(
		fs.read(path.join(TARGET, ".obsidian/plugins/configsync-hub/data.json")),
		JSON.stringify({ hubPath: "" }),
		"本插件自身配置必须保持原样"
	);

	// 同步后状态为一致
	const plan2 = await planSync(fs, { hubPath: HUB, targets: s.targets, rules, prune: false }, new NullLogger());
	assert.equal(await vaultStatus(fs, TARGET, plan2), "consistent");
});

test("AC-02：增量同步只复制变更文件", async () => {
	const fs = new MemoryFs();
	seedSource(fs);
	seedTarget(fs);
	const s = makeSettings();
	const rules = buildRuleSet(s);

	await pushToHub(fs, { hubPath: HUB, sourceVaultPath: SOURCE, rules }, new NullLogger());
	const plan1 = await planSync(fs, { hubPath: HUB, targets: s.targets, rules, prune: false }, new NullLogger());
	await applyPlan(fs, plan1, { hubPath: HUB, backup: s.backup, dryRun: false, rules, logger: new NullLogger() });

	// 只改动一个插件配置后重新推送
	fs.seed(path.join(SOURCE, ".obsidian/plugins/dataview/data.json"), JSON.stringify({ path: "/changed" }));
	const push2 = await pushToHub(fs, { hubPath: HUB, sourceVaultPath: SOURCE, rules }, new NullLogger());
	assert.equal(push2.copied, 1, "应只复制 1 个变更文件");
	assert.equal(push2.configVersion.split("-")[1], "2");

	const plan2 = await planSync(fs, { hubPath: HUB, targets: s.targets, rules, prune: false }, new NullLogger());
	const vp = plan2.plans[0];
	assert.equal(vp.summary.update, 1, "目标库只应有 1 个更新");
	assert.equal(vp.summary.create, 0);
	const changed = vp.changes.filter((c) => c.action === "update").map((c) => c.path);
	assert.deepEqual(changed, ["plugins/dataview/data.json"]);
});

test("AC-05：排除规则生效", async () => {
	const fs = new MemoryFs();
	seedSource(fs);
	seedTarget(fs);
	const s = makeSettings();
	s.excludedPlugins = ["dataview"];
	const rules = buildRuleSet(s);

	await pushToHub(fs, { hubPath: HUB, sourceVaultPath: SOURCE, rules }, new NullLogger());
	const plan = await planSync(fs, { hubPath: HUB, targets: s.targets, rules, prune: false }, new NullLogger());
	await applyPlan(fs, plan, { hubPath: HUB, backup: s.backup, dryRun: false, rules, logger: new NullLogger() });

	assert.equal(fs.has(path.join(TARGET, ".obsidian/plugins/dataview/main.js")), false, "被排除的插件不应被写入");
	assert.equal(fs.has(path.join(TARGET, ".obsidian/plugins/templater/main.js")), true);
});

test("AC-03：单个库失败不影响其他库", async () => {
	const fs = new MemoryFs();
	seedSource(fs);
	seedTarget(fs);
	const good = "/vaults/good";
	fs.seed(path.join(good, ".obsidian/hotkeys.json"), "{}");
	const s = makeSettings();
	s.targets = [
		{ path: "/vaults/missing", name: "missing", enabled: true },
		{ path: good, name: "good", enabled: true },
	];
	const rules = buildRuleSet(s);
	await pushToHub(fs, { hubPath: HUB, sourceVaultPath: SOURCE, rules }, new NullLogger());

	const plan = await planSync(fs, { hubPath: HUB, targets: s.targets, rules, prune: false }, new NullLogger());
	const report = await applyPlan(fs, plan, { hubPath: HUB, backup: s.backup, dryRun: false, rules, logger: new NullLogger() });

	assert.equal(report.totals.failed, 1);
	assert.equal(report.totals.success, 1);
	const failed = report.results.find((r) => r.vaultPath === "/vaults/missing");
	assert.ok(failed?.error);
	assert.equal(fs.has(path.join(good, ".obsidian/plugins/dataview/main.js")), true);
});

test("AC-04：同步前自动备份，且可从备份恢复", async () => {
	const fs = new MemoryFs();
	seedSource(fs);
	seedTarget(fs);
	// 目标库预先存在一份将被覆盖的旧配置
	fs.seed(path.join(TARGET, ".obsidian/hotkeys.json"), JSON.stringify({ old: true }));

	const s = makeSettings();
	const rules = buildRuleSet(s);
	await pushToHub(fs, { hubPath: HUB, sourceVaultPath: SOURCE, rules }, new NullLogger());
	const plan = await planSync(fs, { hubPath: HUB, targets: s.targets, rules, prune: false }, new NullLogger());
	const report = await applyPlan(fs, plan, { hubPath: HUB, backup: s.backup, dryRun: false, rules, logger: new NullLogger() });

	const backups = await listBackups(fs, TARGET);
	assert.equal(backups.length, 1, "同步前应生成 1 份备份");
	const zipEntries = readZip(await fs.readFile(backups[0].absPath));
	const oldEntry = zipEntries.find((e) => e.name === "hotkeys.json");
	assert.equal(oldEntry?.data.toString("utf8"), JSON.stringify({ old: true }), "备份应包含覆盖前的旧内容");

	const res = await restoreBackup(fs, { vaultPath: TARGET, zipPath: backups[0].absPath, backupBefore: true });
	assert.ok(res.restored > 0);
	assert.equal(fs.read(path.join(TARGET, ".obsidian/hotkeys.json")), JSON.stringify({ old: true }), "恢复后应回到同步前状态");
	assert.equal((await listBackups(fs, TARGET)).length, 2, "恢复前本身也应先备份");
});

test("恢复时可选择删除备份之后新增的文件", async () => {
	const fs = new MemoryFs();
	seedSource(fs);
	seedTarget(fs);
	const s = makeSettings();
	const rules = buildRuleSet(s);
	await pushToHub(fs, { hubPath: HUB, sourceVaultPath: SOURCE, rules }, new NullLogger());
	const plan = await planSync(fs, { hubPath: HUB, targets: s.targets, rules, prune: false }, new NullLogger());
	await applyPlan(fs, plan, { hubPath: HUB, backup: s.backup, dryRun: false, rules, logger: new NullLogger() });
	const backups = await listBackups(fs, TARGET);
	assert.ok(fs.has(path.join(TARGET, ".obsidian/plugins/dataview/main.js")));

	await restoreBackup(fs, { vaultPath: TARGET, zipPath: backups[0].absPath, backupBefore: false, deleteExtraneous: true });
	assert.equal(fs.has(path.join(TARGET, ".obsidian/plugins/dataview/main.js")), false, "时间点还原应删除备份后新增的文件");
});

test("Dry-run 不写入任何文件", async () => {
	const fs = new MemoryFs();
	seedSource(fs);
	seedTarget(fs);
	const s = makeSettings();
	const rules = buildRuleSet(s);
	await pushToHub(fs, { hubPath: HUB, sourceVaultPath: SOURCE, rules }, new NullLogger());
	const plan = await planSync(fs, { hubPath: HUB, targets: s.targets, rules, prune: false }, new NullLogger());
	const report = await applyPlan(fs, plan, { hubPath: HUB, backup: s.backup, dryRun: true, rules, logger: new NullLogger() });
	assert.equal(report.results[0].status, "dry-run");
	assert.equal(fs.has(path.join(TARGET, ".obsidian/plugins/dataview/main.js")), false);
});

test("源库推送到 Hub 后，本库不应再被判定为落后（启动提醒不重复）", async () => {
	const fs = new MemoryFs();
	seedSource(fs);
	seedTarget(fs);
	const s = makeSettings();
	const rules = buildRuleSet(s);

	// 推送前：源库还没有任何同步记录
	assert.equal((await readVaultState(fs, SOURCE)).lastSyncVersion, undefined);

	const push = await pushToHub(fs, { hubPath: HUB, sourceVaultPath: SOURCE, rules, sourceVaultName: "master" }, new NullLogger());
	await markVaultSynced(fs, { vaultPath: SOURCE, configVersion: push.configVersion });

	const health = await checkHub(fs, HUB);
	assert.equal(health.ok, true);
	const hubVersion = health.manifest?.configVersion ?? "";

	// 启动检查的第一个条件：本库已记录在这一版上 → 不提醒
	const state = await readVaultState(fs, SOURCE);
	assert.equal(state.lastSyncVersion, hubVersion, "推送后源库自身必须被标记为该版本");

	// 再推送一次，版本推进后状态也被推进
	fs.seed(path.join(SOURCE, ".obsidian/hotkeys.json"), JSON.stringify({ a: 2 }));
	const push2 = await pushToHub(fs, { hubPath: HUB, sourceVaultPath: SOURCE, rules, sourceVaultName: "master" }, new NullLogger());
	await markVaultSynced(fs, { vaultPath: SOURCE, configVersion: push2.configVersion });
	assert.notEqual(push2.configVersion, push.configVersion);
	assert.equal((await readVaultState(fs, SOURCE)).lastSyncVersion, push2.configVersion);

	// 未被标记的目标库仍然应被判定为落后
	const plan = await planSync(fs, { hubPath: HUB, targets: s.targets, rules, prune: false }, new NullLogger());
	assert.equal(await vaultStatus(fs, TARGET, plan), "behind");
});

test("目标库拉取后记录版本，再次检查为一致", async () => {
	const fs = new MemoryFs();
	seedSource(fs);
	seedTarget(fs);
	const s = makeSettings();
	const rules = buildRuleSet(s);
	await pushToHub(fs, { hubPath: HUB, sourceVaultPath: SOURCE, rules, sourceVaultName: "master" }, new NullLogger());

	const plan = await planSync(fs, { hubPath: HUB, targets: s.targets, rules, prune: false }, new NullLogger());
	await applyPlan(fs, plan, { hubPath: HUB, backup: s.backup, dryRun: false, rules, logger: new NullLogger() });

	const health = await checkHub(fs, HUB);
	assert.equal((await readVaultState(fs, TARGET)).lastSyncVersion, health.manifest?.configVersion);
	assert.equal(await vaultStatus(fs, TARGET, await planSync(fs, { hubPath: HUB, targets: s.targets, rules, prune: false }, new NullLogger())), "consistent");
});

test("Hub 健康检查", async () => {
	const fs = new MemoryFs();
	const empty = await checkHub(fs, HUB);
	assert.equal(empty.ok, false);

	seedSource(fs);
	const s = makeSettings();
	const rules = buildRuleSet(s);
	await pushToHub(fs, { hubPath: HUB, sourceVaultPath: SOURCE, rules }, new NullLogger());
	const ok = await checkHub(fs, HUB);
	assert.equal(ok.ok, true);
	assert.equal(ok.manifest?.files.length, 8);
});
