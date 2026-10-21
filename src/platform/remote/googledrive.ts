/**
 * Google Drive 传输实现。
 *
 * 默认存放在 Drive 的「应用数据」隐藏空间（AppDataFolder），不污染你可见的网盘；
 * 也可以在配置里填一个文件夹 ID，直接放到你自己的 Drive 目录。
 */

import { RemoteConfig, RemoteSnapshotMeta } from "../../core/types";
import { RemoteTransport } from "../../core/remote/types";
import { http, httpBuffer } from "./http";
import { authorize, OAuthClient, refresh } from "./oauth";
import { SnapshotZipName } from "./consts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const SCOPES = ["https://www.googleapis.com/auth/drive.appdata"];

function clientOf(cfg: RemoteConfig): OAuthClient {
	const o = cfg.options ?? {};
	return {
		authorizeUrl: AUTH_URL,
		tokenUrl: TOKEN_URL,
		clientId: (o["clientId"] || "").trim(),
		...(o["clientSecret"] ? { clientSecret: o["clientSecret"] } : {}),
		scopes: SCOPES,
		extraAuthParams: { access_type: "offline", prompt: "consent" },
		...(o["redirectPort"] ? { redirectPort: Number.parseInt(o["redirectPort"], 10) } : {}),
	};
}

function metaName(cfg: RemoteConfig): string {
	return `${(cfg.options?.["path"] || SnapshotZipName).replace(/^\/+/, "")}.meta.json`;
}
function zipName(cfg: RemoteConfig): string {
	return (cfg.options?.["path"] || SnapshotZipName).replace(/^\/+/, "");
}

/** 有 token 就用，必要时用 refresh token 续期并把新 token 写回 cfg */
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

async function findByName(cfg: RemoteConfig, token: string, name: string, folderId: string | null): Promise<string | null> {
	const space = folderId ? "" : `spaces=appDataFolder&`;
	const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}'`);
	const url = `${API}/files?${space}q=${q}&fields=files(id,name)&pageSize=5`;
	const res = await http(url, { headers: { authorization: `Bearer ${token}` }, timeoutMs: 20000 });
	if (!res.ok) throw new Error(`查询云端文件失败（HTTP ${res.status}）: ${res.text.slice(0, 200)}`);
	const json = res.json() as { files?: { id: string; name: string }[] };
	return json.files?.[0]?.id ?? null;
}

function buildMultipart(meta: Record<string, unknown>, content: Buffer, contentType: string): { body: Buffer; boundary: string } {
	const boundary = `----configsync-hub-${Date.now().toString(16)}`;
	const head = Buffer.from(
		`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
			`--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`,
		"utf8"
	);
	const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
	return { body: Buffer.concat([head, content, tail]), boundary };
}

async function putFile(cfg: RemoteConfig, name: string, data: Buffer, contentType: string): Promise<void> {
	await withToken(cfg, async (token) => {
		const folderId = (cfg.options?.["folderId"] || "").trim() || null;
		const existing = await findByName(cfg, token, name, folderId);
		const metadata: Record<string, unknown> = { name };
		if (!existing && folderId) metadata["parents"] = [folderId];
		else if (!existing) metadata["parents"] = ["appDataFolder"];
		const { body, boundary } = buildMultipart(metadata, data, contentType);
		const url = existing ? `${UPLOAD}/${existing}?uploadType=multipart` : `${UPLOAD}?uploadType=multipart`;
		const res = await http(url, {
			method: existing ? "PATCH" : "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
			body,
			timeoutMs: 180000,
		});
		if (!res.ok) throw new Error(`上传失败（HTTP ${res.status}）: ${res.text.slice(0, 200)}`);
	});
}

async function getFile(cfg: RemoteConfig, name: string): Promise<Buffer | null> {
	let result: Buffer | null = null;
	await withToken(cfg, async (token) => {
		const folderId = (cfg.options?.["folderId"] || "").trim() || null;
		const id = await findByName(cfg, token, name, folderId);
		if (!id) {
			result = null;
			return;
		}
		const res = await httpBuffer(`${API}/files/${id}?alt=media`, { headers: { authorization: `Bearer ${token}` }, timeoutMs: 180000 });
		if (res.status !== 200) throw new Error(`下载失败（HTTP ${res.status}）`);
		result = res.buffer;
	});
	return result;
}

export const googleDriveTransport: RemoteTransport = {
	kind: "googledrive",

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
		return {
			meta: meta ?? { version: "", updatedAt: new Date().toISOString(), bytes: data.length, fileCount: 0 },
			data,
		};
	},

	async upload(cfg: RemoteConfig, snapshot: Buffer, meta: RemoteSnapshotMeta): Promise<void> {
		await putFile(cfg, zipName(cfg), snapshot, "application/zip");
		await putFile(cfg, metaName(cfg), Buffer.from(JSON.stringify(meta, null, 2), "utf8"), "application/json");
	},

	async test(cfg: RemoteConfig): Promise<void> {
		await withToken(cfg, async (token) => {
			const res = await http(`${API}/files?spaces=appDataFolder&pageSize=1&fields=files(id)`, {
				headers: { authorization: `Bearer ${token}` },
				timeoutMs: 20000,
			});
			if (!res.ok) throw new Error(`连接失败（HTTP ${res.status}）: ${res.text.slice(0, 200)}`);
		});
	},
};

/** 触发 OAuth 授权并把 token 写回 cfg.options */
export async function authorizeGoogleDrive(cfg: RemoteConfig): Promise<void> {
	const client = clientOf(cfg);
	if (!client.clientId) throw new Error("请先填写 OAuth Client ID");
	const tokens = await authorize(client);
	cfg.options["accessToken"] = tokens.accessToken;
	if (tokens.refreshToken) cfg.options["refreshToken"] = tokens.refreshToken;
	cfg.options["authorizedAt"] = new Date().toISOString();
}

