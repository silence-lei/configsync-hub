import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { MemoryFs } from "./memoryFs";
import { HubManifest, RemoteConfig, RemoteSnapshotMeta } from "../src/core/types";
import {
	packHubSnapshot,
	planRemote,
	pullFromRemote,
	pushToRemote,
	unpackHubSnapshot,
	backupHub,
} from "../src/core/remote/sync";
import { compareVersions, RemoteTransport } from "../src/core/remote/types";
import { scanPluginInventory } from "../src/core/inventory";
import { buildRuleSet } from "../src/core/rules";
import { defaultSettings } from "../src/core/types";

const HUB = "/hub";
const SOURCE = "/vaults/master";

function seedHub(fs: MemoryFs, version = "2026.10.13-1"): void {
	const manifest: HubManifest = {
		schemaVersion: 1,
		configVersion: version,
		updatedAt: "2026-10-13T00:00:00.000Z",
		sourceVault: "master",
		files: [],
	};
	fs.seed(path.join(HUB, "manifest.json"), JSON.stringify(manifest));
	fs.seed(path.join(HUB, "config/hotkeys.json"), JSON.stringify({ k: 1 }));
	fs.seed(path.join(HUB, "config/plugins/dataview/main.js"), "console.log('dv')");
	fs.seed(path.join(HUB, "config/plugins/dataview/manifest.json"), JSON.stringify({ id: "dataview", version: "0.5.0" }));
}

/** 只搬运一个 zip 的假远端，用来测试编排逻辑 */
class FakeTransport implements RemoteTransport {
	kind = "local" as const;
	store: { data: Buffer; meta: RemoteSnapshotMeta } | null = null;
	tested = 0;

	async readMeta(): Promise<RemoteSnapshotMeta | null> {
		return this.store ? this.store.meta : null;
	}
	async download(): Promise<{ meta: RemoteSnapshotMeta; data: Buffer }> {
		if (!this.store) throw new Error("远端没有快照");
		return this.store;
	}
	async upload(_cfg: RemoteConfig, snapshot: Buffer, meta: RemoteSnapshotMeta): Promise<void> {
		this.store = { data: Buffer.from(snapshot), meta: { ...meta } };
	}
	async test(): Promise<void> {
		this.tested++;
	}
}

function remoteCfg(): RemoteConfig {
	return { id: "r1", kind: "local", name: "fake", enabled: true, options: {} };
}

test("Hub 快照打包后能完整还原（含 clean 清理多余文件）", async () => {
	const fs = new MemoryFs();
	seedHub(fs);

	const packed = await packHubSnapshot(fs, HUB);
	assert.equal(packed.meta.version, "2026.10.13-1");
	assert.ok(packed.fileCount >= 4, `快照应包含 config 与 manifest，实际 ${packed.fileCount}`);

	// 改动 + 新增 + 删除后再还原
	fs.seed(path.join(HUB, "config/hotkeys.json"), JSON.stringify({ k: 999 }));
	fs.seed(path.join(HUB, "config/extra.json"), JSON.stringify({ extra: true }));
	await fs.remove(path.join(HUB, "config/plugins/dataview/main.js"));

	const res = await unpackHubSnapshot(fs, HUB, packed.snapshot, { clean: true });
	assert.equal(res.version, "2026.10.13-1");
	assert.equal(JSON.parse(fs.read(path.join(HUB, "config/hotkeys.json")) ?? "{}").k, 1, "被改动的文件应还原");
	assert.equal(fs.has(path.join(HUB, "config/extra.json")), false, "快照里没有的文件应被清理");
	assert.equal(fs.has(path.join(HUB, "config/plugins/dataview/main.js")), true, "被删除的文件应恢复");
});

test("推送到远端后版本一致时拉取为空操作", async () => {
	const fs = new MemoryFs();
	seedHub(fs);
	const t = new FakeTransport();
	const cfg = remoteCfg();

	const pushed = await pushToRemote(fs, t, cfg, HUB);
	assert.equal(pushed.version, "2026.10.13-1");
	assert.equal(t.store?.meta.version, "2026.10.13-1");

	const plan = await planRemote(fs, t, cfg, HUB);
	assert.equal(plan.comparison, "same");

	const pulled = await pullFromRemote(fs, t, cfg, HUB, { backup: false });
	assert.equal(pulled.comparison, "same");
	assert.equal(pulled.written, 0);
});

