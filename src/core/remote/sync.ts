/**
 * Hub 快照 ⇄ 远端 的编排层（FR-8xx：跨端同步）。
 *
 * 远端只搬运两份东西：
 * - `configsync-hub.zip`：Hub 的 `config/` 目录 + `manifest.json`
 * - `configsync-hub.meta.json`：版本 / 时间 / 体积，下载前先比版本，避免无谓流量
 *
 * 本文件只依赖 FsApi 与自研 zip，不依赖任何云平台实现，可离线单测。
 */

import * as path from "path";
import { FsApi } from "../fs";
import { createZip, readZip, ZipEntryInput } from "../zip";
import { hubConfigDir, hubManifestPath, MANIFEST_NAME } from "../paths";
import { HubManifest, RemoteConfig, RemoteSnapshotMeta } from "../types";
import { loadHubManifest } from "../manifest";
import { normalizeRel } from "../rules";
import { RemoteComparison, RemoteTransport } from "./types";

export const SNAPSHOT_NAME = "configsync-hub.zip";
export const REMOTE_META_NAME = "configsync-hub.meta.json";
/** 远端/本地的临时与归档目录（位于 Hub 内，不进同步范围） */
export const REMOTE_CACHE_DIR = "remote-cache";
export const REMOTE_BACKUP_DIR = "remote-backups";

function remoteMetaPath(hubPath: string): string {
	return path.join(hubPath, REMOTE_CACHE_DIR, REMOTE_META_NAME);
}

function timestamp(d: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ------------------------------ 打包 ------------------------------ */

/** 收集 Hub 里需要打包的文件（相对 Hub 根目录的路径 → 绝对路径） */
async function collectHubFiles(fs: FsApi, hubPath: string): Promise<{ rel: string; abs: string }[]> {
	const out: { rel: string; abs: string }[] = [];
	const roots = [
		{ prefix: "config", dir: hubConfigDir(hubPath) },
		{ prefix: "", dir: hubPath },
	];
	for (const root of roots) {
		if (!(await fs.exists(root.dir))) continue;
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
				if (!root.prefix && name !== MANIFEST_NAME) continue;
				if (name === REMOTE_CACHE_DIR || name === REMOTE_BACKUP_DIR || name === "backups") continue;
				const st = await fs.stat(abs);
				if (!st) continue;
				if (st.isDirectory) {
					await walk(abs, rel);
					continue;
				}
				if (!st.isFile) continue;
				out.push({ rel, abs });
			}
		};
		await walk(root.dir, root.prefix);
	}
	return out;
}

export interface HubSnapshot {
	snapshot: Buffer;
	meta: RemoteSnapshotMeta;
	fileCount: number;
}

/** 把 Hub 打包成快照 + meta */
export async function packHubSnapshot(fs: FsApi, hubPath: string): Promise<HubSnapshot> {
	if (!hubPath) throw new Error("未设置 Hub 目录");
	const manifest = await loadHubManifest(fs, hubPath);
	if (!manifest) throw new Error("Hub 中没有有效的 manifest.json，请先初始化 Hub");

	const files = await collectHubFiles(fs, hubPath);
	if (!files.length) throw new Error("Hub 为空，无法生成快照");

	const entries: ZipEntryInput[] = [];
	for (const f of files) {
		try {
			entries.push({ name: f.rel, data: await fs.readFile(f.abs) });
		} catch {
			/* 单文件失败不阻断 */
		}
	}
	const snapshot = createZip(entries);
	const meta: RemoteSnapshotMeta = {
		version: manifest.configVersion,
		updatedAt: manifest.updatedAt,
		bytes: snapshot.length,
		fileCount: entries.length,
		...(manifest.sourceVault ? { sourceVault: manifest.sourceVault } : {}),
	};
	return { snapshot, meta, fileCount: entries.length };
}

export interface UnpackResult {
	written: number;
	removed: number;
	version: string;
}

/**
 * 把远端快照写回本地 Hub。
 * @param clean 是否清理 zip 中不存在的旧文件（保证本地 Hub 与远端一致）
 */
export async function unpackHubSnapshot(
	fs: FsApi,
	hubPath: string,
	data: Buffer,
	opts: { clean?: boolean } = {}
): Promise<UnpackResult> {
	const entries = readZip(data);
	if (!entries.length) throw new Error("远端快照为空或格式错误");
	const clean = opts.clean !== false;

	let written = 0;
	let version = "";
	const incoming = new Set<string>();
	for (const e of entries) {
		const rel = normalizeRel(e.name);
		if (rel === REMOTE_META_NAME) continue;
		incoming.add(rel);
		const abs = path.join(hubPath, ...rel.split("/"));
		await fs.mkdirp(path.dirname(abs));
		await fs.writeFileAtomic(abs, e.data);
		written++;
		if (rel === MANIFEST_NAME) {
			try {
				version = (JSON.parse(e.data.toString("utf8")) as HubManifest).configVersion ?? "";
			} catch {
				/* 忽略 */
			}
		}
	}

	let removed = 0;
	if (clean) {
		const existing = await collectHubFiles(fs, hubPath);
		for (const f of existing) {
			if (incoming.has(f.rel)) continue;
			try {
				await fs.remove(f.abs);
				removed++;
			} catch {
				/* 忽略删除失败 */
			}
		}
	}

	if (!version) {
		const manifest = await loadHubManifest(fs, hubPath);
		version = manifest?.configVersion ?? "";
	}
	return { written, removed, version };
}

