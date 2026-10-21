/** 设置页：中枢 Hub / 目标库 / 同步内容 / 备份与恢复 / 高级（FR-701） */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ConfigSyncPlugin from "../main";
import { CATEGORIES, ConfigSyncSettings, defaultSettings, PluginInventoryItem, RemoteConfig, VaultTarget } from "../core/types";
import { checkHub } from "../core/engine";
import { hubConfigDir, vaultBackupDir } from "../core/paths";
import { parseList } from "../core/rules";
import { pickDirectory, revealPath } from "./folderPicker";
import { BackupListModal, ConfirmModal, formatSize } from "./modals";
import { LangPref } from "../i18n";
import { newRemoteConfig, REMOTE_SPECS } from "../platform/remote";
import { RemoteEditModal } from "./remoteModal";
import { setDebugEnabled } from "../platform/debug";

type TabId = "hub" | "targets" | "content" | "cloud" | "backup" | "advanced";

const TABS: { id: TabId; key: string }[] = [
	{ id: "hub", key: "tab.hub" },
	{ id: "targets", key: "tab.targets" },
	{ id: "content", key: "tab.content" },
	{ id: "cloud", key: "tab.cloud" },
	{ id: "backup", key: "tab.backup" },
	{ id: "advanced", key: "tab.advanced" },
];

export class ConfigSyncSettingTab extends PluginSettingTab {
	private active: TabId = "hub";

	constructor(app: App, private readonly plugin: ConfigSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("configsync-hub-settings");
		this.pluginListEl = null;

		const nav = containerEl.createDiv({ cls: "configsync-hub-nav" });
		for (const tab of TABS) {
			const btn = nav.createEl("button", { text: this.plugin.t(tab.key) });
			if (tab.id === this.active) btn.addClass("is-active");
			btn.onClickEvent(() => {
				this.active = tab.id;
				this.display();
			});
		}

		const body = containerEl.createDiv({ cls: "configsync-hub-body" });
		switch (this.active) {
			case "hub":
				void this.renderHub(body);
				break;
			case "targets":
				void this.renderTargets(body);
				break;
			case "content":
				void this.renderContent(body);
				break;
			case "cloud":
				void this.renderCloud(body);
				break;
			case "backup":
				void this.renderBackup(body);
				break;
			case "advanced":
				this.renderAdvanced(body);
				break;
		}

		// 底部版本标记：便于确认当前加载的是哪次构建
		containerEl.createEl("p", {
			text: `ConfigSync Hub v${this.plugin.manifest.version}`,
			cls: "configsync-hub-version",
		});
	}

	/* ------------------------------- Hub ------------------------------- */

