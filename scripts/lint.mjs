/**
 * ConfigSync Hub 发布合规自检（零依赖，直接 `npm run lint`）。
 *
 * 校验两类规则：
 *   ERROR   —— Obsidian 社区插件审核的红线，命中即退出码 1；
 *   WARN    —— 风格/可维护性问题，不阻塞构建。
 *
 * 之所以不引 eslint：这些规则全是 Obsidian 特有的（core 不得依赖 obsidian、
 * manifest 描述必须以标点结尾、CSS 必须带前缀），通用 linter 检查不到。
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative, sep } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warns = [];

const fail = (file, msg) => errors.push(`${rel(file)}: ${msg}`);
const warn = (file, msg) => warns.push(`${rel(file)}: ${msg}`);

function rel(p) {
	return relative(ROOT, p).split(sep).join("/");
}

/** 递归收集文件 */
function walk(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

/** 去掉块注释与行注释，避免注释里的示例代码被误判 */
function stripComments(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const tsFiles = walk(join(ROOT, "src")).filter((f) => f.endsWith(".ts"));
const sources = new Map(tsFiles.map((f) => [f, stripComments(readFileSync(f, "utf8"))]));

/* ---------------------------- 1. 分层约束 ---------------------------- */

for (const [file, src] of sources) {
	const r = rel(file);
	if (r.startsWith("src/core/") && /from\s+["']obsidian["']/.test(src)) {
		fail(file, "src/core 不得依赖 obsidian（必须保持可单测）");
	}
	if (!r.startsWith("src/platform/") && /\brequire\(\s*["'](fs|child_process|os|path|electron)["']\s*\)/.test(src)) {
		fail(file, "Node/Electron API 只允许出现在 src/platform/");
	}
}

/* ---------------------------- 2. 安全红线 ---------------------------- */

const BANNED = [
	[/innerHTML|outerHTML|insertAdjacentHTML/, "禁止 innerHTML / outerHTML / insertAdjacentHTML"],
	[/\beval\s*\(|new\s+Function\s*\(/, "禁止 eval / new Function"],
	[/\bwindow\.app\b|\bglobalThis\.app\b/, "禁止访问全局 app 实例，请用 this.app"],
	[/\bWebSocket\b|\bXMLHttpRequest\b/, "禁止裸用 WebSocket / XMLHttpRequest"],
];

for (const [file, src] of sources) {
	for (const [re, msg] of BANNED) {
		if (re.test(src)) fail(file, msg);
	}
	// window/document 上的监听必须能自动释放，否则每次打开设置页都会泄漏一个
	if (/window\.addEventListener|document\.addEventListener/.test(src) && !/once:\s*true/.test(src)) {
		fail(file, "在 window/document 上挂的监听必须带 { once: true } 或手动解绑");
	}
}

/* ---------------------------- 3. 日志噪音 ---------------------------- */

const LOG_ALLOWED = ["src/platform/debug.ts", "src/platform/fileLogger.ts"];
for (const [file, src] of sources) {
	const r = rel(file);
	if (LOG_ALLOWED.includes(r)) continue;
	if (/console\.(log|debug|info|warn)\s*\(/.test(src)) {
		fail(file, "直接用 console 输出会污染开发者控制台，请改走 src/platform/debug.ts 的 debugLog()");
	}
}

/* ---------------------------- 4. i18n 键对齐 ---------------------------- */

function keysOf(file) {
	const src = sources.get(file) || "";
	const out = new Set();
	const re = /^\s*"([a-zA-Z0-9_.\-]+)"\s*:/gm;
	let m;
	// 只取字典对象的第一层键
	const body = src.slice(src.indexOf("{") + 1);
	while ((m = re.exec(body))) out.add(m[1]);
	return out;
}

const zhFile = join(ROOT, "src/i18n/zh.ts");
const enFile = join(ROOT, "src/i18n/en.ts");
if (existsSync(zhFile) && existsSync(enFile)) {
	const zh = keysOf(zhFile);
	const en = keysOf(enFile);
	for (const k of zh) if (!en.has(k)) fail(enFile, `缺少中文词典里存在的键：${k}`);
	for (const k of en) if (!zh.has(k)) fail(zhFile, `缺少英文词典里存在的键：${k}`);
}

/* ---------------------------- 5. 硬编码文案 ---------------------------- */

for (const [file, src] of sources) {
	const r = rel(file);
	// 只检查直接面向用户的 UI 层；core/platform 的错误串属于内部诊断信息
	if (!r.startsWith("src/ui/") && r !== "src/main.ts") continue;
	// 只扫可能出现在界面上的行：跳过纯日志行与原生选择器提示语
	const lines = src.split("\n").filter((l) => !/\b(logger|log|debugLog|debugWarn)\b[^\n]*\(|prompt:/.test(l));
	const hits = [];
	for (const line of lines) {
		const m = line.match(/(["'`])[^"'`]*[\u4e00-\u9fa5][^"'`]*\1/g);
		if (m) hits.push(...m);
	}
	// 允许：i18n 键、CSS 类名
	const real = hits.filter((h) => !/^["'`][a-zA-Z0-9_.\-]+["'`]$/.test(h));
	if (real.length) warn(file, `疑似硬编码中文文案 ${real.length} 处（应走 t()）：${real[0]}`);
}

/* ---------------------------- 6. manifest.json ---------------------------- */

const manifestPath = join(ROOT, "manifest.json");
let manifest = null;
try {
	manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
	fail(manifestPath, `manifest.json 解析失败：${e.message}`);
}

if (manifest) {
	const need = ["id", "name", "version", "minAppVersion", "description", "author"];
	for (const k of need) if (!manifest[k]) fail(manifestPath, `缺少必填字段 ${k}`);

	const id = String(manifest.id || "");
	if (/obsidian/i.test(id)) fail(manifestPath, 'id 不得包含 "obsidian"');
	if (/plugin$/i.test(id)) fail(manifestPath, 'id 不得以 "plugin" 结尾');
	if (!/^[a-z0-9_-]+$/.test(id)) fail(manifestPath, "id 只能含小写字母、数字、- 和 _");

	const name = String(manifest.name || "");
	if (/obsidian/i.test(name)) fail(manifestPath, 'name 不得包含 "Obsidian"');
	if (/plugin$/i.test(name)) fail(manifestPath, 'name 不得以 "Plugin" 结尾');

	const desc = String(manifest.description || "");
	if (/obsidian/i.test(desc)) fail(manifestPath, 'description 不得包含 "Obsidian"');
	if (/this (is a )?plugin/i.test(desc)) fail(manifestPath, "description 不得以 \"This plugin\" 开头");
	if (!/[.?!)]$/.test(desc.trim())) fail(manifestPath, "description 必须以 . ? ! 或 ) 结尾（审核机器人硬校验）");
	if (desc.length > 250) fail(manifestPath, `description 超过 250 字符（当前 ${desc.length}）`);

	const ver = String(manifest.version || "");
	if (!/^\d+\.\d+\.\d+$/.test(ver)) fail(manifestPath, "version 必须是 x.y.z 三段式，且不带 v 前缀");
	if (!/^\d+\.\d+(\.\d+)?$/.test(String(manifest.minAppVersion || ""))) {
		fail(manifestPath, "minAppVersion 必须是合法版本号");
	}

	// 用了 Node/Electron API 就必须声明桌面端专用
	const usesNode = [...sources.values()].some((s) =>
		/\brequire\(\s*["'](fs|child_process|os|path|electron)["']\s*\)/.test(s)
	);
	if (usesNode && manifest.isDesktopOnly !== true) {
		fail(manifestPath, "源码使用了 Node/Electron API，isDesktopOnly 必须为 true");
	}

	/* versions.json 必须包含当前版本 */
	try {
		const versions = JSON.parse(readFileSync(join(ROOT, "versions.json"), "utf8"));
		if (ver && !versions[ver]) fail(join(ROOT, "versions.json"), `缺少当前版本 ${ver} 的 minAppVersion 映射`);
	} catch (e) {
		fail(join(ROOT, "versions.json"), `解析失败：${e.message}`);
	}

	/* package.json 版本应与 manifest 保持一致 */
	try {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		if (pkg.version !== ver) warn(join(ROOT, "package.json"), `version ${pkg.version} 与 manifest ${ver} 不一致`);
	} catch (e) {
		warn(join(ROOT, "package.json"), `解析失败：${e.message}`);
	}
}

/* ---------------------------- 7. 仓库必备文件 ---------------------------- */

for (const f of ["README.md", "LICENSE", "manifest.json", "versions.json"]) {
	if (!existsSync(join(ROOT, f))) fail(join(ROOT, f), `仓库根目录缺少 ${f}（提交审核必需）`);
}

/* ---------------------------- 8. CSS 作用域 ---------------------------- */

const cssPath = join(ROOT, "styles.css");
if (existsSync(cssPath)) {
	const css = stripComments(readFileSync(cssPath, "utf8"));
	const selectors = [];
	let buf = "";
	for (const ch of css) {
		if (ch === "{") {
			selectors.push(buf.trim());
			buf = "";
		} else if (ch === "}") {
			buf = "";
		} else {
			buf += ch;
		}
	}
	for (const sel of selectors) {
		if (!sel) continue;
		for (const part of sel.split(",").map((s) => s.trim())) {
			if (!part.startsWith(".configsync-hub")) {
				fail(cssPath, `CSS 选择器必须带 .configsync-hub 前缀，避免污染 Obsidian 全局样式：${part}`);
			}
		}
	}
}

/* ---------------------------- 9. README 强制披露 ---------------------------- */

const readmePath = join(ROOT, "README.md");
if (existsSync(readmePath)) {
	const readme = readFileSync(readmePath, "utf8");
	if (usesNetwork() && !/网络|Network/i.test(readme)) {
		fail(readmePath, "插件会发起网络请求，README 必须写明访问哪些服务、发送什么数据");
	}
	if (!/vault\s*(之外|外)|vault 外部|outside the vault/i.test(readme)) {
		fail(readmePath, "插件会读写 vault 之外的目录，README 必须披露");
	}
} else {
	fail(readmePath, "缺少 README.md");
}

function usesNetwork() {
	return [...sources.values()].some((s) => /https?:\/\//.test(s) && /fetch|request|http/i.test(s));
}

/* ---------------------------- 10. 输出 ---------------------------- */

for (const w of warns) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);

const label = (n, s) => `${n} ${s}`;
console.log("");
console.log(`lint: ${label(errors.length, "error")}, ${label(warns.length, "warning")}`);
if (errors.length) {
	console.error("\n存在必须修复的问题，发布审核会被拒。");
	process.exit(1);
}
console.log("lint: 合规检查通过 ✅");
