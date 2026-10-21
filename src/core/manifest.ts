/** Hub 同步清单（manifest.json）的读写与版本管理（FR-103） */

import { FsApi, readJson, writeJson } from "./fs";
import { FileEntry, HubManifest, MANIFEST_SCHEMA_VERSION } from "./types";
import { hubManifestPath } from "./paths";

function todayStamp(d: Date = new Date()): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}.${m}.${day}`;
}

/** 生成下一个配置版本号：`YYYY.MM.DD-n`，同一天递增序号 */
export function nextConfigVersion(prev?: string, now: Date = new Date()): string {
	const stamp = todayStamp(now);
	if (prev && prev.startsWith(stamp + "-")) {
		const n = Number.parseInt(prev.slice(stamp.length + 1), 10);
		if (Number.isFinite(n)) return `${stamp}-${n + 1}`;
	}
	return `${stamp}-1`;
}

export function createManifest(files: FileEntry[], sourceVault?: string, prevVersion?: string, now: Date = new Date()): HubManifest {
	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		configVersion: nextConfigVersion(prevVersion, now),
		updatedAt: now.toISOString(),
		sourceVault,
		files,
	};
}

export async function loadHubManifest(fs: FsApi, hubPath: string): Promise<HubManifest | null> {
	const m = await readJson<HubManifest>(fs, hubManifestPath(hubPath));
	if (!m) return null;
	if (typeof m !== "object" || !Array.isArray(m.files)) return null;
	return m;
}

export async function saveHubManifest(fs: FsApi, hubPath: string, manifest: HubManifest): Promise<void> {
	await writeJson(fs, hubManifestPath(hubPath), manifest);
}

export function manifestToMap(manifest: HubManifest): Map<string, FileEntry> {
	const map = new Map<string, FileEntry>();
	for (const f of manifest.files) map.set(f.path, f);
	return map;
}

export function manifestPluginVersions(manifest: HubManifest): Record<string, string> {
	const out: Record<string, string> = {};
	for (const f of manifest.files) {
		if (f.pluginVersion && /^plugins\/[^/]+\/manifest\.json$/.test(f.path)) {
			out[f.path.split("/")[1]] = f.pluginVersion;
		}
	}
	return out;
}