	private async renderHub(body: HTMLElement): Promise<void> {
		const t = this.plugin.t;
		const s = this.plugin.settings;

		new Setting(body).setName(t("hub.title")).setDesc(t("hub.desc")).setHeading();

		new Setting(body)
			.setName(t("hub.path"))
			.setDesc(t("hub.pathDesc"))
			.addText((text) =>
				text
					.setPlaceholder(t("hub.pathPlaceholder"))
					.setValue(s.hubPath)
					.onChange(async (v) => {
						s.hubPath = v.trim();
						await this.plugin.saveSettings();
					})
			)
			.addButton((b) =>
				b.setButtonText(t("common.browse")).onClick(async () => {
					const picked = await pickDirectory(this.app);
					if (picked) {
						s.hubPath = picked;
						await this.plugin.saveSettings();
						this.display();
					}
				})
			)
			.addButton((b) =>
				b.setButtonText(t("hub.openFolder")).onClick(() => {
					if (!s.hubPath) {
						new Notice(t("notice.hubNotSet"));
						return;
					}
					if (!revealPath(s.hubPath)) new Notice(s.hubPath);
				})
			);

		const healthEl = body.createDiv({ cls: "configsync-hub-health" });
		await this.renderHubHealth(healthEl);

		new Setting(body)
			.setName(t("hub.init"))
			.setDesc(t("hub.initDesc"))
			.addButton((b) =>
				b
					.setButtonText(t("hub.init"))
					.setWarning()
					.onClick(() => {
						const vaultPath = this.plugin.currentVaultPath;
						if (!s.hubPath) {
							new Notice(t("notice.hubNotSet"));
							return;
						}
						if (!vaultPath) {
							new Notice(t("notice.noVaultPath"));
							return;
						}
						new ConfirmModal(this.app, {
							title: t("hub.initConfirmTitle"),
							message: t("hub.initConfirmDesc", { vault: vaultPath, hub: s.hubPath }),
							confirmText: t("common.confirm"),
							cancelText: t("common.cancel"),
							danger: true,
							onConfirm: async () => {
								await this.plugin.initHubFromCurrent();
								this.display();
							},
						}).open();
					})
			);

		new Setting(body)
			.setName(t("hub.push"))
			.setDesc(t("hub.pushDesc"))
			.addButton((b) => b.setButtonText(t("hub.push")).onClick(() => void this.plugin.pushCurrentToHub()));

		new Setting(body)
			.setName(t("hub.pull"))
			.setDesc(t("hub.pullDesc"))
			.addButton((b) => b.setButtonText(t("hub.pull")).setCta().onClick(() => void this.plugin.pullToCurrentVault()));
	}

	private async renderHubHealth(el: HTMLElement): Promise<void> {
		const t = this.plugin.t;
		const s = this.plugin.settings;
		el.empty();
		if (!s.hubPath) {
			el.createEl("p", { text: t("hub.health.empty") });
			return;
		}
		const health = await checkHub(this.plugin.platform.fs, s.hubPath);
		const box = el.createDiv({ cls: `configsync-hub-health-box is-${health.level}` });
		box.createEl("div", { text: `${t("hub.health")}：${health.message}` });
		if (health.manifest) {
			const m = health.manifest;
			const info = box.createEl("div", { cls: "configsync-hub-muted" });
			info.appendText(`${t("hub.version")}: ${m.configVersion} · `);
			info.appendText(`${t("hub.fileCount")}: ${m.files.length} · `);
			info.appendText(`${t("hub.updatedAt")}: ${new Date(m.updatedAt).toLocaleString()}`);
			if (m.sourceVault) info.appendText(` · ${t("hub.source")}: ${m.sourceVault}`);
		}
	}

	/* ----------------------------- 目标库 ----------------------------- */

	private async renderTargets(body: HTMLElement): Promise<void> {
		const t = this.plugin.t;
		const s = this.plugin.settings;

		new Setting(body).setName(t("targets.title")).setDesc(t("targets.desc")).setHeading();

		new Setting(body).addButton((b) =>
			b
				.setButtonText(t("targets.syncAll"))
				.setCta()
				.onClick(() => void this.plugin.syncAll())
		);

		// 手动添加
		let manualPath = "";
		new Setting(body)
			.setName(t("targets.manual"))
			.setDesc(t("targets.manualDesc"))
			.addText((text) =>
				text
					.setPlaceholder(t("targets.manualPlaceholder"))
					.onChange((v) => {
						manualPath = v.trim();
					})
			)
			.addButton((b) =>
				b.setButtonText(t("common.browse")).onClick(async () => {
					const picked = await pickDirectory(this.app);
					if (!picked) return;
					await this.plugin.addTarget(picked);
					this.display();
				})
			)
			.addButton((b) =>
				b.setButtonText(t("common.add")).onClick(async () => {
					if (!manualPath) return;
					await this.plugin.addTarget(manualPath);
					this.display();
				})
			);

		// 已发现但尚未加入列表的 vault
		const known = new Set(s.targets.map((x) => x.path));
		const discovered = (await this.plugin.platform.discoverVaults()).vaults.filter((v) => !known.has(v.path));
		if (discovered.length) {
			new Setting(body).setName(t("targets.discovered")).setDesc(t("targets.discoveredDesc", { path: "" }));
			for (const v of discovered) {
				new Setting(body)
					.setName(v.name)
					.setDesc(v.path)
					.addButton((b) =>
						b.setButtonText(t("common.add")).onClick(async () => {
							await this.plugin.addTarget(v.path);
							this.display();
						})
					);
			}
		}

		new Setting(body).addButton((b) =>
			b.setButtonText(t("targets.rescan")).onClick(async () => {
				await this.plugin.refreshTargets();
				this.display();
			})
		);

		const listEl = body.createDiv({ cls: "configsync-hub-vault-list" });
		if (!s.targets.length) {
			listEl.createEl("p", { text: t("targets.empty") });
			return;
		}

		const statuses = await this.plugin.computeStatuses();
		for (const target of s.targets) {
			this.renderVaultRow(listEl, target, statuses.get(target.path) ?? "unknown");
		}
	}

