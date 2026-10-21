/**
 * 同步引擎：扫描、推送到 Hub、生成计划、执行计划。
 *
 * 只依赖 FsApi 抽象，不依赖任何 Obsidian API（NFR-04 / NFR-05）。
 */

import * as path from "path";
import { FsApi, readJson, writeJson } from "./fs";
import { sha256 } from "./hash";
import { hubBackupDir, hubConfigDir, relToAbs, SELF_DIR_LIST, vaultConfigDir, vaultStatePath } from "./paths";
import { createManifest, loadHubManifest, manifestToMap, saveHubManifest } from "./manifest";
import { LocalFileInfo, PlanSummary, planVault, VaultPlan } from "./planner";
import { createVaultBackup, pruneBackups } from "./backup";
import { Logger, NullLogger } from "./logger";
import { BackupPolicy, FileEntry, FileFingerprint, HubManifest, VaultSyncState, VaultTarget } from "./types";
import { normalizeRel, RuleSet } from "./rules";

/* ------------------------------ 扫描 ------------------------------ */

export interface ScanResult {
	/** 相对路径 → 本地文件信息 */
	info: Map<string, LocalFileInfo>;
	/** 可直接写入 manifest 的条目 */
	entries: FileEntry[];
}

/** 递归扫描某个 `.obsidian` 目录，只保留规则允许同步的文件 */
export async function scanConfigDir(
	fs: FsApi,
	dir: string,
	rules: RuleSet,
	known?: Record<string, FileFingerprint>,
	logger: Logger = new NullLogger()
): Promise<ScanResult> {
	const info = new Map<string, LocalFileInfo>();
	const entries: FileEntry[] = [];

	const walk = async (current: string, prefix: string): Promise<void> => {
		let names: string[];
		try {
			names = await fs.readdir(current);
		} catch (e) {
			logger.warn(`无法读取目录 ${current}: ${String(e)}`);
			return;
		}
		for (const name of names) {
			const abs = path.join(current, name);
			const rel = normalizeRel(prefix ? `${prefix}/${name}` : name);
			const st = await fs.stat(abs);
			if (!st) continue;
			if (st.isDirectory) {
				if (SELF_DIR_LIST.indexOf(name) >= 0 || name === ".git" || name === "node_modules") continue;
				await walk(abs, rel);
				continue;
			}
			if (!st.isFile) continue;
			if (!rules.isSynced(rel)) continue;

			const prior = known ? known[rel] : undefined;
			let hash: string;
			if (prior && prior.s === st.size && prior.m === st.mtimeMs) {
				hash = prior.h;
			} else {
				const data = await fs.readFile(abs);
				hash = await sha256(data);
			}
			info.set(rel, { h: hash, s: st.size, m: st.mtimeMs });
			entries.push({
				path: rel,
				sha256: hash,
				size: st.size,
				mtime: new Date(st.mtimeMs).toISOString(),
			});
		}
	};

	await walk(dir, "");
	entries.sort((a, b) => a.path.localeCompare(b.path));
	return { info, entries };
}

/** 为 plugins/<id>/manifest.json 补上插件版本号 */
export async function annotatePluginVersions(fs: FsApi, hubDir: string, entries: FileEntry[]): Promise<void> {
	for (const e of entries) {
		const m = /^plugins\/([^/]+)\/manifest\.json$/.exec(e.path);
		if (!m) continue;
		try {
			const raw = await fs.readFile(relToAbs(hubDir, e.path));
			const json = JSON.parse(raw.toString("utf8")) as { version?: string };
			if (json.version) e.pluginVersion = json.version;
		} catch {
			/* 忽略解析失败 */
		}
	}
}

/* --------------------------- 推送到 Hub --------------------------- */

export interface PushResult {
	manifest: HubManifest;
	copied: number;
	skipped: number;
	configVersion: string;
}

