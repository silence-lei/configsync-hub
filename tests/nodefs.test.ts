import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import * as path from "node:path";

import { nodeFs } from "../src/platform/nodeFs";
import { buildRuleSet } from "../src/core/rules";
import { defaultSettings } from "../src/core/types";
import { applyPlan, planSync, pushToHub } from "../src/core/engine";
import { listBackups } from "../src/core/backup";
import { NullLogger } from "../src/core/logger";

/** 用真实磁盘跑一遍完整流程，验证 nodeFs 与路径处理 */
test("真实文件系统端到端：初始化 Hub → 同步 → 备份", async () => {
	// 临时目录放在编译输出目录下（.tmp-test 已在 .gitignore），不依赖系统 tmpdir 的删除权限
	mkdirSync(path.join(__dirname, "..", ".tmp-test"), { recursive: true });
	const root = mkdtempSync(path.join(__dirname, "..", ".tmp-test", "e2e-"));
	try {
		const source = path.join(root, "master");
		const target = path.join(root, "notes");
		const hub = path.join(root, "hub");

		const write = (vault: string, rel: string, content: string): void => {
			const abs = path.join(vault, ".obsidian", rel);
			mkdirSync(path.dirname(abs), { recursive: true });
			writeFileSync(abs, content, "utf8");
		};

		write(source, "plugins/dataview/main.js", "console.log(1)");
		write(source, "plugins/dataview/data.json", JSON.stringify({ a: 1 }));
		write(source, "themes/blue/theme.css", "body{}");
		write(source, "hotkeys.json", JSON.stringify({ k: 1 }));
		write(source, "workspace.json", JSON.stringify({ keep: true }));
		write(target, "workspace.json", JSON.stringify({ keep: "target" }));

		const s = defaultSettings();
		s.hubPath = hub;
		s.targets = [{ path: target, name: "notes", enabled: true }];
		const rules = buildRuleSet(s);

		const push = await pushToHub(nodeFs, { hubPath: hub, sourceVaultPath: source, rules }, new NullLogger());
		assert.ok(push.manifest.files.length >= 4);
		assert.ok(existsSync(path.join(hub, "manifest.json")));
		assert.ok(existsSync(path.join(hub, "config/plugins/dataview/main.js")));

		const plan = await planSync(nodeFs, { hubPath: hub, targets: s.targets, rules, prune: false }, new NullLogger());
		const report = await applyPlan(nodeFs, plan, {
			hubPath: hub,
			backup: s.backup,
			dryRun: false,
			rules,
			logger: new NullLogger(),
		});
		assert.equal(report.totals.failed, 0);
		assert.equal(JSON.parse(readFileSync(path.join(target, ".obsidian/hotkeys.json"), "utf8")).k, 1);
		assert.equal(
			JSON.parse(readFileSync(path.join(target, ".obsidian/workspace.json"), "utf8")).keep,
			"target",
			"workspace.json 必须原样保留"
		);

		const backups = await listBackups(nodeFs, target);
		assert.equal(backups.length, 1);

		// 二次同步应当全部跳过（增量）
		const plan2 = await planSync(nodeFs, { hubPath: hub, targets: s.targets, rules, prune: false }, new NullLogger());
		assert.equal(plan2.plans[0].summary.create + plan2.plans[0].summary.update, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
