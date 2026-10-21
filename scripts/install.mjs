/**
 * 把构建产物安装到指定 vault，方便本地测试：
 *   npm run build && node scripts/install.mjs "/path/to/vault"
 * 未传参数时，从 Obsidian 注册表里列出本机 vault 供选择。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import * as path from "path";

const FILES = ["main.js", "manifest.json", "styles.css"];
const ROOT = path.resolve(import.meta.dirname ?? ".", "..");

function registryVaults() {
	const p = path.join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
	if (!existsSync(p)) return [];
	try {
		const json = JSON.parse(readFileSync(p, "utf8"));
		return Object.values(json.vaults ?? {}).map((v) => v.path).filter(Boolean);
	} catch {
		return [];
	}
}

const target = process.argv[2];
if (!target) {
	const vaults = registryVaults();
	console.log("用法： node scripts/install.mjs <vault 绝对路径>");
	if (vaults.length) {
		console.log("\n本机已知 vault：");
		for (const v of vaults) console.log("  " + v);
	}
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const dest = path.join(target, ".obsidian", "plugins", manifest.id);
if (!existsSync(path.join(target, ".obsidian"))) {
	console.error(`✗ 该目录不是 Obsidian vault（缺少 .obsidian）：${target}`);
	process.exit(1);
}

// 防止覆盖同名但用途不同的插件（例如社区市场上已存在的 config-sync）
const destManifest = path.join(dest, "manifest.json");
if (existsSync(destManifest)) {
	const cur = JSON.parse(readFileSync(destManifest, "utf8"));
	if (cur.id !== manifest.id && !process.argv.includes("--force")) {
		console.error(`✗ ${dest} 里已存在另一个插件（id=${cur.id}），拒绝覆盖。`);
		console.error(`  确认要替换的话加 --force；否则请先在 Obsidian 里禁用并删除它。`);
		process.exit(1);
	}
}

mkdirSync(dest, { recursive: true });
for (const f of FILES) {
	const src = path.join(ROOT, f);
	if (!existsSync(src)) {
		console.error(`✗ 缺少构建产物 ${f}，请先执行 npm run build`);
		process.exit(1);
	}
	copyFileSync(src, path.join(dest, f));
	console.log(`✓ ${f} → ${path.join(dest, f)}`);
}
console.log("\n重启 Obsidian 后在「设置 → 第三方插件」中启用 ConfigSync。");
