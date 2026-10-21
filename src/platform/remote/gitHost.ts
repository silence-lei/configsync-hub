/**
 * Git 托管平台传输实现：GitHub / GitLab / Gitea（含自托管实例）。
 *
 * 云端只存两个文件：快照 zip 与同名 `.meta.json`，通过 Contents API 读写，
 * 因此不需要本机安装 git。
 */

import { RemoteConfig, RemoteKind, RemoteSnapshotMeta } from "../../core/types";
import { RemoteTransport } from "../../core/remote/types";
import { SnapshotZipName, REMOTE_META_NAME } from "./consts";
import { http, httpBuffer, requireOk } from "./http";

export type GitHostKind = "github" | "gitlab" | "gitea";

/** 快照文件名可能与 meta 同目录，这里统一由 cfg.options.path 决定 */
function mainFileName(cfg: RemoteConfig): string {
	return (cfg.options?.["path"] || SnapshotZipName).replace(/^\/+/, "");
}
function metaFileName(cfg: RemoteConfig): string {
	return `${mainFileName(cfg)}.meta.json`;
}

const DEFAULT_BASE: Record<GitHostKind, string> = {
	github: "https://api.github.com",
	gitlab: "https://gitlab.com",
	gitea: "https://gitea.com",
};

interface GitCfg {
	apiBase: string;
	owner: string;
	repo: string;
	branch: string;
	path: string;
	token: string;
}

function readCfg(kind: GitHostKind, cfg: RemoteConfig): GitCfg {
	const o = cfg.options ?? {};
	const base = (o["apiBase"] || DEFAULT_BASE[kind]).replace(/\/+$/, "");
	const owner = (o["owner"] || "").trim();
	const repo = (o["repo"] || "").trim();
	const token = (o["token"] || "").trim();
	const path = (o["path"] || "configsync-hub.zip").replace(/^\/+/, "");
	if (!owner || !repo) throw new Error("请填写仓库所有者（owner）与仓库名（repo）");
	if (!token) throw new Error(`请填写 ${kind === "gitlab" ? "GitLab Access Token" : "Token / PAT"}`);
	return {
		apiBase: kind === "github" ? base : kind === "gitlab" ? `${base}/api/v4` : `${base}/api/v1`,
		owner,
		repo,
		branch: (o["branch"] || "main").trim(),
		path,
		token,
	};
}

function fileUrl(kind: GitHostKind, g: GitCfg, file: string): string {
	if (kind === "gitlab") {
		return `${g.apiBase}/projects/${encodeURIComponent(`${g.owner}/${g.repo}`)}/repository/files/${encodeURIComponent(file)}?ref=${encodeURIComponent(g.branch)}`;
	}
	return `${g.apiBase}/repos/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}/contents/${file
		.split("/")
		.map(encodeURIComponent)
		.join("/")}?ref=${encodeURIComponent(g.branch)}`;
}

function authHeaders(kind: GitHostKind, token: string): Record<string, string> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (kind === "gitlab") headers["PRIVATE-TOKEN"] = token;
	else if (kind === "gitea") headers["authorization"] = `token ${token}`;
	else headers["authorization"] = `Bearer ${token}`;
	return headers;
}

function decodeContent(raw: string): Buffer {
	return Buffer.from(String(raw || "").replace(/\s+/g, ""), "base64");
}

function parseMeta(text: string): RemoteSnapshotMeta | null {
	try {
		const json = JSON.parse(text) as RemoteSnapshotMeta;
		if (!json || typeof json.version !== "string") return null;
		return json;
	} catch {
		return null;
	}
}

async function getFile(kind: GitHostKind, cfg: RemoteConfig, file: string): Promise<{ text: string; data: Buffer } | null> {
	const g = readCfg(kind, cfg);
	const res = await http(fileUrl(kind, g, file), { headers: authHeaders(kind, g.token), timeoutMs: 30000 });
	if (res.status === 404) return null;
	requireOk(res, "读取远端文件");
	const json = res.json() as Record<string, unknown>;
	if (typeof json["content"] === "string") {
		return { text: Buffer.from(json["content"], "base64").toString("utf8"), data: decodeContent(json["content"]) };
	}
	if (typeof json["download_url"] === "string") {
		const dl = await httpBuffer(String(json["download_url"]), { headers: authHeaders(kind, g.token), timeoutMs: 60000 });
		if (dl.status !== 200) return null;
		return { text: dl.buffer.toString("utf8"), data: dl.buffer };
	}
	return null;
}

