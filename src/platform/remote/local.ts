/**
 * 本地目录 / 同步盘传输实现。
 *
 * 适用于 iCloud Drive、Dropbox、OneDrive、坚果云等桌面客户端已同步到本地的目录：
 * 插件直接写文件，由各家客户端负责上云。
 */

import * as nodeFs from "fs";
import * as path from "path";
import { RemoteConfig, RemoteSnapshotMeta } from "../../core/types";
import { RemoteTransport } from "../../core/remote/types";
import { SnapshotZipName } from "./consts";

function paths(cfg: RemoteConfig): { dir: string; main: string; meta: string } {
	const file = (cfg.options?.["path"] || SnapshotZipName).replace(/^\/+/, "");
	const dirRaw = (cfg.options?.["dir"] || "").trim();
	if (!dirRaw) throw new Error("请填写本地目录（也可以是网盘客户端的同步目录）");
	const dir = path.resolve(dirRaw);
	return { dir, main: path.join(dir, file), meta: path.join(dir, `${file}.meta.json`) };
}

function ensureDir(dir: string): void {
	if (!nodeFs.existsSync(dir)) nodeFs.mkdirSync(dir, { recursive: true });
}

export const localTransport: RemoteTransport = {
	kind: "local",

	async readMeta(cfg: RemoteConfig): Promise<RemoteSnapshotMeta | null> {
		const p = paths(cfg);
		if (!nodeFs.existsSync(p.meta)) return null;
		try {
			return JSON.parse(nodeFs.readFileSync(p.meta, "utf8")) as RemoteSnapshotMeta;
		} catch {
			return null;
		}
	},

	async download(cfg: RemoteConfig): Promise<{ meta: RemoteSnapshotMeta; data: Buffer }> {
		const p = paths(cfg);
		if (!nodeFs.existsSync(p.main)) throw new Error(`该目录下没有快照文件：${p.main}`);
		const data = nodeFs.readFileSync(p.main);
		const meta = (await this.readMeta(cfg)) ?? {
			version: "",
			updatedAt: new Date().toISOString(),
			bytes: data.length,
			fileCount: 0,
		};
		return { meta, data };
	},

	async upload(cfg: RemoteConfig, snapshot: Buffer, meta: RemoteSnapshotMeta): Promise<void> {
		const p = paths(cfg);
		ensureDir(p.dir);
		nodeFs.writeFileSync(p.main + ".tmp", snapshot);
		nodeFs.renameSync(p.main + ".tmp", p.main);
		nodeFs.writeFileSync(p.meta, JSON.stringify(meta, null, 2), "utf8");
	},

	async test(cfg: RemoteConfig): Promise<void> {
		const p = paths(cfg);
		if (!nodeFs.existsSync(p.dir)) throw new Error(`目录不存在：${p.dir}`);
		// 写个临时文件确认有写权限
		const probe = path.join(p.dir, ".configsync-hub-probe");
		nodeFs.writeFileSync(probe, "ok", "utf8");
		nodeFs.unlinkSync(probe);
	},
};
