import * as path from "node:path";
import { FsApi, StatInfo } from "../src/core/fs";

/** 内存文件系统实现，用于在不触碰磁盘的前提下测试同步引擎 */
export class MemoryFs implements FsApi {
	private files = new Map<string, { data: Buffer; mtimeMs: number }>();
	private dirs = new Set<string>(["/"]);
	private clock = 1000;

	private tick(): number {
		return this.clock++;
	}

	private norm(p: string): string {
		return path.normalize(p);
	}

	async exists(p: string): Promise<boolean> {
		const n = this.norm(p);
		return this.files.has(n) || this.dirs.has(n);
	}

	async stat(p: string): Promise<StatInfo | null> {
		const n = this.norm(p);
		const f = this.files.get(n);
		if (f) return { size: f.data.length, mtimeMs: f.mtimeMs, isDirectory: false, isFile: true };
		if (this.dirs.has(n)) return { size: 0, mtimeMs: 0, isDirectory: true, isFile: false };
		return null;
	}

	async readFile(p: string): Promise<Buffer> {
		const f = this.files.get(this.norm(p));
		if (!f) throw new Error(`ENOENT: ${p}`);
		return Buffer.from(f.data);
	}

	async writeFileAtomic(p: string, data: Buffer): Promise<void> {
		const n = this.norm(p);
		await this.mkdirp(path.dirname(n));
		this.files.set(n, { data: Buffer.from(data), mtimeMs: this.tick() });
	}

	async readdir(p: string): Promise<string[]> {
		const n = this.norm(p);
		const names = new Set<string>();
		for (const key of this.files.keys()) {
			if (path.dirname(key) === n) names.add(path.basename(key));
		}
		for (const dir of this.dirs) {
			if (dir === n) continue;
			if (path.dirname(dir) === n) names.add(path.basename(dir));
		}
		return [...names].sort();
	}

	async mkdirp(p: string): Promise<void> {
		const n = this.norm(p);
		let cur = n;
		const parts: string[] = [];
		while (cur && cur !== "/" && !this.dirs.has(cur)) {
			parts.push(cur);
			cur = path.dirname(cur);
		}
		for (const d of parts.reverse()) this.dirs.add(d);
	}

	async remove(p: string): Promise<void> {
		const n = this.norm(p);
		this.files.delete(n);
		this.dirs.delete(n);
	}

	async rename(from: string, to: string): Promise<void> {
		const f = this.files.get(this.norm(from));
		if (!f) throw new Error(`ENOENT: ${from}`);
		this.files.delete(this.norm(from));
		await this.mkdirp(path.dirname(this.norm(to)));
		this.files.set(this.norm(to), f);
	}

	/* 测试辅助方法 */

	seed(relPath: string, content: string | Buffer): void {
		const abs = path.join(this.root, relPath);
		void this.mkdirp(path.dirname(abs));
		this.files.set(abs, {
			data: typeof content === "string" ? Buffer.from(content, "utf8") : content,
			mtimeMs: this.tick(),
		});
	}

	read(relPath: string): string | null {
		const f = this.files.get(path.join(this.root, relPath));
		return f ? f.data.toString("utf8") : null;
	}

	has(relPath: string): boolean {
		return this.files.has(path.join(this.root, relPath));
	}

	listPaths(): string[] {
		return [...this.files.keys()].sort();
	}

	constructor(private readonly root = "/") {
		void this.mkdirp(root);
	}
}