async function putFile(kind: GitHostKind, cfg: RemoteConfig, file: string, body: Buffer): Promise<void> {
	const g = readCfg(kind, cfg);
	const existing = await getFile(kind, cfg, file);
	const content = body.toString("base64");
	const headers: Record<string, string> = {
		...authHeaders(kind, g.token),
		"content-type": "application/json",
	};

	if (kind === "gitlab") {
		await requireOk(
			await http(fileUrl(kind, g, file), {
				method: "PUT",
				headers,
				body: JSON.stringify({
					branch: g.branch,
					encoding: "base64",
					content,
					commit_message: existing ? "chore: update configsync hub snapshot" : "chore: add configsync hub snapshot",
				}),
				timeoutMs: 120000,
			}),
			"上传远端文件"
		);
		return;
	}

	const sha = existing
		? await (async () => {
				const res = await http(fileUrl(kind, g, file), { headers: authHeaders(kind, g.token), timeoutMs: 30000 });
				if (!res.ok) return undefined;
				const json = res.json() as Record<string, unknown>;
				return typeof json["sha"] === "string" ? String(json["sha"]) : undefined;
		  })()
		: undefined;

	const payload: Record<string, unknown> = {
		message: existing ? "chore: update configsync hub snapshot" : "chore: add configsync hub snapshot",
		content,
		branch: g.branch,
	};
	if (sha) payload["sha"] = sha;

	await requireOk(
		await http(fileUrl(kind, g, file), { method: "PUT", headers, body: JSON.stringify(payload), timeoutMs: 120000 }),
		"上传远端文件"
	);
}

function makeGitHost(kind: GitHostKind, remoteType: RemoteKind): RemoteTransport {
	const self: RemoteTransport = {
		kind: remoteType,
		async readMeta(cfg: RemoteConfig): Promise<RemoteSnapshotMeta | null> {
			const got = await getFile(kind, cfg, metaFileName(cfg)).catch(() => null);
			if (!got) {
				// 兼容：meta 文件名固定为 configsync-hub.meta.json
				const fallback = await getFile(kind, cfg, REMOTE_META_NAME).catch(() => null);
				return fallback ? parseMeta(fallback.text) : null;
			}
			return parseMeta(got.text);
		},
		async download(cfg: RemoteConfig): Promise<{ meta: RemoteSnapshotMeta; data: Buffer }> {
			const metaRes = await self.readMeta(cfg);
			const got = await getFile(kind, cfg, mainFileName(cfg));
			if (!got) throw new Error("远端没有找到快照文件");
			const meta = metaRes ?? parseMeta(got.text);
			return { meta: meta ?? fallbackMeta(got.data.length), data: got.data };
		},
		async upload(cfg: RemoteConfig, snapshot: Buffer, meta: RemoteSnapshotMeta): Promise<void> {
			await putFile(kind, cfg, mainFileName(cfg), snapshot);
			await putFile(kind, cfg, metaFileName(cfg), Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
		},
		async test(cfg: RemoteConfig): Promise<void> {
			const g = readCfg(kind, cfg);
			const url =
				kind === "gitlab"
					? `${g.apiBase}/projects/${encodeURIComponent(`${g.owner}/${g.repo}`)}`
					: `${g.apiBase}/repos/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}`;
			const res = await http(url, { headers: authHeaders(kind, g.token), timeoutMs: 20000 });
			if (!res.ok) throw new Error(`无法访问仓库（HTTP ${res.status}）：请检查 owner/repo 与 token 权限`);
		},
	};
	return self;
}

function fallbackMeta(bytes: number): RemoteSnapshotMeta {
	return { version: "", updatedAt: new Date().toISOString(), bytes, fileCount: 0 };
}

export const githubTransport = makeGitHost("github", "github");
export const gitlabTransport = makeGitHost("gitlab", "gitlab");
export const giteaTransport = makeGitHost("gitea", "gitea");