	private renderVaultRow(parent: HTMLElement, target: VaultTarget, status: string): void {
		const t = this.plugin.t;
		const isCurrent = this.plugin.currentVaultPath === target.path;
		const statusKey = `targets.status.${status}` as const;

		const row = new Setting(parent)
			.setName(`${target.name}${isCurrent ? ` · ${t("common.currentVault")}` : ""}`)
			.setDesc(`${target.path} · ${t(statusKey)}`)
			.addToggle((tg) =>
				tg.setValue(target.enabled).onChange(async (v) => {
					target.enabled = v;
					await this.plugin.saveSettings();
				})
			)
			.addButton((b) =>
				b.setButtonText(t("targets.sync")).onClick(async () => {
					await this.plugin.syncVault(target);
					this.display();
				})
			)
			.addButton((b) =>
				b
					.setButtonText(t("common.remove"))
					.setWarning()
					.onClick(() => {
						new ConfirmModal(this.app, {
							title: t("common.remove"),
							message: t("targets.removeConfirm", { name: target.name }),
							confirmText: t("common.remove"),
							cancelText: t("common.cancel"),
							danger: true,
							onConfirm: async () => {
								await this.plugin.removeTarget(target.path);
								this.display();
							},
						}).open();
					})
			);
		if (!target.enabled) row.setClass("configsync-hub-dim");
	}

	/* ---------------------------- 同步内容 ---------------------------- */

	private async renderContent(body: HTMLElement): Promise<void> {
		const t = this.plugin.t;
		const s = this.plugin.settings;

		new Setting(body).setName(t("content.title")).setDesc(t("content.desc")).setHeading();

		new Setting(body).setName(t("content.categories")).setHeading();
		for (const cat of CATEGORIES) {
			const row = new Setting(body)
				.setName(t(cat.labelKey))
				.setDesc(t(cat.descKey))
				.addToggle((tg) =>
					tg.setValue(s.categories[cat.id] !== false).onChange(async (v) => {
						s.categories[cat.id] = v;
						await this.plugin.saveSettings();
					})
				);

			// 「社区插件本体」折叠展开：展开后直接在该项下面逐插件勾选
			if (cat.id === "plugins") {
				const count = (s.pluginInventory ?? []).length;
				row.addButton((b) =>
					b
						.setButtonText(
							`${this.pluginsExpanded ? "▾" : "▸"} ${t("content.toggleList", { count })}`
						)
						.onClick(async () => {
							this.pluginsExpanded = !this.pluginsExpanded;
							if (this.pluginsExpanded && !(this.plugin.settings.pluginInventory ?? []).length) {
								await this.plugin.scanPluginInventory();
							}
							this.display();
						})
				);
				if (this.pluginsExpanded) await this.renderPluginList(body);
			}
		}

		new Setting(body)
			.setName(t("content.excludedPlugins"))
			.setDesc(t("content.excludedPluginsDesc"))
			.setClass("configsync-hub-textarea")
			.addTextArea((ta) =>
				ta
					.setPlaceholder(t("content.excludedPluginsPlaceholder"))
					.setValue(s.excludedPlugins.join("\n"))
					.onChange(async (v) => {
						s.excludedPlugins = parseList(v);
						await this.plugin.saveSettings();
					})
			);

		new Setting(body)
			.setName(t("content.excludedPaths"))
			.setDesc(t("content.excludedPathsDesc"))
			.setClass("configsync-hub-textarea")
			.addTextArea((ta) =>
				ta
					.setPlaceholder(t("content.excludedPathsPlaceholder"))
					.setValue(s.excludedPaths.join("\n"))
					.onChange(async (v) => {
						s.excludedPaths = parseList(v);
						await this.plugin.saveSettings();
					})
			);

		new Setting(body)
			.setName(t("content.prune"))
			.setDesc(t("content.pruneDesc"))
			.addToggle((tg) =>
				tg.setValue(s.pruneExtraneous).onChange(async (v) => {
					s.pruneExtraneous = v;
					await this.plugin.saveSettings();
				})
			);

		body.createEl("p", { text: t("content.hint"), cls: "configsync-hub-muted" });
	}