export async function pushToHub(
	fs: FsApi,
	opts: { hubPath: string; sourceVaultPath: string; rules: RuleSet; sourceVaultName?: string; now?: Date },
	logger: Logger = new NullLogger()
): Promise<PushResult> {
	const { hubPath, sourceVaultPath, rules } = opts;
	if (!hubPath) throw new Error("未设置 Hub 目录");
	const sourceDir = vaultConfigDir(sourceVaultPath);
	if (!(await fs.exists(sourceDir))) throw new Error(`源库没有 .obsidian 目录：${sourceVaultPath}`);

	await fs.mkdirp(hubPath);
	const configDir = hubConfigDir(hubPath);
	await fs.mkdirp(configDir);

	const prev = await loadHubManifest(fs, hubPath);
	const prevMap = prev ? manifestToMap(prev) : new Map<string, FileEntry>();

	const scan = await scanConfigDir(fs, sourceDir, rules, undefined, logger);

	let copied = 0;
	let skipped = 0;
	for (const entry of scan.entries) {
		const prevEntry = prevMap.get(entry.path);
		const dest = relToAbs(configDir, entry.path);
		const destExists = await fs.exists(dest);
		if (prevEntry && prevEntry.sha256 === entry.sha256 && destExists) {
			skipped++;
			continue;
		}
		const data = await fs.readFile(relToAbs(sourceDir, entry.path));
		await fs.mkdirp(path.dirname(dest));
		await fs.writeFileAtomic(dest, data);
		copied++;
	}

	await annotatePluginVersions(fs, configDir, scan.entries);

	const manifest = createManifest(scan.entries, opts.sourceVaultName ?? path.basename(sourceVaultPath), prev?.configVersion, opts.now);
	await saveHubManifest(fs, hubPath, manifest);

	// 保留 manifest 历史，便于追溯 Hub 版本
	if (prev) {
		try {
			await fs.mkdirp(hubBackupDir(hubPath));
			await writeJson(fs, path.join(hubBackupDir(hubPath), `manifest-${prev.configVersion}.json`), prev);
		} catch {
			/* 历史归档失败不影响主流程 */
		}
	}

	logger.info(`已推送 ${copied} 个文件到 Hub，跳过 ${skipped} 个未变更文件，版本 ${manifest.configVersion}`);
	return { manifest, copied, skipped, configVersion: manifest.configVersion };
}

/* ---------------------------- 生成计划 ---------------------------- */

export interface SyncPlan {
	configVersion: string;
	hubFiles: Map<string, FileEntry>;
	plans: VaultPlan[];
	manifest: HubManifest;
}

export async function planSync(
	fs: FsApi,
	opts: { hubPath: string; targets: VaultTarget[]; rules: RuleSet; prune: boolean },
	logger: Logger = new NullLogger()
): Promise<SyncPlan> {
	const manifest = await loadHubManifest(fs, opts.hubPath);
	if (!manifest) throw new Error("Hub 中没有有效的 manifest.json，请先初始化 Hub");

	const hubFiles = new Map<string, FileEntry>();
	for (const f of manifest.files) {
		if (opts.rules.isSynced(f.path)) hubFiles.set(f.path, f);
	}

	const plans: VaultPlan[] = [];
	for (const target of opts.targets) {
		if (!target.enabled) continue;
		const configDir = vaultConfigDir(target.path);
		if (!(await fs.exists(target.path)) || !(await fs.exists(configDir))) {
			plans.push({
				vaultPath: target.path,
				vaultName: target.name,
				changes: [],
				summary: { create: 0, update: 0, delete: 0, skip: 0, bytes: 0 },
				error: "目录不存在或不是 Obsidian vault（缺少 .obsidian）",
			});
			continue;
		}
		const state = (await readJson<VaultSyncState>(fs, vaultStatePath(target.path))) ?? { fileFingerprints: {} };
		const localMap = new Map<string, LocalFileInfo>();
		const scan = await scanConfigDir(fs, configDir, opts.rules, state.fileFingerprints, logger);
		for (const [rel, i] of scan.info) localMap.set(rel, i);

		plans.push(planVault(target.path, target.name, hubFiles, localMap, { prune: opts.prune }));
	}
	return { configVersion: manifest.configVersion, hubFiles, plans, manifest };
}

/* ---------------------------- 执行计划 ---------------------------- */

export type VaultResultStatus = "success" | "failed" | "skipped" | "dry-run";

