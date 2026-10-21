/**
 * 文件系统抽象层。
 *
 * 核心同步逻辑只依赖这个接口，不直接触碰 `fs` 模块，
 * 这样既方便单元测试（可用内存实现），也让未来替换平台实现只改一处（NFR-04）。
 */

export interface StatInfo {
	size: number;
	mtimeMs: number;
	isDirectory: boolean;
	isFile: boolean;
}

export interface FsApi {
	exists(p: string): Promise<boolean>;
	stat(p: string): Promise<StatInfo | null>;
	readFile(p: string): Promise<Buffer>;
	/** 原子写入：先写临时文件再 rename，避免中断产生半成品（NFR-02） */
	writeFileAtomic(p: string, data: Buffer): Promise<void>;
	/** 列出直接子项名称 */
	readdir(p: string): Promise<string[]>;
	mkdirp(p: string): Promise<void>;
	/** 删除文件或空目录 */
	remove(p: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

export async function readJson<T>(fs: FsApi, p: string): Promise<T | null> {
	if (!(await fs.exists(p))) return null;
	try {
		const raw = await fs.readFile(p);
		return JSON.parse(raw.toString("utf8")) as T;
	} catch {
		return null;
	}
}

export async function writeJson(fs: FsApi, p: string, value: unknown): Promise<void> {
	const text = JSON.stringify(value, null, 2);
	await fs.writeFileAtomic(p, Buffer.from(text, "utf8"));
}

export async function pathExists(fs: FsApi, p: string): Promise<boolean> {
	return fs.exists(p);
}
