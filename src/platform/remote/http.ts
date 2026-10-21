/**
 * 远端同步用的 HTTP 助手。
 *
 * Obsidian 桌面版在渲染进程里有全局 fetch，插件本体也能用 Node 的 http 模块；
 * 这里统一封装超时、错误提示与二进制读取。
 */

export interface HttpOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string | Buffer;
	timeoutMs?: number;
}

export interface HttpResponse {
	status: number;
	ok: boolean;
	headers: Record<string, string>;
	text: string;
	json(): unknown;
	buffer(): Buffer;
	header(name: string): string | null;
}

async function globalFetch(): Promise<typeof fetch | null> {
	try {
		const g = globalThis as unknown as { fetch?: typeof fetch };
		if (typeof g.fetch === "function") return g.fetch.bind(globalThis);
	} catch {
		/* ignore */
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const undici = require("undici") as { fetch?: typeof fetch } | undefined;
		if (undici?.fetch) return undici.fetch as typeof fetch;
	} catch {
		/* ignore */
	}
	return null;
}

export async function http(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
	const fetchFn = await globalFetch();
	if (!fetchFn) throw new Error("当前环境不支持 fetch，无法进行云端同步");

	const controller = typeof AbortController === "function" ? new AbortController() : null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	if (controller && opts.timeoutMs) {
		timer = setTimeout(() => controller.abort(), opts.timeoutMs);
	}

	try {
		const init: RequestInit = {
			method: opts.method ?? "GET",
			headers: opts.headers ?? {},
			...(opts.body !== undefined ? { body: opts.body as BodyInit } : {}),
			...(controller ? { signal: controller.signal } : {}),
		};
		const res = await fetchFn(url, init);
		const text = await res.text();
		const headers: Record<string, string> = {};
		res.headers.forEach?.((value, key) => {
			headers[key.toLowerCase()] = value;
		});
		return {
			status: res.status,
			ok: res.status >= 200 && res.status < 300,
			headers,
			text,
			json: () => JSON.parse(text) as unknown,
			buffer: () => Buffer.from(text, "binary"),
			header: (name: string) => headers[name.toLowerCase()] ?? null,
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** 二进制下载（arrayBuffer → Buffer） */
export async function httpBuffer(url: string, opts: HttpOptions = {}): Promise<{ buffer: Buffer; status: number; header(name: string): string | null }> {
	const fetchFn = await globalFetch();
	if (!fetchFn) throw new Error("当前环境不支持 fetch，无法进行云端同步");
	const controller = typeof AbortController === "function" ? new AbortController() : null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	if (controller && opts.timeoutMs) {
		timer = setTimeout(() => controller.abort(), opts.timeoutMs);
	}
	try {
		const init: RequestInit = {
			method: opts.method ?? "GET",
			headers: opts.headers ?? {},
			...(opts.body !== undefined ? { body: opts.body as BodyInit } : {}),
			...(controller ? { signal: controller.signal } : {}),
		};
		const res = await fetchFn(url, init);
		const arrayBuffer = await res.arrayBuffer();
		const headers: Record<string, string> = {};
		res.headers.forEach?.((value, key) => {
			headers[key.toLowerCase()] = value;
		});
		return {
			buffer: Buffer.from(arrayBuffer),
			status: res.status,
			header: (name: string) => headers[name.toLowerCase()] ?? null,
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** 请求失败时抛出的可读错误 */
export function httpError(res: HttpResponse, ctx: string): Error {
	const detail = (res.text || "").replace(/\s+/g, " ").slice(0, 200);
	return new Error(`${ctx}：HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
}

export function requireOk(res: HttpResponse, ctx: string): HttpResponse {
	if (!res.ok) throw httpError(res, ctx);
	return res;
}

/** 取 JSON 字段（宽松，避免不同 API 字段缺失时炸栈） */
export function pick(source: unknown, key: string): unknown {
	if (!source || typeof source !== "object") return undefined;
	return (source as Record<string, unknown>)[key];
}
