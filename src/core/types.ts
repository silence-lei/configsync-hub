/**
 * ConfigSync 核心数据模型。
 *
 * 约定：本文件及整个 `src/core/**` 目录不得 import `obsidian`，
 * 以保证核心同步逻辑可以脱离 Obsidian 单独做单元测试（NFR-05）。
 */

/** 同步内容分类（§5.3 同步内容清单） */
export type SyncCategoryId =
	| "plugins"
	| "pluginData"
	| "themes"
	| "snippets"
	| "appearance"
	| "communityPlugins"
	| "corePlugins"
	| "corePluginData"
	| "hotkeys"
	| "appSettings"
	| "graph";

export interface CategoryMeta {
	id: SyncCategoryId;
	/** 默认是否同步 */
	defaultEnabled: boolean;
	/** i18n key，形如 `cat.plugins` */
	labelKey: string;
	descKey: string;
}

export const CATEGORIES: CategoryMeta[] = [
	{ id: "plugins", defaultEnabled: true, labelKey: "cat.plugins", descKey: "cat.plugins.desc" },
	{ id: "pluginData", defaultEnabled: true, labelKey: "cat.pluginData", descKey: "cat.pluginData.desc" },
	{ id: "themes", defaultEnabled: true, labelKey: "cat.themes", descKey: "cat.themes.desc" },
	{ id: "snippets", defaultEnabled: true, labelKey: "cat.snippets", descKey: "cat.snippets.desc" },
	{ id: "appearance", defaultEnabled: true, labelKey: "cat.appearance", descKey: "cat.appearance.desc" },
	{
		id: "communityPlugins",
		defaultEnabled: true,
		labelKey: "cat.communityPlugins",
		descKey: "cat.communityPlugins.desc",
	},
	{ id: "corePlugins", defaultEnabled: true, labelKey: "cat.corePlugins", descKey: "cat.corePlugins.desc" },
	{
		id: "corePluginData",
		defaultEnabled: true,
		labelKey: "cat.corePluginData",
		descKey: "cat.corePluginData.desc",
	},
	{ id: "hotkeys", defaultEnabled: true, labelKey: "cat.hotkeys", descKey: "cat.hotkeys.desc" },
	{ id: "appSettings", defaultEnabled: false, labelKey: "cat.appSettings", descKey: "cat.appSettings.desc" },
	{ id: "graph", defaultEnabled: false, labelKey: "cat.graph", descKey: "cat.graph.desc" },
];

/** 远端（云存储）类型 */
export type RemoteKind = "github" | "gitlab" | "gitea" | "googledrive" | "onedrive" | "webdav" | "local";

export interface RemoteKindMeta {
	id: RemoteKind;
	labelKey: string;
	descKey: string;
	/** 是否需要 OAuth 授权 */
	oauth: boolean;
}

export const REMOTE_KINDS: RemoteKindMeta[] = [
	{ id: "github", labelKey: "remote.kind.github", descKey: "remote.kind.github.desc", oauth: false },
	{ id: "gitlab", labelKey: "remote.kind.gitlab", descKey: "remote.kind.gitlab.desc", oauth: false },
	{ id: "gitea", labelKey: "remote.kind.gitea", descKey: "remote.kind.gitea.desc", oauth: false },
	{ id: "googledrive", labelKey: "remote.kind.googledrive", descKey: "remote.kind.googledrive.desc", oauth: true },
	{ id: "onedrive", labelKey: "remote.kind.onedrive", descKey: "remote.kind.onedrive.desc", oauth: true },
	{ id: "webdav", labelKey: "remote.kind.webdav", descKey: "remote.kind.webdav.desc", oauth: false },
	{ id: "local", labelKey: "remote.kind.local", descKey: "remote.kind.local.desc", oauth: false },
];

/** 一个远端存档点 */
export interface RemoteConfig {
	id: string;
	kind: RemoteKind;
	name: string;
	enabled: boolean;
	/**
	 * 各平台字段（明文保存在 data.json）：
	 * - github/gitlab/gitea: token、owner、repo、branch、path、apiBase（gitlab/gitea 可自托管）
	 * - googledrive: clientId、clientSecret、accessToken、refreshToken
	 * - onedrive: clientId、accessToken、refreshToken
	 * - webdav: url、user、password
	 * - local: path
	 */
	options: Record<string, string>;
	lastPushVersion?: string;
	lastPullVersion?: string;
	lastSyncAt?: string;
}

export interface RemoteSettings {
	/** 启动 Obsidian 时自动从远端拉取并检查更新 */
	autoPullOnStartup: boolean;
	/** 推送到 Hub 后自动同步到远端 */
	autoPushAfterHubPush: boolean;
	/** 拉取远程快照前先备份本地 Hub */
	backupHub: boolean;
}

