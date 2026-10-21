/**
 * 备份与恢复（FR-501~505）。
 *
 * - 目标库同步前自动打包备份到 `<vault>/.obsidian/configsync-hub-backups/`
 * - 支持按保留份数清理、一键恢复、导出/导入 zip
 */

import * as path from "path";
import { FsApi, readJson, writeJson } from "./fs";
import { BackupPolicy, FileEntry, FileFingerprint, VaultSyncState } from "./types";
import { BACKUP_DIR_NAME, OBSIDIAN_DIR, relToAbs, vaultBackupDir, vaultConfigDir, vaultStatePath } from "./paths";
import { createZip, readZip, ZipEntryInput } from "./zip";
import { isNeverSynced, normalizeRel, RuleSet, SELF_STATE_DIR } from "./rules";
import { sha256 } from "./hash";

export interface BackupInfo {
	name: string;
	absPath: string;
	size: number;
	mtimeMs: number;
}

const META_NAME = "_configsync-hub-meta.json";

function timestamp(d: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 收集要打包的文件（相对路径 → 绝对路径） */
async function collectFiles(fs: FsApi, rootDir: string, filter: (rel: string) => boolean): Promise<{ rel: string; abs: string }[]> {
	const out: { rel: string; abs: string }[] = [];
	const walk = async (dir: string, prefix: string): Promise<void> => {
		let names: string[];
		try {
			names = await fs.readdir(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const abs = path.join(dir, name);
			const rel = normalizeRel(prefix ? `${prefix}/${name}` : name);
			const st = await fs.stat(abs);
			if (!st) continue;
			if (st.isDirectory) {
				if (name === BACKUP_DIR_NAME || name === SELF_STATE_DIR || name === ".git") continue;
				await walk(abs, rel);
			} else if (st.isFile) {
				if (filter(rel)) out.push({ rel, abs });
			}
		}
	};
	await walk(rootDir, "");
	return out;
}

async function readEntries(fs: FsApi, rootDir: string, files: { rel: string; abs: string }[]): Promise<ZipEntryInput[]> {
	const entries: ZipEntryInput[] = [];
	for (const f of files) {
		try {
			entries.push({ name: f.rel, data: await fs.readFile(f.abs) });
		} catch {
			/* 单文件读取失败不阻断备份 */
		}
	}
	return entries;
}

export interface CreateBackupOptions {
	vaultPath: string;
	/** 备份范围：full = 整个 .obsidian；affected = 仅传入的文件 */
	scope: BackupPolicy["scope"];
	/** scope=affected 时的文件清单 */
	affected?: string[];
	rules?: RuleSet;
	label?: string;
	configVersion?: string;
}

export async function createVaultBackup(fs: FsApi, opts: CreateBackupOptions): Promise<string | null> {
	const configDir = vaultConfigDir(opts.vaultPath);
	if (!(await fs.exists(configDir))) return null;

	let files: { rel: string; abs: string }[];
	if (opts.scope === "full") {
		files = await collectFiles(fs, configDir, (rel) => !isNeverSynced(rel) || rel.startsWith("workspace"));
	} else {
		const rels = new Set((opts.affected ?? []).map(normalizeRel));
		if (!rels.size) return null;
		files = (await collectFiles(fs, configDir, (rel) => rels.has(rel))).filter((f) => rels.has(f.rel));
	}
	if (!files.length) return null;

	const meta = {
		createdAt: new Date().toISOString(),
		vaultPath: opts.vaultPath,
		vaultName: path.basename(opts.vaultPath),
		scope: opts.scope,
		label: opts.label ?? "auto",
		configVersion: opts.configVersion ?? "",
		fileCount: files.length,
	};
	const entries = await readEntries(fs, configDir, files);
	entries.push({ name: META_NAME, data: Buffer.from(JSON.stringify(meta, null, 2), "utf8") });

	const dir = vaultBackupDir(opts.vaultPath);
	await fs.mkdirp(dir);
	const base = `backup-${timestamp()}${opts.label ? `-${opts.label}` : ""}`;
	// 同一秒内的两次同步不能相互覆盖备份
	let zipPath = path.join(dir, `${base}.zip`);
	let n = 1;
	while (await fs.exists(zipPath)) {
		n++;
		zipPath = path.join(dir, `${base}-${n}.zip`);
	}
	await fs.writeFileAtomic(zipPath, createZip(entries));
	return zipPath;
}

export async function listBackups(fs: FsApi, vaultPath: string): Promise<BackupInfo[]> {
	const dir = vaultBackupDir(vaultPath);
	if (!(await fs.exists(dir))) return [];
	const names = await fs.readdir(dir);
	const out: BackupInfo[] = [];
	for (const name of names) {
		if (!name.endsWith(".zip")) continue;
		const absPath = path.join(dir, name);
		const st = await fs.stat(absPath);
		if (!st || !st.isFile) continue;
		out.push({ name, absPath, size: st.size, mtimeMs: st.mtimeMs });
	}
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out;
}

/** 保留最近 keep 份，返回被删除的数量 */
export async function pruneBackups(fs: FsApi, vaultPath: string, keep: number): Promise<number> {
	if (keep <= 0) return 0;
	const all = await listBackups(fs, vaultPath);
	const doomed = all.slice(keep);
	for (const b of doomed) {
		try {
			await fs.remove(b.absPath);
		} catch {
			/* 忽略删除失败 */
		}
	}
	return doomed.length;
}

export interface RestoreResult {
	restored: number;
	failed: string[];
	backupOfCurrent?: string | null;
}

/** 从备份 zip 恢复；恢复前同样先备份当前状态（FR-503） */
export async function restoreBackup(
	fs: FsApi,
	opts: {
		vaultPath: string;
		zipPath: string;
		backupBefore?: boolean;
		backupPolicy?: BackupPolicy;
		rules?: RuleSet;
		/** 删除备份之后新增的文件（时间点还原） */
		deleteExtraneous?: boolean;
	}
): Promise<RestoreResult> {
	const zipBuf = await fs.readFile(opts.zipPath);
	const entries = readZip(zipBuf).filter((e) => e.name !== META_NAME);
	const configDir = vaultConfigDir(opts.vaultPath);

	let backupOfCurrent: string | null = null;
	if (opts.backupBefore !== false) {
		backupOfCurrent = await createVaultBackup(fs, {
			vaultPath: opts.vaultPath,
			scope: "affected",
			affected: entries.map((e) => e.name),
			label: "pre-restore",
			...(opts.backupPolicy ? { scope: opts.backupPolicy.scope } : {}),
		});
	}

	const failed: string[] = [];
	let restored = 0;
	const inZip = new Set<string>();
	for (const e of entries) {
		const rel = normalizeRel(e.name);
		if (!rel || rel.startsWith("_")) continue;
		inZip.add(rel);
		try {
			const abs = relToAbs(configDir, rel);
			await fs.mkdirp(path.dirname(abs));
			await fs.writeFileAtomic(abs, e.data);
			restored++;
		} catch {
			failed.push(rel);
		}
	}

	if (opts.deleteExtraneous) {
		const removable = await collectFiles(fs, configDir, (rel) => !isNeverSynced(rel) || rel.startsWith("workspace"));
		for (const f of removable) {
			if (inZip.has(f.rel)) continue;
			try {
				await fs.remove(f.abs);
			} catch {
				failed.push(f.rel);
			}
		}
	}

	// 恢复后本地指纹已不可信，清空以便下次同步重新哈希
	await resetVaultState(fs, opts.vaultPath);

	return { restored, failed, backupOfCurrent };
}

/** 清空本地同步指纹 */
export async function resetVaultState(fs: FsApi, vaultPath: string): Promise<void> {
	const p = vaultStatePath(vaultPath);
	const current = await readJson<VaultSyncState>(fs, p);
	await writeJson(fs, p, {
		...(current ?? {}),
		fileFingerprints: {},
		lastSyncAt: new Date().toISOString(),
	} as VaultSyncState);
}

/* --------------------------- 导出 / 导入 --------------------------- */

/** 导出某个 .obsidian 为 zip（FR-504） */
export async function exportConfigZip(
	fs: FsApi,
	opts: { sourceVaultPath: string; outZipPath: string; rules?: RuleSet; files?: FileEntry[] }
): Promise<number> {
	const configDir = vaultConfigDir(opts.sourceVaultPath);
	let files: { rel: string; abs: string }[];
	if (opts.files && opts.files.length) {
		const wanted = new Set(opts.files.map((f) => normalizeRel(f.path)));
		files = await collectFiles(fs, configDir, (rel) => wanted.has(rel));
	} else if (opts.rules) {
		const rules = opts.rules;
		files = await collectFiles(fs, configDir, (rel) => rules.isSynced(rel));
	} else {
		files = await collectFiles(fs, configDir, (rel) => !isNeverSynced(rel));
	}
	const entries = await readEntries(fs, configDir, files);
	await fs.mkdirp(path.dirname(opts.outZipPath));
	await fs.writeFileAtomic(opts.outZipPath, createZip(entries));
	return entries.length;
}

/** 从 zip 导入配置到某个 vault（FR-505） */
export async function importConfigZip(
	fs: FsApi,
	opts: { zipPath: string; targetVaultPath: string; rules?: RuleSet; backupBefore?: boolean }
): Promise<RestoreResult> {
	return restoreBackup(fs, {
		vaultPath: opts.targetVaultPath,
		zipPath: opts.zipPath,
		backupBefore: opts.backupBefore !== false,
	});
}

/** 读取备份 zip 的元信息 */
export async function readBackupMeta(fs: FsApi, zipPath: string): Promise<Record<string, unknown> | null> {
	try {
		const entries = readZip(await fs.readFile(zipPath));
		const meta = entries.find((e) => e.name === META_NAME);
		if (!meta) return null;
		return JSON.parse(meta.data.toString("utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** 目标库 .obsidian 里所有「参与同步范围内」的文件（用于状态展示） */
export async function scanVaultFingerprints(
	fs: FsApi,
	vaultPath: string,
	rules: RuleSet,
	known?: Record<string, FileFingerprint>
): Promise<Record<string, FileFingerprint>> {
	const configDir = path.join(vaultPath, OBSIDIAN_DIR);
	const files = await collectFiles(fs, configDir, (rel) => rules.isSynced(rel));
	const out: Record<string, FileFingerprint> = {};
	for (const f of files) {
		const st = await fs.stat(f.abs);
		if (!st) continue;
		const prior = known?.[f.rel];
		if (prior && prior.s === st.size && prior.m === st.mtimeMs) {
			out[f.rel] = prior;
			continue;
		}
		out[f.rel] = { h: await sha256(await fs.readFile(f.abs)), s: st.size, m: st.mtimeMs };
	}
	return out;
}
