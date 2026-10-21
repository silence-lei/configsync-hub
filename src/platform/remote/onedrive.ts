/**
 * OneDrive 传输实现（Microsoft Graph）。
 *
 * 文件存放在 OneDrive 的「应用根目录」（通常显示在 OneDrive/应用/… 下），
 * 不会污染你可见的根目录。
 */

import { RemoteConfig, RemoteSnapshotMeta } from "../../core/types";
import { RemoteTransport } from "../../core/remote/types";
import { http, httpBuffer } from "./http";
import { authorize, OAuthClient, refresh } from "./oauth";
import { SnapshotZipName } from "./consts";

const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";

function clientOf(cfg: RemoteConfig): OAuthClient {
	const o = cfg.options ?? {};
	return {
		authorizeUrl: AUTHORIZE_URL,
		tokenUrl: TOKEN_URL,
		clientId: (o["clientId"] || "").trim(),
		scopes: ["Files.ReadWrite", "offline_access"],
		...(o["redirectPort"] ? { redirectPort: Number.parseInt(o["redirectPort"], 10) } : {}),
	};
}

function zipName(cfg: RemoteConfig): string {
	return ((cfg.options?.["path"] || SnapshotZipName).replace(/^\/+/, "") || SnapshotZipName).replace(/\.zip$/, "") + ".zip";
}
function metaName(cfg: RemoteConfig): string {
	return `${zipName(cfg)}.meta.json`;
}
function contentUrl(cfg: RemoteConfig, name: string): string {
	return `${GRAPH}/me/drive/special/approot:/${encodeURIComponent(name)}:/content`;
}

async function withToken(cfg: RemoteConfig, fn: (token: string) => Promise<void>): Promise<void> {
	const o = cfg.options ?? {};
	const access = o["accessToken"];
	if (!access) throw new Error("尚未授权，请先点击「连接 / 授权」");
	try {
		await fn(access);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!/401|403/.test(msg) || !o["refreshToken"]) throw e;
		const tokens = await refresh(clientOf(cfg), o["refreshToken"]);
		o["accessToken"] = tokens.accessToken;
		if (tokens.refreshToken) o["refreshToken"] = tokens.refreshToken;
		await fn(tokens.accessToken);
	}
}

async function putFile(cfg: RemoteConfig, name: string, data: Buffer): Promise<void> {
	await withToken(cfg, async (token) => {
		const res = await http(contentUrl(cfg, name), {
			method: "PUT",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
			body: data,
			timeoutMs: 180000,
		});
		if (!res.ok) throw new Error(`上传失败（HTTP ${res.status}）: ${res.text.slice(0, 200)}`);
	});
}

async function getFile(cfg: RemoteConfig, name: string): Promise<Buffer | null> {
	let result: Buffer | null = null;
	await withToken(cfg, async (token) => {
		const res = await httpBuffer(contentUrl(cfg, name), { headers: { authorization: `Bearer ${token}` }, timeoutMs: 180000 });
		if (res.status === 404) {
			result = null;
			return;
		}
		if (res.status !== 200) throw new Error(`下载失败（HTTP ${res.status}）`);
		result = res.buffer;
	});
	return result;
}

export const oneDriveTransport: RemoteTransport = {
	kind: "onedrive",

	async readMeta(cfg: RemoteConfig): Promise<RemoteSnapshotMeta | null> {
		const raw = await getFile(cfg, metaName(cfg));
		if (!raw) return null;
		try {
			return JSON.parse(raw.toString("utf8")) as RemoteSnapshotMeta;
		} catch {
			return null;
		}
	},

	async download(cfg: RemoteConfig): Promise<{ meta: RemoteSnapshotMeta; data: Buffer }> {
		const meta = await this.readMeta(cfg);
		const data = await getFile(cfg, zipName(cfg));
		if (!data) throw new Error("云端没有找到快照文件");
		return { meta: meta ?? { version: "", updatedAt: new Date().toISOString(), bytes: data.length, fileCount: 0 }, data };
	},

	async upload(cfg: RemoteConfig, snapshot: Buffer, meta: RemoteSnapshotMeta): Promise<void> {
		await putFile(cfg, zipName(cfg), snapshot);
		await putFile(cfg, metaName(cfg), Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
	},

	async test(cfg: RemoteConfig): Promise<void> {
		await withToken(cfg, async (token) => {
			const res = await http(`${GRAPH}/me`, { headers: { authorization: `Bearer ${token}` }, timeoutMs: 20000 });
			if (!res.ok) throw new Error(`连接失败（HTTP ${res.status}）: ${res.text.slice(0, 200)}`);
		});
	},
};

export async function authorizeOneDrive(cfg: RemoteConfig): Promise<void> {
	const client = clientOf(cfg);
	if (!client.clientId) throw new Error("请先填写 Application (client) ID");
	const tokens = await authorize(client);
	cfg.options["accessToken"] = tokens.accessToken;
	if (tokens.refreshToken) cfg.options["refreshToken"] = tokens.refreshToken;
	cfg.options["authorizedAt"] = new Date().toISOString();
}