	/* -------------------------- 逐插件勾选 -------------------------- */

	private pluginFilter = "";
	/** 「社区插件本体」下的插件清单是否展开 */
	private pluginsExpanded = false;
	/** 插件行容器，用于局部重绘 */
	private pluginListEl: HTMLElement | null = null;

	/** 「社区插件本体」展开后的内联插件清单 */
	private async renderPluginList(body: HTMLElement): Promise<void> {
		const t = this.plugin.t;
		const s = this.plugin.settings;

		const items: PluginInventoryItem[] = s.pluginInventory ?? [];
		if (!items.length) {
			body.createEl("p", { text: t("content.pluginEmpty"), cls: "configsync-hub-muted" });
			return;
		}

		if (s.categories.plugins === false) {
			body.createEl("p", { text: t("content.categoryOffHint"), cls: "configsync-hub-muted" });
		}

		// 操作行：搜索 + 全选/全不选 + 重新扫描（搜索框在这里，避免重绘时丢失焦点）
		new Setting(body)
			.setName(t("content.pluginCount", { selected: items.filter((p) => s.pluginSelection[p.id] !== false).length, total: items.length }))
			.setDesc(t("content.pluginListDesc"))
			.setClass("configsync-hub-plugin-heading")
			.addSearch((search) =>
				search
					.setPlaceholder(t("content.pluginSearch"))
					.setValue(this.pluginFilter)
					.onChange((v) => {
						this.pluginFilter = v;
						this.renderPluginRows();
					})
			)
			.addButton((b) =>
				b.setButtonText(t("content.selectAll")).onClick(async () => {
					for (const p of items) s.pluginSelection[p.id] = true;
					await this.plugin.saveSettings();
					this.renderPluginRows();
				})
			)
			.addButton((b) =>
				b.setButtonText(t("content.selectNone")).onClick(async () => {
					for (const p of items) s.pluginSelection[p.id] = false;
					await this.plugin.saveSettings();
					this.renderPluginRows();
				})
			)
			.addButton((b) =>
				b.setButtonText(t("content.rescan")).onClick(async () => {
					await this.plugin.scanPluginInventory();
					this.display();
				})
			);

		this.pluginListEl = body.createDiv({ cls: "configsync-hub-plugin-list" });
		this.renderPluginRows();
	}

