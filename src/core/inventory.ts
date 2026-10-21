/**
 * 插件清单扫描：为设置页提供「逐插件勾选」的数据来源。
 *
 * 同时读取 Hub（`<hub>/config/plugins/<id>/manifest.json`）与当前库
 * （`<vault>/.obsidian/plugins/<id>/manifest.json`），按 id 合并去重。
 */

import * as path from "path";
import { FsApi } from "./fs";
import { PluginInventoryItem } from "./types";

interface RawManifest {
	id?: string;
	name?: string;
	version?: string;
	description?: string;
}

async function readDirPlugins(fs: FsApi, rootDir: string, out: Map<string, PluginInventoryItem>): Promise<void> {
	const pluginsDir = path.join(rootDir, "plugins");
	if (!(await fs.exists(pluginsDir))) return;
	let names: string[];
	try {
		names = await fs.readdir(pluginsDir);
	} catch {
		return;
	}
	for (const name of names) {
		const manifestPath = path.join(pluginsDir, name, "manifest.json");
		if (!(await fs.exists(manifestPath))) continue;
		let raw: string;
		try {
			raw = (await fs.readFile(manifestPath)).toString("utf8");
		} catch {
			continue;
		}
		let json: RawManifest;
		try {
			json = JSON.parse(raw) as RawManifest;
		} catch {
			continue;
		}
		const id = json.id || name;
		if (!id) continue;
		out.set(id, {
			id,
			...(json.name ? { name: json.name } : {}),
			...(json.version ? { version: json.version } : {}),
			...(json.description ? { desc: json.description } : {}),
		});
	}
}

/**
 * @param dirs 需要扫描的根目录（Hub 的 config 目录、vault 的 .obsidian 目录等）
 * @param excludeIds 需要忽略的插件 id（例如本插件自身）
 */
export async function scanPluginInventory(fs: FsApi, dirs: string[], excludeIds: string[] = []): Promise<PluginInventoryItem[]> {
	const exclude = new Set(excludeIds);
	const merged = new Map<string, PluginInventoryItem>();
	for (const dir of dirs) {
		if (!dir) continue;
		await readDirPlugins(fs, dir, merged);
	}
	const out: PluginInventoryItem[] = [];
	for (const item of merged.values()) {
		if (exclude.has(item.id)) continue;
		out.push(item);
	}
	// 按 id 字母序稳定输出
	out.sort((a, b) => a.id.localeCompare(b.id));
	return out;
}