export interface VaultResult {
	vaultPath: string;
	vaultName: string;
	status: VaultResultStatus;
	summary: PlanSummary;
	error?: string;
	backupPath?: string | null;
	written: number;
}

export interface SyncReport {
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	configVersion: string;
	dryRun: boolean;
	results: VaultResult[];
	totals: { success: number; failed: number; skipped: number; filesWritten: number };
}

export interface ApplyOptions {
	hubPath: string;
	backup: BackupPolicy;
	dryRun: boolean;
	rules: RuleSet;
	logger?: Logger;
}

export async function applyPlan(fs: FsApi, plan: SyncPlan, opts: ApplyOptions): Promise<SyncReport> {
	const logger = opts.logger ?? new NullLogger();
	const startedAt = new Date();
	const startMs = startedAt.getTime();
	const results: VaultResult[] = [];
	const hubDir = hubConfigDir(opts.hubPath);

	for (const vp of plan.plans) {
		const summary = vp.summary;
		const toWrite = summary.create + summary.update;
		const toDelete = summary.delete;

		if (vp.error) {
			results.push({ vaultPath: vp.vaultPath, vaultName: vp.vaultName, status: "failed", summary, error: vp.error, written: 0 });
			logger.error(`[${vp.vaultName}] ${vp.error}`);
			continue;
		}

		if (toWrite === 0 && toDelete === 0) {
			results.push({ vaultPath: vp.vaultPath, vaultName: vp.vaultName, status: "skipped", summary, written: 0 });
			logger.info(`[${vp.vaultName}] 无需同步（${summary.skip} 个文件一致）`);
			continue;
		}

		if (opts.dryRun) {
			results.push({ vaultPath: vp.vaultPath, vaultName: vp.vaultName, status: "dry-run", summary, written: 0 });
			continue;
		}

		try {
			const configDir = vaultConfigDir(vp.vaultPath);
			const affected = vp.changes.filter((c) => c.action !== "skip").map((c) => c.path);

			let backupPath: string | null = null;
			if (opts.backup.enabled) {
				backupPath = await createVaultBackup(fs, {
					vaultPath: vp.vaultPath,
					scope: opts.backup.scope,
					affected,
					rules: opts.rules,
					label: "auto",
					configVersion: plan.configVersion,
				});
				if (backupPath) logger.info(`[${vp.vaultName}] 已备份：${backupPath}`);
			}

			let written = 0;
			for (const change of vp.changes) {
				if (change.action === "skip") continue;
				const abs = relToAbs(configDir, change.path);
				if (change.action === "delete") {
					try {
						await fs.remove(abs);
						written++;
					} catch (e) {
						logger.warn(`[${vp.vaultName}] 删除失败 ${change.path}: ${String(e)}`);
					}
					continue;
				}
				const data = await fs.readFile(relToAbs(hubDir, change.path));
				await fs.mkdirp(path.dirname(abs));
				await fs.writeFileAtomic(abs, data);
				written++;
				logger.debug(`[${vp.vaultName}] ${change.action === "create" ? "新增" : "更新"} ${change.path}`);
			}

			await updateVaultState(fs, vp.vaultPath, vp, plan, logger);

			if (opts.backup.enabled) await pruneBackups(fs, vp.vaultPath, opts.backup.keep);

			results.push({
				vaultPath: vp.vaultPath,
				vaultName: vp.vaultName,
				status: "success",
				summary,
				written,
				...(backupPath !== null ? { backupPath } : {}),
			});
			logger.info(`[${vp.vaultName}] 同步完成：新增 ${summary.create}、更新 ${summary.update}、删除 ${summary.delete}`);
		} catch (e) {
			const message = String(e);
			results.push({ vaultPath: vp.vaultPath, vaultName: vp.vaultName, status: "failed", summary, error: message, written: 0 });
			logger.error(`[${vp.vaultName}] 同步失败：${message}`);
		}
	}

	const finishedAt = new Date();
	const totals = { success: 0, failed: 0, skipped: 0, filesWritten: 0 };
	for (const r of results) {
		if (r.status === "success") totals.success++;
		else if (r.status === "failed") totals.failed++;
		else if (r.status === "skipped") totals.skipped++;
		totals.filesWritten += r.written;
	}

	return {
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		durationMs: finishedAt.getTime() - startMs,
		configVersion: plan.configVersion,
		dryRun: opts.dryRun,
		results,
		totals,
	};
}