	/** 只重绘插件行（不动搜索框，避免输入焦点丢失） */
	private renderPluginRows(): void {
		const el = this.pluginListEl;
		if (!el) return;
		const t = this.plugin.t;
		const s = this.plugin.settings;
		el.empty();

		const filter = this.pluginFilter.trim().toLowerCase();
		const list = (s.pluginInventory ?? []).filter(
			(p) => !filter || p.id.toLowerCase().includes(filter) || (p.name ?? "").toLowerCase().includes(filter)
		);

		if (!list.length) {
			el.createEl("p", { text: t("content.pluginNoMatch"), cls: "configsync-hub-muted" });
			return;
		}

		for (const p of list) {
			const meta = `${p.id}${p.version ? ` · ${p.version}` : ""}`;
			const row = new Setting(el)
				.setName(p.name || p.id)
				.setDesc(p.name ? meta : meta + (p.desc ? ` — ${p.desc}` : ""))
				.addToggle((tg) =>
					tg.setValue(s.pluginSelection[p.id] !== false).onChange(async (v) => {
						s.pluginSelection[p.id] = v;
						await this.plugin.saveSettings();
					})
				);
			if (s.pluginSelection[p.id] === false) row.setClass("configsync-hub-dim");
		}
	}

	/* ---------------------------- 云同步 ---------------------------- */