test("远端更新时拉取会写回本地 Hub，并先备份", async () => {
	const fs = new MemoryFs();
	seedHub(fs, "2026.10.13-1");
	const t = new FakeTransport();
	const cfg = remoteCfg();

	await pushToRemote(fs, t, cfg, HUB);

	// 本地改旧（模拟另一台设备），远端是新版本
	seedHub(fs, "2026.10.12-1");
	fs.seed(path.join(HUB, "config/hotkeys.json"), JSON.stringify({ k: 42 }));

	const pulled = await pullFromRemote(fs, t, cfg, HUB, { backup: true });
	assert.equal(pulled.comparison, "remote-newer");
	assert.ok(pulled.written > 0);
	assert.equal(JSON.parse(fs.read(path.join(HUB, "config/hotkeys.json")) ?? "{}").k, 1, "应被远端快照覆盖");
	assert.ok(pulled.backupPath, "拉取前应生成 Hub 备份");
	assert.ok(fs.has(pulled.backupPath!.slice(1)), "备份文件应存在");
});

test("远端为空时本地推送、远端拉取的行为", async () => {
	const fs = new MemoryFs();
	seedHub(fs);
	const t = new FakeTransport();
	const cfg = remoteCfg();
	const plan = await planRemote(fs, t, cfg, HUB);
	assert.equal(plan.comparison, "empty");
	await assert.rejects(() => pullFromRemote(fs, t, cfg, HUB, { backup: false }), /远端还没有快照/);
	await pushToRemote(fs, t, cfg, HUB);
	assert.ok(t.store);
});

test("Hub 备份与 compareVersions 版本比较", async () => {
	const fs = new MemoryFs();
	seedHub(fs);
	const backup = await backupHub(fs, HUB);
	assert.ok(backup);

	assert.equal(compareVersions("2026.10.13-1", "2026.10.13-2"), "remote-newer");
	assert.equal(compareVersions("2026.10.13-2", "2026.10.13-1"), "local-newer");
	assert.equal(compareVersions("2026.10.13-1", "2026.10.13-1"), "same");
	assert.equal(compareVersions("2026.10.13-1", undefined), "empty");
	assert.equal(compareVersions(undefined, "2026.10.13-1"), "remote-newer");
});

test("插件清单扫描：Hub + 当前库合并并按 id 排序，排除自身", async () => {
	const fs = new MemoryFs();
	fs.seed(path.join(HUB, "config/plugins/templater/manifest.json"), JSON.stringify({ id: "templater", name: "Templater", version: "2.0.0" }));
	fs.seed(path.join(HUB, "config/plugins/dataview/manifest.json"), JSON.stringify({ id: "dataview", version: "0.5.0" }));
	fs.seed(path.join(SOURCE, ".obsidian/plugins/dataview/manifest.json"), JSON.stringify({ id: "dataview", name: "Dataview", version: "0.5.1" }));
	fs.seed(path.join(SOURCE, ".obsidian/plugins/configsync-hub/manifest.json"), JSON.stringify({ id: "configsync-hub", version: "0.1.0" }));

	const items = await scanPluginInventory(fs, [path.join(HUB, "config"), path.join(SOURCE, ".obsidian")], ["configsync-hub"]);
	assert.deepEqual(
		items.map((i) => i.id),
		["dataview", "templater"]
	);
	assert.equal(items[0].version, "0.5.1", "当前库的版本应覆盖 Hub 中的旧版本");
});

test("逐插件勾选：关闭的插件不参与同步，未列出的默认同步", () => {
	const s = defaultSettings();
	s.pluginSelection = { dataview: false };
	const rules = buildRuleSet(s);

	assert.equal(rules.excludedBy("plugins/dataview/main.js"), "plugin");
	assert.equal(rules.excludedBy("plugins/dataview/data.json"), "plugin");
	assert.equal(rules.excludedBy("plugins/templater/main.js"), "none");
	assert.equal(rules.isSynced("plugins/dataview/main.js"), false);
	assert.equal(rules.isSynced("plugins/templater/main.js"), true);

	// 旧的文本排除列表仍然生效
	const t = defaultSettings();
	t.excludedPlugins = ["templater"];
	const r2 = buildRuleSet(t);
	assert.equal(r2.excludedBy("plugins/templater/main.js"), "plugin");
});