/** 发现到的插件（用于 UI 勾选） */
export interface PluginInventoryItem {
	id: string;
	/** 显示名，取自 manifest.json */
	name?: string;
	version?: string;
	desc?: string;
}

/** Hub 快照的远程元信息（与 zip 一起存放，用于避免无谓下载） */
export interface RemoteSnapshotMeta {
	/** Hub 的 configVersion */
	version: string;
	updatedAt: string;
	bytes: number;
	fileCount: number;
	sourceVault?: string;
}

/** 目标库 */
export interface VaultTarget {
	/** 绝对路径 */
	path: string;
	name: string;
	enabled: boolean;
	/** 手工添加的库（不在 Obsidian 注册表中） */
	manual?: boolean;
}

export interface BackupPolicy {
	enabled: boolean;
	/** 保留份数 */
	keep: number;
	/** full = 整个 .obsidian；affected = 仅本次将要改动的文件 */
	scope: "full" | "affected";
	/** 恢复时是否删除备份之后新增的文件（默认关闭，避免误删） */
	deleteExtraneousOnRestore: boolean;
}

/** 插件设置（落盘于 `<vault>/.obsidian/plugins/configsync-hub/data.json`） */
export interface ConfigSyncSettings {
	schemaVersion: number;
	/** 配置中枢目录，空串表示未设置 */
	hubPath: string;
	language: "auto" | "zh" | "en";
	/** 参与同步的目标库 */
	targets: VaultTarget[];
	categories: Record<SyncCategoryId, boolean>;
	/** 整插件排除（plugin id 列表，对应 `plugins/<id>/**`） */
	excludedPlugins: string[];
	/** 路径通配排除规则，作用于 .obsidian 内的相对路径 */
	excludedPaths: string[];
	/** 是否删除目标库中 Hub 已不存在的文件 */
	pruneExtraneous: boolean;
	backup: BackupPolicy;
	/** 启动时静默检查 Hub 版本 */
	startupCheck: boolean;
	/** 当前库配置变更后自动推送到 Hub */
	autoPush: boolean;
	autoPushDebounceMs: number;
	/** 定时同步间隔（分钟），0 = 关闭 */
	periodicSyncMinutes: number;
	enableLog: boolean;
	/** 把诊断信息输出到 Obsidian 开发者控制台（默认关闭，避免污染控制台） */
	debugConsole: boolean;
	/** 同步前弹出预览确认 */
	confirmBeforeSync: boolean;
	/** 远端存档点列表 */
	remotes: RemoteConfig[];
	remote: RemoteSettings;
	/** 插件维度的同步开关：id → 是否参与同步（未列出的默认同步） */
	pluginSelection: Record<string, boolean>;
	/** 最近一次扫描到的插件清单（Hub + 当前库），用于设置页渲染 */
	pluginInventory: PluginInventoryItem[];
}

export const SETTINGS_SCHEMA_VERSION = 2;

export function defaultCategoryFlags(): Record<SyncCategoryId, boolean> {
	const flags = {} as Record<SyncCategoryId, boolean>;
	for (const c of CATEGORIES) flags[c.id] = c.defaultEnabled;
	return flags;
}

export function defaultSettings(): ConfigSyncSettings {
	return {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		hubPath: "",
		language: "auto",
		targets: [],
		categories: defaultCategoryFlags(),
		excludedPlugins: [],
		excludedPaths: [],
		pruneExtraneous: false,
		backup: { enabled: true, keep: 10, scope: "full", deleteExtraneousOnRestore: false },
		startupCheck: true,
		autoPush: false,
		autoPushDebounceMs: 3000,
		periodicSyncMinutes: 0,
		enableLog: true,
		debugConsole: false,
		confirmBeforeSync: false,
		remotes: [],
		remote: { autoPullOnStartup: false, autoPushAfterHubPush: false, backupHub: true },
		pluginSelection: {},
		pluginInventory: [],
	};
}

/** manifest.json 中的文件条目 */
export interface FileEntry {
	/** 相对 .obsidian 的路径，使用 `/` 分隔 */
	path: string;
	sha256: string;
	size: number;
	mtime: string;
	/** 插件版本（仅 plugins/<id>/manifest.json） */
	pluginVersion?: string;
}

/** Hub 的同步清单 */
export interface HubManifest {
	schemaVersion: number;
	configVersion: string;
	updatedAt: string;
	/** 最近一次推送的来源库 */
	sourceVault?: string;
	files: FileEntry[];
}

export const MANIFEST_SCHEMA_VERSION = 1;

/** 单个 vault 的同步状态（`.obsidian/configsync-hub/state.json`） */
export interface VaultSyncState {
	lastSyncAt?: string;
	lastSyncVersion?: string;
	/** 相对路径 → 指纹 */
	fileFingerprints: Record<string, FileFingerprint>;
}

export interface FileFingerprint {
	/** sha256 */
	h: string;
	/** size */
	s: number;
	/** mtime(ms) */
	m: number;
}
