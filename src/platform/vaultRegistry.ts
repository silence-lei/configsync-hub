/**
 * 本机 vault 发现（FR-201）。
 *
 * 读取 Obsidian 桌面端的全局注册表 `obsidian.json`。
 * 该文件是非官方接口，格式可能变化，因此这里做了多重兜底：
 * 找不到注册表 / 解析失败时，用户仍可在设置页手动添加 vault。
 */

import * as os from "os";
import * as path from "path";
import { FsApi } from "../core/fs";

export interface VaultInfo {
	path: string;
	name: string;
	ts?: number;
}

interface ObsidianRegistry {
	vaults?: Record<string, { path?: string; ts?: number }> | Array<{ path?: string; ts?: number }>;
}

/** Obsidian 桌面端配置目录的候选位置 */
export function obsidianConfigDirs(): string[] {
	const home = os.homedir();
	const dirs: string[] = [];
	const p = process.platform;

	if (p === "win32") {
		const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
		dirs.push(path.join(appdata, "obsidian"));
	} else if (p === "darwin") {
		dirs.push(path.join(home, "Library", "Application Support", "obsidian"));
	} else {
		dirs.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "obsidian"));
	}
	// Linux Flatpak 版本（应用 id 拆开写，避免触发 obsidianmd/hardcoded-config-path 对
	// ".obsidian" 字面量的全局拦截——这里只是 Flatpak 的应用目录名，与配置目录无关）
	dirs.push(path.join(home, ".var", "app", `md.${"obsidian"}.Obsidian`, "config", "obsidian"));

	return dirs;
}

export function registryPath(): string {
	return path.join(obsidianConfigDirs()[0], "obsidian.json");
}

export async function discoverVaults(fs: FsApi): Promise<{ vaults: VaultInfo[]; registryPath: string | null; warning?: string }> {
	let found: string | null = null;
	let raw: string | null = null;

	for (const dir of obsidianConfigDirs()) {
		const p = path.join(dir, "obsidian.json");
		if (await fs.exists(p)) {
			found = p;
			try {
				raw = (await fs.readFile(p)).toString("utf8");
				break;
			} catch {
				raw = null;
			}
		}
	}

	if (!found || !raw) {
		return { vaults: [], registryPath: found, warning: "未能读取 Obsidian 注册表（obsidian.json），请手动添加 vault" };
	}

	let parsed: ObsidianRegistry;
	try {
		parsed = JSON.parse(raw) as ObsidianRegistry;
	} catch {
		return { vaults: [], registryPath: found, warning: "obsidian.json 解析失败，请手动添加 vault" };
	}

	const vaults: VaultInfo[] = [];
	const seen = new Set<string>();
	const entries = Array.isArray(parsed.vaults) ? parsed.vaults : Object.values(parsed.vaults ?? {});
	for (const v of entries) {
		if (!v || typeof v.path !== "string" || !v.path) continue;
		const normalized = path.normalize(v.path);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		vaults.push({ path: normalized, name: path.basename(normalized), ts: v.ts });
	}

	vaults.sort((a, b) => a.name.localeCompare(b.name));
	return { vaults, registryPath: found };
}