async function updateVaultState(fs: FsApi, vaultPath: string, vp: VaultPlan, plan: SyncPlan, logger: Logger): Promise<void> {
	const statePath = vaultStatePath(vaultPath);
	const state: VaultSyncState =
		(await readJson<VaultSyncState>(fs, statePath)) ?? { fileFingerprints: {} };
	const configDir = vaultConfigDir(vaultPath);

	for (const change of vp.changes) {
		if (change.action === "delete") {
			delete state.fileFingerprints[change.path];
			continue;
		}
		const entry = plan.hubFiles.get(change.path);
		if (!entry) continue;

		// 指纹里的 size/mtime 必须记为「本地文件的真实值」，
		// 否则下次比对时快速通道（size+mtime 命中即跳过哈希）永远不生效。
		let size = entry.size;
		let mtimeMs = Date.parse(entry.mtime) || 0;
		const st = await fs.stat(relToAbs(configDir, change.path));
		if (st) {
			size = st.size;
			mtimeMs = st.mtimeMs;
		}
		state.fileFingerprints[change.path] = { h: entry.sha256, s: size, m: mtimeMs };
	}

	state.lastSyncAt = new Date().toISOString();
	state.lastSyncVersion = plan.configVersion;
	try {
		await fs.mkdirp(path.dirname(statePath));
		await writeJson(fs, statePath, state);
	} catch (e) {
		logger.warn(`写入状态文件失败 ${statePath}: ${String(e)}`);
	}
}

/* --------------------------- Hub 健康检查 --------------------------- */

export interface HubHealth {
	ok: boolean;
	level: "ok" | "warn" | "error";
	message: string;
	manifest?: HubManifest;
}

export async function checkHub(fs: FsApi, hubPath: string): Promise<HubHealth> {
	if (!hubPath) return { ok: false, level: "error", message: "尚未设置 Hub 目录" };
	if (!(await fs.exists(hubPath))) return { ok: false, level: "error", message: `Hub 目录不存在：${hubPath}` };

	const manifest = await loadHubManifest(fs, hubPath);
	if (!manifest) {
		const hasConfig = await fs.exists(hubConfigDir(hubPath));
		return {
			ok: false,
			level: hasConfig ? "warn" : "error",
			message: hasConfig ? "Hub 缺少 manifest.json，请重新推送一次" : "Hub 目录为空，请从当前库初始化",
		};
	}

	// 抽查文件是否完整
	const configDir = hubConfigDir(hubPath);
	const sample = manifest.files.slice(0, 30);
	let missing = 0;
	for (const f of sample) {
		if (!(await fs.exists(relToAbs(configDir, f.path)))) missing++;
	}
	if (missing > 0) {
		return {
			ok: false,
			level: "warn",
			message: `抽查 ${sample.length} 个文件中有 ${missing} 个缺失，建议重新推送后再同步`,
			manifest,
		};
	}
	return { ok: true, level: "ok", message: `Hub 正常（${manifest.files.length} 个文件，版本 ${manifest.configVersion}）`, manifest };
}

/** 目标库相对 Hub 的状态（FR-204） */
export type VaultSyncStatus = "consistent" | "behind" | "uninitialized" | "unknown";

export async function vaultStatus(fs: FsApi, vaultPath: string, plan: SyncPlan | null): Promise<VaultSyncStatus> {
	if (!plan) return "unknown";
	const vp = plan.plans.find((p) => p.vaultPath === vaultPath);
	if (!vp) return "unknown";
	if (vp.error) return "uninitialized";
	if (vp.summary.create + vp.summary.update + vp.summary.delete > 0) return "behind";
	return "consistent";
}

/** 判断目录是否为合法 vault（含 .obsidian） */
export async function isValidVault(fs: FsApi, dir: string): Promise<boolean> {
	return (await fs.exists(dir)) && (await fs.exists(vaultConfigDir(dir)));
}