/** 拉取前备份本地 Hub 目录（config + manifest.json） */
export async function backupHub(fs: FsApi, hubPath: string): Promise<string | null> {
	const files = await collectHubFiles(fs, hubPath);
	if (!files.length) return null;
	const entries: ZipEntryInput[] = [];
	for (const f of files) {
		try {
			entries.push({ name: f.rel, data: await fs.readFile(f.abs) });
		} catch {
			/* 忽略 */
		}
	}
	const dir = path.join(hubPath, REMOTE_BACKUP_DIR);
	await fs.mkdirp(dir);
	let zipPath = path.join(dir, `hub-${timestamp()}.zip`);
	let n = 1;
	while (await fs.exists(zipPath)) {
		n++;
		zipPath = path.join(dir, `hub-${timestamp()}-${n}.zip`);
	}
	await fs.writeFileAtomic(zipPath, createZip(entries));
	return zipPath;
}

/** 清理 Hub 备份目录里的旧备份，保留最近 keep 份 */
export async function pruneHubBackups(fs: FsApi, hubPath: string, keep: number): Promise<number> {
	if (keep <= 0) return 0;
	const dir = path.join(hubPath, REMOTE_BACKUP_DIR);
	if (!(await fs.exists(dir))) return 0;
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return 0;
	}
	const items: { abs: string; mtimeMs: number }[] = [];
	for (const name of names) {
		if (!name.endsWith(".zip")) continue;
		const abs = path.join(dir, name);
		const st = await fs.stat(abs);
		if (st && st.isFile) items.push({ abs, mtimeMs: st.mtimeMs });
	}
	items.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const doomed = items.slice(keep);
	for (const it of doomed) {
		try {
			await fs.remove(it.abs);
		} catch {
			/* 忽略 */
		}
	}
	return doomed.length;
}

/* --------------------------- 上传 / 下载 --------------------------- */

export interface RemotePlan {
	comparison: RemoteComparison;
	localVersion?: string;
	remoteMeta: RemoteSnapshotMeta | null;
}

/** 对比本地 Hub 与远端版本（不下载快照） */
export async function planRemote(fs: FsApi, transport: RemoteTransport, cfg: RemoteConfig, hubPath: string): Promise<RemotePlan> {
	const local = await loadHubManifest(fs, hubPath);
	const remoteMeta = await transport.readMeta(cfg);
	return {
		comparison: compare(local?.configVersion, remoteMeta?.version),
		localVersion: local?.configVersion,
		remoteMeta,
	};
}

function compare(local?: string, remote?: string): RemoteComparison {
	if (!remote) return "empty";
	if (!local) return "remote-newer";
	if (local === remote) return "same";
	return remote > local ? "remote-newer" : "local-newer";
}

export interface RemotePushResult {
	version: string;
	bytes: number;
	fileCount: number;
}

/** 打包本地 Hub 并推送到远端 */
export async function pushToRemote(
	fs: FsApi,
	transport: RemoteTransport,
	cfg: RemoteConfig,
	hubPath: string
): Promise<RemotePushResult> {
	const packed = await packHubSnapshot(fs, hubPath);
	await transport.upload(cfg, packed.snapshot, packed.meta);
	// meta 同时缓存到本地，便于离线查看远端状态
	await fs.mkdirp(path.dirname(remoteMetaPath(hubPath)));
	await fs.writeFileAtomic(remoteMetaPath(hubPath), Buffer.from(JSON.stringify(packed.meta, null, 2), "utf8"));
	return { version: packed.meta.version, bytes: packed.meta.bytes, fileCount: packed.fileCount };
}

export interface RemotePullResult {
	version: string;
	written: number;
	removed: number;
	comparison: RemoteComparison;
	backupPath?: string | null;
}

/** 从远端拉取并覆盖本地 Hub */
export async function pullFromRemote(
	fs: FsApi,
	transport: RemoteTransport,
	cfg: RemoteConfig,
	hubPath: string,
	opts: { backup?: boolean; clean?: boolean; force?: boolean; keepBackups?: number } = {}
): Promise<RemotePullResult> {
	const plan = await planRemote(fs, transport, cfg, hubPath);
	if (plan.comparison === "empty") throw new Error("远端还没有快照，请先从本机推送一次");
	if (plan.comparison === "same" && !opts.force) {
		return { version: plan.remoteMeta?.version ?? "", written: 0, removed: 0, comparison: "same" };
	}

	const downloaded = await transport.download(cfg);
	let backupPath: string | null = null;
	if (opts.backup !== false) backupPath = await backupHub(fs, hubPath);

	const res = await unpackHubSnapshot(fs, hubPath, downloaded.data, { clean: opts.clean !== false });

	if (opts.keepBackups && opts.keepBackups > 0) await pruneHubBackups(fs, hubPath, opts.keepBackups);

	await fs.mkdirp(path.dirname(remoteMetaPath(hubPath)));
	await fs.writeFileAtomic(remoteMetaPath(hubPath), Buffer.from(JSON.stringify(downloaded.meta, null, 2), "utf8"));

	return {
		version: res.version || downloaded.meta.version,
		written: res.written,
		removed: res.removed,
		comparison: plan.comparison,
		...(backupPath !== null ? { backupPath } : {}),
	};
}

/** 读取本地缓存的远端 meta（上次推送/拉取的快照信息） */
export async function readCachedRemoteMeta(fs: FsApi, hubPath: string): Promise<RemoteSnapshotMeta | null> {
	const p = remoteMetaPath(hubPath);
	if (!(await fs.exists(p))) return null;
	try {
		return JSON.parse((await fs.readFile(p)).toString("utf8")) as RemoteSnapshotMeta;
	} catch {
		return null;
	}
}

export { hubManifestPath };
