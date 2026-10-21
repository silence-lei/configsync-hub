/**
 * 同步内容与排除规则（§5.3 / FR-601~603）。
 *
 * 纯函数模块，不依赖文件系统，便于单元测试。
 */

import { ConfigSyncSettings, SyncCategoryId } from "./types";
import { BACKUP_DIR_NAME, SELF_STATE_DIR } from "./paths";

export { BACKUP_DIR_NAME, SELF_STATE_DIR };

/** 本插件 id */
export const PLUGIN_ID = "configsync-hub";

/** 相对路径统一为 `/` 分隔 */
export function normalizeRel(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * 永不参与同步的文件（§5.3）：
 * - workspace*.json：本机/本库窗口布局
 * - 本插件自身的 data.json 与状态目录
 * - 备份目录
 */
export function isNeverSynced(rel: string): boolean {
	const p = normalizeRel(rel);
	const base = p.slice(p.lastIndexOf("/") + 1);
	if (!base) return true;
	if (base.startsWith(".")) return true;
	if (base === ".DS_Store" || base === "Thumbs.db") return true;
	if (p === `${SELF_STATE_DIR}` || p.startsWith(`${SELF_STATE_DIR}/`)) return true;
	if (p === BACKUP_DIR_NAME || p.startsWith(`${BACKUP_DIR_NAME}/`)) return true;
	if (p === `plugins/${PLUGIN_ID}` || p.startsWith(`plugins/${PLUGIN_ID}/`)) return true;
	if (base.startsWith("workspace") && base.endsWith(".json")) return true;
	// 版本控制目录
	const parts = p.split("/");
	if (parts.includes(".git") || parts.includes("node_modules")) return true;
	return false;
}

const ROOT_JSON_CATEGORY: Record<string, SyncCategoryId> = {
	"appearance.json": "appearance",
	"community-plugins.json": "communityPlugins",
	"core-plugins.json": "corePlugins",
	"hotkeys.json": "hotkeys",
	"app.json": "appSettings",
	"graph.json": "graph",
};

/** 判定某个 .obsidian 内相对路径属于哪个同步分类；返回 null 表示不属于任何分类 */
export function classify(rel: string): SyncCategoryId | null {
	const p = normalizeRel(rel);
	if (isNeverSynced(p)) return null;
	const parts = p.split("/");
	const head = parts[0];

	if (head === "plugins" && parts.length >= 2) {
		if (parts.length >= 3 && parts[parts.length - 1] === "data.json") return "pluginData";
		return "plugins";
	}
	if (head === "themes") return "themes";
	if (head === "snippets") return "snippets";
	if (parts.length === 1) {
		return ROOT_JSON_CATEGORY[p] ?? (p.endsWith(".json") ? "corePluginData" : null);
	}
	return null;
}

/** 从 `plugins/<id>/...` 中取出插件 id */
export function pluginIdOf(rel: string): string | null {
	const p = normalizeRel(rel);
	if (!p.startsWith("plugins/")) return null;
	const rest = p.slice("plugins/".length);
	const id = rest.split("/")[0];
	return id || null;
}

/** 通配符匹配：支持 `*` `**` `?` */
export function globToRegExp(pattern: string): RegExp {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				i++;
				if (pattern[i + 1] === "/") {
					i++;
					re += "(?:.*/)?";
				} else {
					re += ".*";
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if ("\\^$.|+()[]{}".indexOf(c) >= 0) {
			re += "\\" + c;
		} else {
			re += c;
		}
	}
	return new RegExp("^" + re + "$", "i");
}

export interface RuleSet {
	/** 该文件是否应当参与同步 */
	isSynced(rel: string): boolean;
	/** 是否应当被规则排除（区别于分类未开启） */
	excludedBy(rel: string): "none" | "never" | "category" | "plugin" | "path";
}

/** 由设置构建规则集 */
export function buildRuleSet(settings: ConfigSyncSettings): RuleSet {
	const categories = settings.categories ?? ({} as Record<SyncCategoryId, boolean>);
	const excludedPlugins = (settings.excludedPlugins ?? []).map((s) => s.trim()).filter(Boolean);
	const selection = settings.pluginSelection ?? {};
	const pathPatterns = (settings.excludedPaths ?? [])
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => globToRegExp(s));

	return {
		isSynced(rel) {
			return this.excludedBy(rel) === "none";
		},
		excludedBy(rel) {
			const p = normalizeRel(rel);
			if (isNeverSynced(p)) return "never";
			const cat = classify(p);
			if (!cat) return "category";
			if (categories[cat] === false) return "category";
			const id = pluginIdOf(p);
			if (id) {
				// 勾选列表优先：显式关闭的直接排除；未列出的默认参与同步
				if (selection[id] === false) return "plugin";
				if (excludedPlugins.indexOf(id) >= 0) return "plugin";
			}
			for (const re of pathPatterns) {
				if (re.test(p)) return "path";
			}
			return "none";
		},
	};
}

/** 把用户textarea输入解析成列表（支持逗号 / 换行 / 空格分隔） */
export function parseList(raw: string): string[] {
	return (raw || "")
		.split(/[\n,;]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}
