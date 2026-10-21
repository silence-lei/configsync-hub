/**
 * WebDAV 传输实现：坚果云 / Nextcloud / ownCloud / Box(WebDAV) 等。
 *
 * 通用性强、无需 OAuth：配好地址、账号与应用密码即可。
 */

import { RemoteConfig, RemoteSnapshotMeta } from "../../core/types";
import { RemoteTransport } from "../../core/remote/types";
import { http, httpBuffer } from "./http";
import { SnapshotZipName } from "./consts";

interface WebDavCfg {
	base: string;
	user: string;
	password: string;
	main: string;
	meta: string;
}

function readCfg(cfg: RemoteConfig): WebDavCfg {
	const o = cfg.options ?? {};
	const base = (o["url"] || "").replace(/\/+$/, "");
	const user = o["user"] || "";
	const password = o["password"] || "";
	if (!base) throw new Error("请填写 WebDAV 地址");
	const main = (o["path"] || SnapshotZipName).replace(/^\/+/, "");
	return { base, user, password, main, meta: `${main}.meta.json` };
}

function authHeader(c: WebDavCfg): Record<string, string> {
	if (!c.user) return {};
	return { authorization: `Basic ${Buffer.from(`${c.user}:${c.password}`).toString("base64")}` };
}

function fileHref(c: WebDavCfg, file: string): string {
	return `${c.base}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

async function ensureCollection(c: WebDavCfg, file: string): Promise<void> {
	const parts = file.split("/");
	parts.pop();
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const res = await http(fileHref(c, current), { method: "MKCOL", headers: authHeader(c), timeoutMs: 20000 });
		// 405 = 已存在，忽略
		if (!res.ok && res.status !== 405 && res.status !== 409) {
			// 部分服务要求 base 末尾带斜杠，忽略失败由后续 PUT 报错兜底
		}
	}
}

export const webdavTransport: RemoteTransport = {
	kind: "webdav",

	async readMeta(cfg: RemoteConfig): Promise<RemoteSnapshotMeta | null> {
		const c = readCfg(cfg);
		const res = await http(fileHref(c, c.meta), { headers: authHeader(c), timeoutMs: 20000 });
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`读取 meta 失败（HTTP ${res.status}）`);
		try {
			return JSON.parse(res.text) as RemoteSnapshotMeta;
		} catch {
			return null;
		}
	},

	async download(cfg: RemoteConfig): Promise<{ meta: RemoteSnapshotMeta; data: Buffer }> {
		const c = readCfg(cfg);
		const meta = await this.readMeta(cfg);
		const res = await httpBuffer(fileHref(c, c.main), { headers: authHeader(c), timeoutMs: 180000 });
		if (res.status === 404) throw new Error("WebDAV 上没有找到快照文件");
		if (res.status !== 200) throw new Error(`下载失败（HTTP ${res.status}）`);
		return {
			meta: meta ?? { version: "", updatedAt: new Date().toISOString(), bytes: res.buffer.length, fileCount: 0 },
			data: res.buffer,
		};
	},

	async upload(cfg: RemoteConfig, snapshot: Buffer, meta: RemoteSnapshotMeta): Promise<void> {
		const c = readCfg(cfg);
		await ensureCollection(c, c.main);
		const putMain = await http(fileHref(c, c.main), {
			method: "PUT",
			headers: { ...authHeader(c), "content-type": "application/zip" },
			body: snapshot,
			timeoutMs: 180000,
		});
		if (!putMain.ok) throw new Error(`上传快照失败（HTTP ${putMain.status}）: ${putMain.text.slice(0, 200)}`);
		const putMeta = await http(fileHref(c, c.meta), {
			method: "PUT",
			headers: { ...authHeader(c), "content-type": "application/json" },
			body: Buffer.from(JSON.stringify(meta, null, 2), "utf8"),
			timeoutMs: 60000,
		});
		if (!putMeta.ok) throw new Error(`上传 meta 失败（HTTP ${putMeta.status}）: ${putMeta.text.slice(0, 200)}`);
	},

	async test(cfg: RemoteConfig): Promise<void> {
		const c = readCfg(cfg);
		const res = await http(`${c.base}/`, { method: "PROPFIND", headers: { ...authHeader(c), depth: "0" }, timeoutMs: 20000 });
		if (res.status === 401) throw new Error("账号或密码错误（HTTP 401）");
		if (!res.ok && res.status !== 404) throw new Error(`连接失败（HTTP ${res.status}）: ${res.text.slice(0, 160)}`);
	},
};
