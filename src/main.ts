/**
 * ConfigSync — Obsidian 跨 Vault 配置同步插件
 *
 * 负责：设置持久化、命令注册、UI 触发、定时/监听任务。
 * 所有文件操作都委托给 `src/core` 与 `src/platform`，这里只做编排。
 */

import * as path from "path";
import { existsSync, readdirSync, statSync } from "fs";
import { Notice, Platform, Plugin } from "obsidian";

import { ConfigSyncSettings, defaultSettings, PluginInventoryItem, RemoteConfig, SETTINGS_SCHEMA_VERSION, VaultTarget } from "./core/types";
import { FsApi } from "./core/fs";
import { RuleSet, buildRuleSet } from "./core/rules";
import { SyncPlan, applyPlan, checkHub, planSync, pushToHub, SyncReport, VaultSyncStatus } from "./core/engine";
import {
	BackupInfo,
	createVaultBackup,
	exportConfigZip,
	importConfigZip,
	listBackups as listVaultBackups,
	restoreBackup,
} from "./core/backup";
import { hubConfigDir, vaultBackupDir, vaultConfigDir } from "./core/paths";
import { Logger, NullLogger } from "./core/logger";
import { createTranslator, LangPref, resolveLang, Translate } from "./i18n";
import { createNodeAdapter, PlatformAdapter } from "./platform/adapter";
import { FileLogger } from "./platform/fileLogger";
import { clearTimer, setRepeating, setTimer } from "./platform/timers";
import { debugLog, setDebugEnabled } from "./platform/debug";
import { ConfigSyncSettingTab } from "./ui/settings";
import { ConfirmModal, PreviewModal, ResultModal } from "./ui/modals";
import { pickFile, revealPath } from "./ui/folderPicker";
import { getTransport, authorizeRemote, REMOTE_SPECS } from "./platform/remote";
import { openExternal as openExternalLink } from "./platform/remote/oauth";
import { PLUGIN_ID } from "./core/rules";
import { scanPluginInventory } from "./core/inventory";
import { planRemote, pullFromRemote, pushToRemote, pruneHubBackups } from "./core/remote/sync";

const AUTO_PUSH_POLL_MS = 5000;
const STATUS_CACHE_MS = 20000;

export default class ConfigSyncPlugin extends Plugin {
	settings!: ConfigSyncSettings;
	platform!: PlatformAdapter;
	fs!: FsApi;
	t: Translate = createTranslator("zh");

	private logger: Logger = new NullLogger();
	private fileLogger: FileLogger | null = null;
	private statusCache: { at: number; map: Map<string, VaultSyncStatus> } | null = null;
	private autoPushTimer: number | null = null;
	private lastConfigSignature = "";
	/** 设置页实例引用，用于操作完成后即时刷新界面 */
	settingsTab: ConfigSyncSettingTab | null = null;

	/* ------------------------------ 生命周期 ------------------------------ */

	async onload(): Promise<void> {
		// 依赖 Node fs 与 Electron，只能在桌面端运行（manifest 已声明 isDesktopOnly，这里是二次兜底）
		if (!Platform.isDesktopApp) {
			debugLog("not a desktop environment, skipping load");
			return;
		}
		await this.loadSettings();
		this.platform = createNodeAdapter(this.app);
		this.fs = this.platform.fs;
		await this.refreshTranslator();
		this.setupLogger();

		this.settingsTab = new ConfigSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);
		this.registerCommands();

		this.app.workspace.onLayoutReady(() => {
			void this.onLayoutReady();
		});

