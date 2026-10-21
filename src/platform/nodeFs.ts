/** 基于 Node `fs` 的 FsApi 实现（桌面端） */

import { promises as fsp } from "fs";
import * as path from "path";
import { FsApi, StatInfo } from "../core/fs";

function tmpName(p: string): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `${p}.cstmp-${Date.now()}-${rand}`;
}

export const nodeFs: FsApi = {
	async exists(p: string): Promise<boolean> {
		try {
			await fsp.access(p);
			return true;
		} catch {
			return false;
		}
	},

	async stat(p: string): Promise<StatInfo | null> {
		try {
			const s = await fsp.stat(p);
			return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory(), isFile: s.isFile() };
		} catch {
			return null;
		}
	},

	async readFile(p: string): Promise<Buffer> {
		return fsp.readFile(p);
	},

	/** 临时文件 + rename，保证原子性（NFR-02） */
	async writeFileAtomic(p: string, data: Buffer): Promise<void> {
		await fsp.mkdir(path.dirname(p), { recursive: true });
		const tmp = tmpName(p);
		await fsp.writeFile(tmp, data);
		try {
			await fsp.rename(tmp, p);
		} catch (e) {
			try {
				await fsp.unlink(tmp);
			} catch {
				/* 忽略 */
			}
			throw e;
		}
	},

	async readdir(p: string): Promise<string[]> {
		try {
			return await fsp.readdir(p);
		} catch {
			return [];
		}
	},

	async mkdirp(p: string): Promise<void> {
		await fsp.mkdir(p, { recursive: true });
	},

	async remove(p: string): Promise<void> {
		await fsp.rm(p, { force: true, recursive: true });
	},

	async rename(from: string, to: string): Promise<void> {
		await fsp.rename(from, to);
	},
};
