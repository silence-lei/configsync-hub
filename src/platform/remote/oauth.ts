/**
 * OAuth 2.0 授权码 + PKCE（桌面 / loopback 模式），用于 Google Drive 与 OneDrive。
 *
 * 流程：本机起一个 127.0.0.1 的临时 HTTP 服务 → 用系统浏览器打开授权页 →
 * 用户在浏览器里同意后带着 code 回调 → 换 access/refresh token。
 * 只需要 clientId（公开客户端），不需要 client secret。
 */

import { http } from "./http";

export interface OAuthClient {
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	clientSecret?: string;
	scopes: string[];
	/** 回调端口，需与 OAuth 应用里注册的重定向地址一致 */
	redirectPort?: number;
	/** 额外授权参数（如 Google 的 access_type / prompt） */
	extraAuthParams?: Record<string, string>;
	/** token 端点是否需要 Basic client 认证（Google 桌面客户端需要 secret） */
	basicSecret?: boolean;
}

export interface TokenResult {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}

function randomString(bytes = 32): string {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const crypto = require("crypto") as { randomBytes: (n: number) => Buffer };
		return crypto.randomBytes(bytes).toString("base64url");
	} catch {
		let s = "";
		for (let i = 0; i < bytes; i++) s += String.fromCharCode(Math.floor(Math.random() * 256));
		return Buffer.from(s, "binary").toString("base64url");
	}
}

function sha256Base64Url(input: string): string {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const crypto = require("crypto") as {
		createHash: (alg: string) => { update: (d: Buffer) => { digest: (enc: string) => string }; digest: (enc: string) => string };
	};
	return crypto.createHash("sha256").update(Buffer.from(input, "utf8")).digest("base64url");
}

function basicHeader(clientId: string, clientSecret?: string): string {
	return Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret ?? "")}`).toString("base64");
}

function openBrowser(url: string): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const electron = require("electron") as { shell?: { openExternal?: (u: string) => void } };
		if (electron?.shell?.openExternal) {
			electron.shell.openExternal(url);
			return;
		}
	} catch {
		/* 忽略 */
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const cp = require("child_process") as { execFile: (c: string, a: string[]) => void };
		const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
		const args = cmd === "cmd" ? ["/c", "start", "", url] : [url];
		cp.execFile(cmd, args);
	} catch {
		/* 忽略，用户可手动打开 URL */
	}
}

async function exchangeToken(client: OAuthClient, code: string, redirectUri: string, verifier: string): Promise<TokenResult> {
	const body = new URLSearchParams();
	body.set("grant_type", "authorization_code");
	body.set("code", code);
	body.set("redirect_uri", redirectUri);
	body.set("client_id", client.clientId);
	body.set("code_verifier", verifier);
	if (client.clientSecret) body.set("client_secret", client.clientSecret);

	const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
	if (client.basicSecret) headers["authorization"] = `Basic ${basicHeader(client.clientId, client.clientSecret)}`;

	const res = await http(client.tokenUrl, { method: "POST", headers, body: body.toString(), timeoutMs: 30000 });
	if (!res.ok) throw new Error(`换取 access token 失败（HTTP ${res.status}）: ${res.text.slice(0, 300)}`);
	const json = res.json() as Record<string, unknown>;
	const access = String(json["access_token"] ?? "");
	if (!access) throw new Error("授权响应中没有 access_token");
	const out: TokenResult = { accessToken: access };
	if (json["refresh_token"]) out.refreshToken = String(json["refresh_token"]);
	const expiresIn = Number(json["expires_in"]);
	if (Number.isFinite(expiresIn)) out.expiresAt = Date.now() + expiresIn * 1000;
	return out;
}

/** 启动授权流程，返回 token */
export async function authorize(client: OAuthClient): Promise<TokenResult> {
	const port = client.redirectPort ?? 53682;
	const verifier = randomString();
	const challenge = sha256Base64Url(verifier);
	const redirectUri = `http://127.0.0.1:${port}`;

	const params = new URLSearchParams();
	params.set("client_id", client.clientId);
	params.set("response_type", "code");
	params.set("redirect_uri", redirectUri);
	params.set("scope", client.scopes.join(" "));
	params.set("code_challenge", challenge);
	params.set("code_challenge_method", "S256");
	if (client.extraAuthParams) {
		for (const [k, v] of Object.entries(client.extraAuthParams)) params.set(k, v);
	}
	const url = `${client.authorizeUrl}?${params.toString()}`;

	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const httpMod = require("http") as typeof import("http");
	const code = await new Promise<string>((resolve, reject) => {
		const server = httpMod.createServer((req, res) => {
			const requestUrl = new URL(req.url ?? "/", redirectUri);
			if (requestUrl.pathname !== "/callback") {
				res.writeHead(404).end("not found");
				return;
			}
			const err = requestUrl.searchParams.get("error");
			const value = requestUrl.searchParams.get("code");
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(
				err
					? `<h1>授权失败</h1><p>${err}</p><p>可以关闭这个页面了。</p>`
					: `<h1>授权成功</h1><p>请回到 Obsidian 继续。</p><script>setTimeout(()=>window.close(),1500)</script>`
			);
			setTimeout(() => {
				try {
					server.close();
				} catch {
					/* ignore */
				}
			}, 300);
			if (err) reject(new Error(`授权被拒绝：${err}`));
			else if (value) resolve(value);
			else reject(new Error("回调中没有拿到授权码"));
		});
		server.on("error", (e: Error) => reject(new Error(`无法启动本地回调服务（端口 ${port} 可能已被占用）: ${e.message}`)));
		server.listen(port, "127.0.0.1", () => {
			openBrowser(url);
		});
		setTimeout(() => {
			try {
				server.close();
			} catch {
				/* ignore */
			}
			reject(new Error("授权超时（5 分钟）"));
		}, 5 * 60 * 1000);
	});

	return exchangeToken(client, code, redirectUri, verifier);
}

/** 用 refresh token 换新 token */
export async function refresh(client: OAuthClient, refreshToken: string): Promise<TokenResult> {
	const body = new URLSearchParams();
	body.set("grant_type", "refresh_token");
	body.set("refresh_token", refreshToken);
	body.set("client_id", client.clientId);
	if (client.clientSecret) body.set("client_secret", client.clientSecret);
	const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
	if (client.basicSecret) headers["authorization"] = `Basic ${basicHeader(client.clientId, client.clientSecret)}`;

	const res = await http(client.tokenUrl, { method: "POST", headers, body: body.toString(), timeoutMs: 30000 });
	if (!res.ok) throw new Error(`刷新 token 失败（HTTP ${res.status}）: ${res.text.slice(0, 200)}`);
	const json = res.json() as Record<string, unknown>;
	const access = String(json["access_token"] ?? "");
	if (!access) throw new Error("刷新响应中没有 access_token");
	const out: TokenResult = { accessToken: access };
	if (json["refresh_token"]) out.refreshToken = String(json["refresh_token"]);
	const expiresIn = Number(json["expires_in"]);
	if (Number.isFinite(expiresIn)) out.expiresAt = Date.now() + expiresIn * 1000;
	return out;
}

/** 用系统默认浏览器打开 URL（创建 OAuth 应用等引导页） */
export function openExternal(url: string): void {
	openBrowser(url);
}