		void this.setupAutoPush();
		this.setupPeriodicSync();
	}

	onunload(): void {
		this.fileLogger?.flush();
		clearTimer(this.autoPushTimer);
	}

	get currentVaultPath(): string {
		return this.platform?.getCurrentVaultPath() ?? "";
	}

	private get hubPath(): string {
		return this.settings.hubPath;
	}

	private rules(): RuleSet {
		return buildRuleSet(this.settings);
	}

	/* ------------------------------ 设置 ------------------------------ */

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<ConfigSyncSettings> | null;
		const base = defaultSettings();
		this.settings = {
			...base,
			...(loaded ?? {}),
			categories: { ...base.categories, ...(loaded?.categories ?? {}) },
			backup: { ...base.backup, ...(loaded?.backup ?? {}) },
			remote: { ...base.remote, ...(loaded?.remote ?? {}) },
			targets: Array.isArray(loaded?.targets) ? loaded!.targets! : [],
			excludedPlugins: Array.isArray(loaded?.excludedPlugins) ? loaded!.excludedPlugins! : [],
			excludedPaths: Array.isArray(loaded?.excludedPaths) ? loaded!.excludedPaths! : [],
			remotes: Array.isArray(loaded?.remotes) ? loaded!.remotes! : [],
			pluginSelection: { ...(loaded?.pluginSelection ?? {}) },
			pluginInventory: Array.isArray(loaded?.pluginInventory) ? loaded!.pluginInventory! : [],
		};
		this.settings.schemaVersion = SETTINGS_SCHEMA_VERSION;
		setDebugEnabled(this.settings.debugConsole === true);
	}

	async saveSettings(): Promise<void> {
		this.invalidateStatus();
		await this.saveData(this.settings);
	}

	async refreshTranslator(): Promise<void> {
		this.t = createTranslator(resolveLang(this.settings.language, this.appLocale()));
	}

	private appLocale(): string {
		try {
			const stored = window.localStorage.getItem("language");
			if (stored) return stored;
		} catch {
			/* 忽略 */
		}
		return typeof navigator !== "undefined" ? navigator.language : "";
	}

	private setupLogger(): void {
		this.fileLogger = new FileLogger({
			getPath: () => {
				if (this.hubPath) return path.join(this.hubPath, "configsync-hub.log");
				const vp = this.currentVaultPath;
				return vp ? path.join(vaultConfigDir(vp), "configsync-hub", "configsync-hub.log") : null;
			},
			isEnabled: () => this.settings.enableLog,
		});
		this.logger = this.fileLogger;
	}

	logPath(): string | null {
		if (this.hubPath) return path.join(this.hubPath, "configsync-hub.log");
		const vp = this.currentVaultPath;
		return vp ? path.join(vaultConfigDir(vp), "configsync-hub", "configsync-hub.log") : null;
	}

	revealLog(): void {
		const p = this.logPath();
		if (!p) return;
		if (!revealPath(p)) new Notice(p);
	}

	async clearLog(): Promise<void> {
		const p = this.logPath();
		if (!p) return;
		await this.fs.writeFileAtomic(p, Buffer.from("", "utf8"));
	}

	/* ------------------------------ 命令 ------------------------------ */

	private registerCommands(): void {
		const t = () => this.t;

		this.addCommand({
			id: "sync-all",
			name: t()("cmd.syncAll"),
			callback: () => void this.syncAll(),
		});
		this.addCommand({
			id: "sync-current",
			name: t()("cmd.syncCurrent"),
			callback: () => void this.pullToCurrentVault(),
		});
		this.addCommand({
			id: "push-hub",
			name: t()("cmd.pushHub"),
			callback: () => void this.pushCurrentToHub(),
		});
		this.addCommand({
			id: "preview",
			name: t()("cmd.preview"),
			callback: () => void this.previewSync(),
		});
		this.addCommand({
			id: "backup-current",
			name: t()("cmd.backupCurrent"),
			callback: () => void this.backupCurrentVault(),
		});
		this.addCommand({
			id: "restore-backup",
			name: t()("cmd.restoreBackup"),
			callback: () => void this.openBackupList(),
		});
		this.addCommand({
			id: "cloud-push",
			name: t()("cmd.cloudPush"),
			callback: () => void this.pushAllRemotes(),
		});
		this.addCommand({
			id: "cloud-pull",
			name: t()("cmd.cloudPull"),
			callback: () => void this.pullAllRemotes(),
		});
		this.addCommand({
			id: "open-settings",
			name: t()("cmd.openSettings"),
			callback: () => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const setting = (this.app as unknown as { setting: any }).setting;
				setting?.open?.();
				setting?.openTabById?.(this.manifest.id);
			},
		});
	}

	private openBackupList(): void {
		void (async () => {
			const vaultPath = this.currentVaultPath;
			if (!vaultPath) {
				new Notice(this.t("notice.noVaultPath"));
				return;
			}
			const backups = await this.listBackups(vaultPath);
			// 复用设置页的备份列表弹窗逻辑
			const { BackupListModal } = await import("./ui/modals");
			new BackupListModal(this.app, this.t, backups, {
				onRestore: async (b) => {
					await this.restoreBackup(b);
				},
				onDelete: async (b) => {
					await this.deleteBackup(b);
				},
			}).open();
		})();
	}

	/* ---------------------------- Hub 操作 ---------------------------- */

	/**
	 * 校验 Hub 目录。
	 * create=true 时允许新建（初始化 / 推送场景），否则目录不存在就报错（分发场景，避免误建目录）。
	 */
	private async ensureHub(create: boolean): Promise<boolean> {
		if (!this.hubPath) {
			new Notice(this.t("notice.hubNotSet"));
			return false;
		}
		if (existsSync(this.hubPath)) return true;
		if (create) {
			await this.fs.mkdirp(this.hubPath);
			return true;
		}
		new Notice(this.t("err.hubMissing", { path: this.hubPath }));
		return false;
	}

	async initHubFromCurrent(): Promise<void> {
		if (!(await this.ensureHub(true))) return;
		const vaultPath = this.currentVaultPath;
		if (!vaultPath) {
			new Notice(this.t("notice.noVaultPath"));
			return;
		}
		try {
			this.logger.info(`初始化 Hub：${this.hubPath} ← ${vaultPath}`);
			const res = await pushToHub(
				this.fs,
				{ hubPath: this.hubPath, sourceVaultPath: vaultPath, rules: this.rules(), sourceVaultName: this.platform.getCurrentVaultName() },
				this.logger
			);
			new Notice(this.t("notice.hubInit", { version: res.configVersion }));
			this.invalidateStatus();
			this.refreshSettingsView();
		} catch (e) {
			new Notice(this.errMsg(e));
		}
	}

	async pushCurrentToHub(): Promise<void> {
		if (!(await this.ensureHub(true))) return;
		const vaultPath = this.currentVaultPath;
		if (!vaultPath) {
			new Notice(this.t("notice.noVaultPath"));
			return;
		}
		try {
			const res = await pushToHub(
				this.fs,
				{ hubPath: this.hubPath, sourceVaultPath: vaultPath, rules: this.rules(), sourceVaultName: this.platform.getCurrentVaultName() },
				this.logger
			);
			new Notice(this.t("notice.pushed", { version: res.configVersion }));
			this.lastConfigSignature = this.configSignature(vaultPath);
			this.invalidateStatus();
			this.refreshSettingsView();
			if (this.settings.remote.autoPushAfterHubPush) await this.pushAllRemotes();
		} catch (e) {
			new Notice(this.errMsg(e));
		}
	}

	async pullToCurrentVault(): Promise<void> {
		const vaultPath = this.currentVaultPath;
		if (!vaultPath) {
			new Notice(this.t("notice.noVaultPath"));
			return;
		}
		const target: VaultTarget = {
			path: vaultPath,
			name: this.platform.getCurrentVaultName() || path.basename(vaultPath),
			enabled: true,
		};
		await this.runSync([target], false);
	}

	/* ---------------------------- 同步流程 ---------------------------- */

	async syncAll(): Promise<void> {
		const targets = this.settings.targets.filter((t) => t.enabled);
		if (!targets.length) {
			new Notice(this.t("notice.noTargets"));
			return;
		}
		await this.runSync(targets, false);
	}

	async syncVault(target: VaultTarget): Promise<void> {
		await this.runSync([target], false);
	}

	async previewSync(): Promise<void> {
		const targets = this.settings.targets.filter((t) => t.enabled);
		const list = targets.length ? targets : this.currentVaultPath ? [{ path: this.currentVaultPath, name: "current", enabled: true }] : [];
		if (!list.length) {
			new Notice(this.t("notice.noTargets"));
			return;
		}
		await this.runSync(list, true);
	}

	private async runSync(targets: VaultTarget[], dryRun: boolean): Promise<SyncReport | null> {
		if (!(await this.ensureHub(false))) return null;
		if (!targets.length) {
			new Notice(this.t("notice.noTargets"));
			return null;
		}
		let plan: SyncPlan;
		try {
			plan = await planSync(
				this.fs,
				{ hubPath: this.hubPath, targets, rules: this.rules(), prune: this.settings.pruneExtraneous },
				this.logger
			);
		} catch (e) {
			new Notice(this.errMsg(e));
			return null;
		}

		const total = plan.plans.reduce(
			(acc, p) => acc + p.summary.create + p.summary.update + p.summary.delete,
			0
		);

		if (dryRun || (this.settings.confirmBeforeSync && total > 0)) {
			return new Promise<SyncReport | null>((resolve) => {
				new PreviewModal(this.app, this.t, plan, async () => {
					if (dryRun) {
						resolve(null);
						return;
					}
					resolve(await this.executePlan(plan));
				}).open();
			});
		}

		if (total === 0) {
			new Notice(this.t("notice.nothingToSync"));
			return null;
		}
		return this.executePlan(plan);
	}

	private async executePlan(plan: SyncPlan): Promise<SyncReport> {
		const report = await applyPlan(this.fs, plan, {
			hubPath: this.hubPath,
			backup: this.settings.backup,
			dryRun: false,
			rules: this.rules(),
			logger: this.logger,
		});

		new Notice(
			this.t("notice.syncDone", {
				success: report.totals.success,
				skipped: report.totals.skipped,
				failed: report.totals.failed,
			})
		);

		const touchedPlugins = plan.plans.some((p) => p.changes.some((c) => c.action !== "skip" && c.path.startsWith("plugins/")));
		if (touchedPlugins && report.totals.filesWritten > 0) {
			new Notice(this.t("notice.reloadHint"));
		}

		if (report.totals.failed > 0) new ResultModal(this.app, this.t, report).open();
		this.invalidateStatus();
		this.refreshSettingsView();
		return report;
	}

	/* ---------------------------- 目标库管理 ---------------------------- */

	async addTarget(p: string): Promise<boolean> {
		const clean = path.normalize(p.trim());
		if (!clean || !existsSync(clean)) {
			new Notice(this.t("targets.invalidPath"));
			return false;
		}
		if (!existsSync(vaultConfigDir(clean))) {
			new Notice(this.t("targets.invalidPath"));
			return false;
		}
		if (this.settings.targets.some((t) => t.path === clean)) {
			new Notice(this.t("targets.alreadyAdded"));
			return false;
		}
		this.settings.targets.push({ path: clean, name: path.basename(clean), enabled: true, manual: true });
		await this.saveSettings();
		return true;
	}

	async removeTarget(p: string): Promise<void> {
		this.settings.targets = this.settings.targets.filter((t) => t.path !== p);
		await this.saveSettings();
	}

	async refreshTargets(): Promise<void> {
		const { vaults } = await this.platform.discoverVaults();
		const known = new Set(this.settings.targets.map((t) => t.path));
		let added = 0;
		for (const v of vaults) {
			if (known.has(v.path)) continue;
			// 自动发现的库默认不启用，避免误写（NFR-03）
			this.settings.targets.push({ path: v.path, name: v.name, enabled: false });
			added++;
		}
		if (added) await this.saveSettings();
	}

	/** 计算各目标库相对 Hub 的状态（带缓存） */
	async computeStatuses(): Promise<Map<string, VaultSyncStatus>> {
		if (this.statusCache && Date.now() - this.statusCache.at < STATUS_CACHE_MS) return this.statusCache.map;
		const map = new Map<string, VaultSyncStatus>();
		if (!this.hubPath || !existsSync(this.hubPath)) {
			for (const t of this.settings.targets) map.set(t.path, "unknown");
			this.statusCache = { at: Date.now(), map };
			return map;
		}
		try {
			const plan = await planSync(
				this.fs,
				{
					hubPath: this.hubPath,
					targets: this.settings.targets,
					rules: this.rules(),
					prune: this.settings.pruneExtraneous,
				},
				new NullLogger()
			);
			for (const vp of plan.plans) {
				if (vp.error) map.set(vp.vaultPath, "uninitialized");
				else if (vp.summary.create + vp.summary.update + vp.summary.delete > 0) map.set(vp.vaultPath, "behind");
				else map.set(vp.vaultPath, "consistent");
			}
		} catch {
			for (const t of this.settings.targets) map.set(t.path, "unknown");
		}
		this.statusCache = { at: Date.now(), map };
		return map;
	}

	private invalidateStatus(): void {
		this.statusCache = null;
	}

	/**
	 * 设置页正打开时立即重绘，让 Hub 版本 / 目标库状态 / 云端 meta / 备份列表即时更新。
	 * 只有两个硬条件：容器还挂在 DOM 上、且用户没有正在输入（避免清空未完成的表单）。
	 * 注意不要用 Obsidian 内部的 isShown()——设置弹窗里它不一定返回期望值。
	 */
	refreshSettingsView(): void {
		const tab = this.settingsTab;
		if (!tab) return;
		try {
			const el = tab.containerEl as HTMLElement;
			if (!el || !el.isConnected) return;
			const active = document.activeElement;
			if (active instanceof HTMLElement && (active.tagName === "INPUT" || active.tagName === "TEXTAREA") && el.contains(active)) {
				return;
			}
			tab.display();
		} catch (e) {
			debugLog("refreshSettingsView 跳过：", e);
		}
	}

	/* ---------------------------- 备份与导入导出 ---------------------------- */

	async backupCurrentVault(): Promise<void> {
		const vaultPath = this.currentVaultPath;
		if (!vaultPath) {
			new Notice(this.t("notice.noVaultPath"));
			return;
		}
		const zip = await createVaultBackup(this.fs, {
			vaultPath,
			scope: this.settings.backup.scope,
			rules: this.rules(),
			label: "manual",
		});
		new Notice(zip ? this.t("backup.created", { name: path.basename(zip) }) : this.t("backup.empty"));
		this.refreshSettingsView();
	}

	async listBackups(vaultPath: string): Promise<BackupInfo[]> {
		return listVaultBackups(this.fs, vaultPath);
	}

	async restoreBackup(b: BackupInfo): Promise<void> {
		const vaultPath = this.currentVaultPath;
		if (!vaultPath) {
			new Notice(this.t("notice.noVaultPath"));
			return;
		}
		const res = await restoreBackup(this.fs, {
			vaultPath,
			zipPath: b.absPath,
			backupBefore: true,
			backupPolicy: this.settings.backup,
			deleteExtraneous: this.settings.backup.deleteExtraneousOnRestore,
		});
		new Notice(this.t("backup.restored", { count: res.restored }));
		new Notice(this.t("notice.reloadHint"));
		this.invalidateStatus();
		this.refreshSettingsView();
	}

	async deleteBackup(b: BackupInfo): Promise<void> {
		await this.fs.remove(b.absPath);
	}

	async exportCurrentVault(): Promise<void> {
		const vaultPath = this.currentVaultPath;
		if (!vaultPath) {
			new Notice(this.t("notice.noVaultPath"));
			return;
		}
		const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const outDir = this.hubPath ? path.join(this.hubPath, "exports") : path.join(vaultConfigDir(vaultPath), "configsync-hub");
		const outZip = path.join(outDir, `configsync-hub-${ts}.zip`);
		const count = await exportConfigZip(this.fs, { sourceVaultPath: vaultPath, outZipPath: outZip, rules: this.rules() });
		new Notice(this.t("notice.exported", { count, path: outZip }));
		revealPath(outZip);
	}

	async importZipToCurrent(): Promise<void> {
		const vaultPath = this.currentVaultPath;
		if (!vaultPath) {
			new Notice(this.t("notice.noVaultPath"));
			return;
		}
		const zipPath = await pickFile(this.app, ".zip");
		if (!zipPath) return;
		const res = await importConfigZip(this.fs, { zipPath, targetVaultPath: vaultPath, rules: this.rules(), backupBefore: true });
		new Notice(this.t("notice.imported", { count: res.restored }));
		new Notice(this.t("notice.reloadHint"));
		this.invalidateStatus();
		this.refreshSettingsView();
	}

	backupDir(vaultPath: string): string {
		return vaultBackupDir(vaultPath);
	}

	/* ---------------------------- 插件清单 ---------------------------- */

	/** 扫描 Hub 与当前库里的插件，刷新勾选列表的数据来源（注意：不要在这里重绘设置页，清单为空时会与 display() 互相触发死循环） */
	async scanPluginInventory(): Promise<PluginInventoryItem[]> {
		const dirs: string[] = [];
		if (this.hubPath && existsSync(this.hubPath)) dirs.push(hubConfigDir(this.hubPath));
		const vaultPath = this.currentVaultPath;
		if (vaultPath) dirs.push(vaultConfigDir(vaultPath));
		const items = await scanPluginInventory(this.fs, dirs, [PLUGIN_ID]);
		this.settings.pluginInventory = items;
		await this.saveSettings();
		return items;
	}

	/* ---------------------------- 云同步 ---------------------------- */

	openExternal(url: string): void {
		openExternalLink(url);
	}

	private activeRemotes(): RemoteConfig[] {
		return (this.settings.remotes ?? []).filter((r) => r.enabled);
	}

	/** 远端状态摘要（设置页列表用） */
	async remoteState(cfg: RemoteConfig): Promise<string> {
		const t = this.t;
		try {
			const meta = await getTransport(cfg.kind).readMeta(cfg);
			if (!meta) return t("remote.state.empty");
			return t("remote.state.meta", {
				version: meta.version || "-",
				at: meta.updatedAt ? new Date(meta.updatedAt).toLocaleString() : "-",
				size: Math.ceil(meta.bytes / 1024),
			});
		} catch (e) {
			return `${t("remote.state.error")}: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	async testRemote(cfg: RemoteConfig): Promise<void> {
		this.logger.info(`测试远端连接：${cfg.name}（${cfg.kind}）`);
		await getTransport(cfg.kind).test(cfg);
	}

	async authorizeRemote(cfg: RemoteConfig): Promise<void> {
		await authorizeRemote(cfg);
		await this.saveSettings();
	}

	/** 推送本地 Hub 快照到远端 */
	async pushRemote(cfg: RemoteConfig): Promise<void> {
		if (!(await this.ensureHub(true))) return;
		try {
			const res = await pushToRemote(this.fs, getTransport(cfg.kind), cfg, this.hubPath);
			cfg.lastPushVersion = res.version;
			cfg.lastSyncAt = new Date().toISOString();
			await this.saveSettings();
			new Notice(this.t("notice.remotePushed", { name: cfg.name, version: res.version }));
			this.logger.info(`已推送到远端 ${cfg.name}（${cfg.kind}）：v${res.version}，${res.bytes} 字节`);
			this.refreshSettingsView();
		} catch (e) {
			new Notice(this.errMsg(e));
		}
	}

	/**
	 * 从远端拉取快照并覆盖本地 Hub。
	 * force=true 时忽略版本比较（本地 Hub 文件被改坏但版本号没变的情况下用）。
	 */
	async pullRemote(cfg: RemoteConfig, opts: { force?: boolean } = {}): Promise<void> {
		if (!(await this.ensureHub(true))) return;
		try {
			const res = await pullFromRemote(this.fs, getTransport(cfg.kind), cfg, this.hubPath, {
				backup: this.settings.remote.backupHub,
				keepBackups: 5,
				force: opts.force === true,
			});
			cfg.lastPullVersion = res.version;
			cfg.lastSyncAt = new Date().toISOString();
			this.invalidateStatus();
			await this.saveSettings();
			if (res.comparison === "same") {
				new Notice(this.t("notice.remoteSame", { version: res.version }));
				this.refreshSettingsView();
				return;
			}
			new Notice(this.t("notice.remotePulled", { name: cfg.name, version: res.version, count: res.written }));
			new Notice(this.t("notice.reloadHint"));
			this.logger.info(`已从远端拉取 ${cfg.name}：v${res.version}，写入 ${res.written} 个文件`);
			this.refreshSettingsView();
		} catch (e) {
			new Notice(this.errMsg(e));
		}
	}

	async pushAllRemotes(): Promise<void> {
		const remotes = this.activeRemotes();
		if (!remotes.length) {
			new Notice(this.t("notice.noRemote"));
			return;
		}
		for (const r of remotes) await this.pushRemote(r);
	}

	async pullAllRemotes(): Promise<void> {
		const remotes = this.activeRemotes();
		if (!remotes.length) {
			new Notice(this.t("notice.noRemote"));
			return;
		}
		for (const r of remotes) await this.pullRemote(r);
	}

	async removeRemote(id: string): Promise<void> {
		this.settings.remotes = this.settings.remotes.filter((r) => r.id !== id);
		await this.saveSettings();
	}

	/** 启动时检查远端是否有更新（只比较版本，不下载） */
	private async checkRemoteOnStartup(): Promise<void> {
		if (!this.settings.remote.autoPullOnStartup || !this.hubPath) return;
		if (!existsSync(this.hubPath)) return;
		for (const cfg of this.activeRemotes()) {
			try {
				const plan = await planRemote(this.fs, getTransport(cfg.kind), cfg, this.hubPath);
				if (plan.comparison === "remote-newer" && plan.remoteMeta) {
					const notice = new Notice(
						this.t("notice.cloudUpdate", { name: cfg.name, version: plan.remoteMeta.version }),
						0
					);
					notice.noticeEl.addClass("configsync-hub-notice");
					notice.noticeEl.addEventListener("click", () => {
						notice.hide();
						void this.pullRemote(cfg);
					});
					return;
				}
			} catch {
				/* 启动检查失败不打扰用户 */
			}
		}
	}

	/* ------------------------- 启动检查 / 自动任务 ------------------------- */

	private async onLayoutReady(): Promise<void> {
		await this.refreshTargets();
		await this.scanPluginInventory();
		this.lastConfigSignature = this.configSignature(this.currentVaultPath);
		await this.checkRemoteOnStartup();
		if (!this.settings.startupCheck || !this.hubPath) return;
		if (!existsSync(this.hubPath)) return;

		try {
			const health = await checkHub(this.fs, this.hubPath);
			if (!health.ok) return;
			const vaultPath = this.currentVaultPath;
			if (!vaultPath) return;
			const plan = await planSync(
				this.fs,
				{
					hubPath: this.hubPath,
					targets: [{ path: vaultPath, name: path.basename(vaultPath), enabled: true }],
					rules: this.rules(),
					prune: this.settings.pruneExtraneous,
				},
				new NullLogger()
			);
			const vp = plan.plans[0];
			if (!vp || vp.error) return;
			if (vp.summary.create + vp.summary.update + vp.summary.delete === 0) return;

			const notice = new Notice(this.t("notice.updateAvailable", { version: plan.configVersion }), 0);
			notice.noticeEl.addClass("configsync-hub-notice");
			notice.noticeEl.addEventListener("click", () => {
				notice.hide();
				void this.pullToCurrentVault();
			});
		} catch {
			/* 启动检查失败不打扰用户 */
		}
	}

	/** 轮询 .obsidian 的修改时间签名；变更且防抖结束则自动推送 */
	async setupAutoPush(): Promise<void> {
		if (this.autoPushTimer !== null) {
			clearTimer(this.autoPushTimer);
			this.autoPushTimer = null;
		}
		if (!this.settings.autoPush) return;
		const vaultPath = this.currentVaultPath;
		if (!vaultPath) return;

		let pending: number | null = null;
		this.autoPushTimer = setRepeating(() => {
			const sig = this.configSignature(vaultPath);
			if (sig === this.lastConfigSignature) return;
			if (pending !== null) return;
			pending = setTimer(() => {
				pending = null;
				void this.pushCurrentToHub();
			}, this.settings.autoPushDebounceMs);
		}, AUTO_PUSH_POLL_MS);
		this.registerInterval(this.autoPushTimer);
	}

	private configSignature(vaultPath: string): string {
		if (!vaultPath) return "";
		const configDir = vaultConfigDir(vaultPath);
		if (!existsSync(configDir)) return "";
		let count = 0;
		let maxMtime = 0;
		const walk = (dir: string): void => {
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				return;
			}
			for (const name of names) {
				if (name === "configsync-hub" || name === "configsync-hub-backups" || name === ".git") continue;
				const abs = path.join(dir, name);
				let st;
				try {
					st = statSync(abs);
				} catch {
					continue;
				}
				if (st.isDirectory()) {
					walk(abs);
				} else {
					count++;
					if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
				}
			}
		};
		walk(configDir);
		return `${count}:${maxMtime}`;
	}

	setupPeriodicSync(): void {
		const minutes = this.settings.periodicSyncMinutes;
		if (!minutes || minutes <= 0) return;
		const id = setRepeating(() => void this.syncAll(), minutes * 60 * 1000);
		this.registerInterval(id);
	}

	/* ------------------------------ 杂项 ------------------------------ */

	errMsg(e: unknown): string {
		const msg = e instanceof Error ? e.message : String(e);
		return this.t("err.unknown", { msg });
	}

	/** 供设置页/命令使用的快捷入口 */
	hubConfigDir(): string {
		return hubConfigDir(this.hubPath);
	}

	async confirmAndRun(title: string, message: string, fn: () => Promise<void>): Promise<void> {
		new ConfirmModal(this.app, {
			title,
			message,
			confirmText: this.t("common.confirm"),
			cancelText: this.t("common.cancel"),
			onConfirm: fn,
		}).open();
	}
}

export type { LangPref };