	private async renderCloud(body: HTMLElement): Promise<void> {
		const t = this.plugin.t;
		const s = this.plugin.settings;

		new Setting(body).setName(t("cloud.title")).setDesc(t("cloud.desc")).setHeading();

		new Setting(body)
			.setName(t("cloud.autoPullOnStartup"))
			.setDesc(t("cloud.autoPullOnStartupDesc"))
			.addToggle((tg) =>
				tg.setValue(s.remote.autoPullOnStartup).onChange(async (v) => {
					s.remote.autoPullOnStartup = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(body)
			.setName(t("cloud.autoPushAfterHubPush"))
			.setDesc(t("cloud.autoPushAfterHubPushDesc"))
			.addToggle((tg) =>
				tg.setValue(s.remote.autoPushAfterHubPush).onChange(async (v) => {
					s.remote.autoPushAfterHubPush = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(body)
			.setName(t("cloud.backupHub"))
			.setDesc(t("cloud.backupHubDesc"))
			.addToggle((tg) =>
				tg.setValue(s.remote.backupHub).onChange(async (v) => {
					s.remote.backupHub = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(body)
			.setName(t("cloud.syncAll"))
			.setDesc(t("cloud.syncAllDesc"))
			.addButton((b) => b.setButtonText(t("cloud.pushAll")).onClick(() => void this.plugin.pushAllRemotes()))
			.addButton((b) => b.setButtonText(t("cloud.pullAll")).setCta().onClick(() => void this.plugin.pullAllRemotes()));

		// 新增远端
		let newKind = REMOTE_SPECS.github.id;
		let newName = "";
		new Setting(body)
			.setName(t("cloud.add"))
			.setDesc(t("cloud.addDesc"))
			.addDropdown((dd) => {
				for (const kind of Object.values(REMOTE_SPECS)) dd.addOption(kind.id, t(kind.labelKey));
				dd.setValue(newKind).onChange((v) => {
					newKind = v as typeof newKind;
				});
			})
			.addText((tx) =>
				tx.setPlaceholder(t("cloud.addPlaceholder")).onChange((v) => {
					newName = v.trim();
				})
			)
			.addButton((b) =>
				b
					.setButtonText(t("common.add"))
					.setCta()
					.onClick(() => {
						// 先只生成草稿，保存后才会真正写入 settings
						const draft = newRemoteConfig(newKind, newName || REMOTE_SPECS[newKind].id);
						this.openRemoteEditor(draft, true);
					})
			);

		if (!s.remotes.length) {
			body.createEl("p", { text: t("cloud.empty"), cls: "configsync-hub-muted" });
			return;
		}

		const listEl = body.createDiv({ cls: "configsync-hub-remote-list" });
		for (const cfg of s.remotes) {
			await this.renderRemoteRow(listEl, cfg);
		}
	}

	private async renderRemoteRow(parent: HTMLElement, cfg: RemoteConfig): Promise<void> {
		const t = this.plugin.t;
		const spec = REMOTE_SPECS[cfg.kind];
		const state = await this.plugin.remoteState(cfg);

		const row = new Setting(parent)
			.setName(`${cfg.name || t("remote.unnamed")} · ${t(spec.labelKey)}`)
			.setDesc(state)
			.addToggle((tg) =>
				tg.setValue(cfg.enabled).onChange(async (v) => {
					cfg.enabled = v;
					await this.plugin.saveSettings();
				})
			)
			.addButton((b) => b.setButtonText(t("remote.edit")).onClick(() => this.openRemoteEditor(cfg)))
			.addButton((b) => b.setButtonText(t("remote.push")).onClick(() => void this.plugin.pushRemote(cfg)))
			.addButton((b) => b.setButtonText(t("remote.pull")).setCta().onClick(() => void this.plugin.pullRemote(cfg)))
			.addButton((b) =>
				b
					.setButtonText(t("common.remove"))
					.setWarning()
					.onClick(() => {
						new ConfirmModal(this.app, {
							title: t("common.remove"),
							message: t("remote.removeConfirm", { name: cfg.name }),
							confirmText: t("common.remove"),
							cancelText: t("common.cancel"),
							danger: true,
							onConfirm: async () => {
								await this.plugin.removeRemote(cfg.id);
								this.display();
							},
						}).open();
					})
			);
		if (!cfg.enabled) row.setClass("configsync-hub-dim");
	}

	/** @param isNew true 表示这是一个尚未写入 settings 的草稿 */
	private openRemoteEditor(cfg: RemoteConfig, isNew = false): void {
		const t = this.plugin.t;
		const draft: RemoteConfig = { ...cfg, options: { ...cfg.options } };
		new RemoteEditModal(this.app, t, draft, {
			onSave: async (remote) => {
				const s = this.plugin.settings;
				const idx = s.remotes.findIndex((r) => r.id === remote.id);
				if (idx >= 0) s.remotes[idx] = remote;
				else s.remotes.push(remote);
				await this.plugin.saveSettings();
				new Notice(t("notice.remoteSaved", { name: remote.name }));
				this.display();
			},
			onDiscard: () => {
				// 草稿未被写入 settings，无需回滚，只刷新列表
				if (isNew) this.display();
			},
			onTest: async (remote) => {
				try {
					await this.plugin.testRemote(remote);
					new Notice(t("notice.remoteOk", { name: remote.name }));
				} catch (e) {
					new Notice(this.plugin.errMsg(e));
				}
			},
			onAuthorize: async (remote) => {
				await this.plugin.authorizeRemote(remote);
				await this.plugin.saveSettings();
			},
			onPush: async (remote) => {
				await this.plugin.pushRemote(remote);
				this.display();
			},
			onPull: async (remote) => {
				await this.plugin.pullRemote(remote);
				this.display();
			},
			onForcePull: async (remote) => {
				await this.plugin.pullRemote(remote, { force: true });
				this.display();
			},
			openHelp: (url) => this.plugin.openExternal(url),
		}).open();
	}

	/* --------------------------- 备份与恢复 --------------------------- */

	private async renderBackup(body: HTMLElement): Promise<void> {
		const t = this.plugin.t;
		const s = this.plugin.settings;
		const vaultPath = this.plugin.currentVaultPath;

		new Setting(body).setName(t("backup.title")).setHeading();

		new Setting(body)
			.setName(t("backup.auto"))
			.setDesc(t("backup.autoDesc"))
			.addToggle((tg) =>
				tg.setValue(s.backup.enabled).onChange(async (v) => {
					s.backup.enabled = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(body)
			.setName(t("backup.keep"))
			.setDesc(t("backup.keepDesc"))
			.addText((text) =>
				text
					.setValue(String(s.backup.keep))
					.onChange(async (v) => {
						const n = Number.parseInt(v, 10);
						s.backup.keep = Number.isFinite(n) && n > 0 ? n : 10;
						await this.plugin.saveSettings();
					})
			);

		new Setting(body)
			.setName(t("backup.scope"))
			.setDesc(t("backup.scopeDesc"))
			.addDropdown((dd) =>
				dd
					.addOption("full", t("backup.scope.full"))
					.addOption("affected", t("backup.scope.affected"))
					.setValue(s.backup.scope)
					.onChange(async (v) => {
						s.backup.scope = v === "affected" ? "affected" : "full";
						await this.plugin.saveSettings();
					})
			);

		new Setting(body)
			.setName(t("backup.restoreDelete"))
			.setDesc(t("backup.restoreDeleteDesc"))
			.addToggle((tg) =>
				tg.setValue(s.backup.deleteExtraneousOnRestore).onChange(async (v) => {
					s.backup.deleteExtraneousOnRestore = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(body)
			.setName(t("backup.manual"))
			.setDesc(t("backup.manualDesc"))
			.addButton((b) => b.setButtonText(t("backup.manual")).onClick(() => void this.plugin.backupCurrentVault()));

		new Setting(body)
			.setName(t("backup.export"))
			.setDesc(t("backup.exportDesc"))
			.addButton((b) => b.setButtonText(t("backup.export")).onClick(() => void this.plugin.exportCurrentVault()));

		new Setting(body)
			.setName(t("backup.import"))
			.setDesc(t("backup.importDesc"))
			.addButton((b) => b.setButtonText(t("backup.import")).onClick(() => void this.plugin.importZipToCurrent()));

		new Setting(body)
			.setName(t("backup.list"))
			.setDesc(t("backup.listDesc", { dir: vaultPath ? vaultBackupDir(vaultPath) : "-" }))
			.setHeading()
			.addButton((b) =>
				b.setButtonText(t("common.refresh")).onClick(() => {
					this.display();
				})
			);

		const backups = vaultPath ? await this.plugin.listBackups(vaultPath) : [];
		const listEl = body.createDiv({ cls: "configsync-hub-backup-list" });
		if (!backups.length) {
			listEl.createEl("p", { text: t("backup.empty") });
			return;
		}
		for (const b of backups) {
			new Setting(listEl)
				.setName(b.name)
				.setDesc(`${formatSize(b.size)} · ${new Date(b.mtimeMs).toLocaleString()}`)
				.addButton((btn) =>
					btn.setButtonText(t("backup.restore")).onClick(() => {
						new ConfirmModal(this.app, {
							title: t("backup.restoreConfirmTitle"),
							message: t("backup.restoreConfirmDesc", { name: b.name }),
							confirmText: t("backup.restore"),
							cancelText: t("common.cancel"),
							danger: true,
							onConfirm: async () => {
								await this.plugin.restoreBackup(b);
								this.display();
							},
						}).open();
					})
				)
				.addButton((btn) =>
					btn
						.setButtonText(t("backup.delete"))
						.setWarning()
						.onClick(async () => {
							await this.plugin.deleteBackup(b);
							this.display();
						})
				);
		}
	}

	/* ------------------------------ 高级 ------------------------------ */

	private renderAdvanced(body: HTMLElement): void {
		const t = this.plugin.t;
		const s = this.plugin.settings;

		new Setting(body).setName(t("advanced.title")).setHeading();

		new Setting(body)
			.setName(t("advanced.startupCheck"))
			.setDesc(t("advanced.startupCheckDesc"))
			.addToggle((tg) =>
				tg.setValue(s.startupCheck).onChange(async (v) => {
					s.startupCheck = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(body)
			.setName(t("advanced.autoPush"))
			.setDesc(t("advanced.autoPushDesc"))
			.addToggle((tg) =>
				tg.setValue(s.autoPush).onChange(async (v) => {
					s.autoPush = v;
					await this.plugin.saveSettings();
					await this.plugin.setupAutoPush();
				})
			);

		new Setting(body)
			.setName(t("advanced.autoPushDebounce"))
			.addText((text) =>
				text.setValue(String(s.autoPushDebounceMs)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					s.autoPushDebounceMs = Number.isFinite(n) && n >= 500 ? n : 3000;
					await this.plugin.saveSettings();
				})
			);

		new Setting(body)
			.setName(t("advanced.periodic"))
			.setDesc(t("advanced.periodicDesc"))
			.addText((text) =>
				text.setValue(String(s.periodicSyncMinutes)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					s.periodicSyncMinutes = Number.isFinite(n) && n >= 0 ? n : 0;
					await this.plugin.saveSettings();
					await this.plugin.setupPeriodicSync();
				})
			);

		new Setting(body)
			.setName(t("advanced.log"))
			.setDesc(t("advanced.logDesc"))
			.addToggle((tg) =>
				tg.setValue(s.enableLog).onChange(async (v) => {
					s.enableLog = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(body)
			.setName(t("advanced.debugConsole"))
			.setDesc(t("advanced.debugConsoleDesc"))
			.addToggle((tg) =>
				tg.setValue(s.debugConsole).onChange(async (v) => {
					s.debugConsole = v;
					await this.plugin.saveSettings();
					setDebugEnabled(v);
				})
			);

		new Setting(body)
			.addButton((b) => b.setButtonText(t("advanced.openLog")).onClick(() => this.plugin.revealLog()))
			.addButton((b) =>
				b
					.setButtonText(t("advanced.clearLog"))
					.setWarning()
					.onClick(async () => {
						await this.plugin.clearLog();
						new Notice(t("notice.logCleared"));
					})
			);

		new Setting(body)
			.setName(t("advanced.language"))
			.setDesc(t("advanced.languageDesc"))
			.addDropdown((dd) => {
				const opts: LangPref[] = ["auto", "zh", "en"];
				for (const o of opts) dd.addOption(o, t(`advanced.language.${o}` as string));
				dd.setValue(s.language).onChange(async (v) => {
					s.language = v as LangPref;
					await this.plugin.saveSettings();
					await this.plugin.refreshTranslator();
					this.display();
				});
			});

		new Setting(body)
			.setName(t("advanced.confirmBeforeSync"))
			.setDesc(t("advanced.confirmBeforeSyncDesc"))
			.addToggle((tg) =>
				tg.setValue(s.confirmBeforeSync).onChange(async (v) => {
					s.confirmBeforeSync = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(body)
			.setName(t("advanced.reset"))
			.setDesc(t("advanced.resetDesc"))
			.addButton((b) =>
				b
					.setButtonText(t("advanced.reset"))
					.setWarning()
					.onClick(() => {
						new ConfirmModal(this.app, {
							title: t("advanced.reset"),
							message: t("advanced.resetConfirm"),
							confirmText: t("advanced.reset"),
							cancelText: t("common.cancel"),
							danger: true,
							onConfirm: async () => {
								const fresh: ConfigSyncSettings = defaultSettings();
								Object.assign(this.plugin.settings, fresh);
								await this.plugin.saveSettings();
								this.display();
							},
						}).open();
					})
			);
	}

	/** 供命令调用：直接打开备份列表 */
	openBackupList(): void {
		void (async () => {
			const vaultPath = this.plugin.currentVaultPath;
			if (!vaultPath) {
				new Notice(this.plugin.t("notice.noVaultPath"));
				return;
			}
			const backups = await this.plugin.listBackups(vaultPath);
			new BackupListModal(this.app, this.plugin.t, backups, {
				onRestore: async (b) => {
					await this.plugin.restoreBackup(b);
					this.display();
				},
				onDelete: async (b) => {
					await this.plugin.deleteBackup(b);
				},
			}).open();
		})();
	}
}
