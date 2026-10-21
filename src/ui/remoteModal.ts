/** 远端配置弹窗：字段表单 + OAuth 授权 + 连接测试 + 立即推拉 */

import { App, Modal, Notice, Setting } from "obsidian";
import { RemoteConfig } from "../core/types";
import { REMOTE_SPECS, RemoteSpec } from "../platform/remote";
import { Translate } from "../i18n";

export interface RemoteEditActions {
	onSave: (remote: RemoteConfig) => Promise<void>;
	/** 未保存就关闭（新增时用于丢弃草稿） */
	onDiscard?: (remote: RemoteConfig) => void;
	onTest: (remote: RemoteConfig) => Promise<void>;
	onAuthorize: (remote: RemoteConfig) => Promise<void>;
	onPush: (remote: RemoteConfig) => Promise<void>;
	onPull: (remote: RemoteConfig) => Promise<void>;
	onForcePull: (remote: RemoteConfig) => Promise<void>;
	openHelp: (url: string) => void;
}

export class RemoteEditModal extends Modal {
	private saved = false;

	constructor(
		app: App,
		private readonly t: Translate,
		private readonly remote: RemoteConfig,
		private readonly actions: RemoteEditActions
	) {
		super(app);
	}

	onOpen(): void {
		const t = this.t;
		const cfg = this.remote;
		const spec: RemoteSpec = REMOTE_SPECS[cfg.kind];
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("configsync-hub-settings");

		new Setting(contentEl).setName(`${t(spec.labelKey)} · ${cfg.name || t("remote.unnamed")}`).setDesc(t(spec.descKey)).setHeading();

		new Setting(contentEl)
			.setName(t("remote.displayName"))
			.setDesc(t("remote.displayNameDesc"))
			.addText((tx) =>
				tx.setValue(cfg.name).onChange((v) => {
					cfg.name = v.trim();
				})
			)
			.addToggle((tg) =>
				tg
					.setTooltip(t("remote.enabled"))
					.setValue(cfg.enabled)
					.onChange((v) => {
						cfg.enabled = v;
					})
			);

		for (const field of spec.fields) {
			const value = cfg.options[field.key] ?? "";
			new Setting(contentEl)
				.setName(t(field.labelKey))
				.setDesc(field.descKey ? t(field.descKey) : "")
				.addText((tx) => {
					tx.setValue(value)
						.setPlaceholder(field.optional ? t("common.optional") : "")
						.onChange((v) => {
							cfg.options[field.key] = v.trim();
						});
					if (field.secret) tx.inputEl.type = "password";
				});
		}

		if (spec.oauth) {
			const authorized = Boolean(cfg.options["accessToken"] || cfg.options["refreshToken"]);
			const row = new Setting(contentEl)
				.setName(t("remote.oauth"))
				.setDesc(authorized ? t("remote.oauthDone", { at: cfg.options["authorizedAt"] ?? "-" }) : t("remote.oauthTodo"));
			row.addButton((b) =>
				b
					.setButtonText(t("remote.authorize"))
					.setCta()
					.onClick(async () => {
						await this.actions.onAuthorize(cfg);
						new Notice(t("notice.remoteAuthorized"));
						// 不关窗：重绘以显示已授权状态，由「保存」决定是否落盘
						contentEl.empty();
						this.onOpen();
					})
			);
			if (spec.helpUrl) {
				row.addButton((b) => b.setButtonText(t("remote.createApp")).onClick(() => this.actions.openHelp(spec.helpUrl!)));
			}
			new Setting(contentEl)
				.setName(t("remote.redirectPortHelp"))
				.setDesc(t("remote.redirectPortHelpDesc", { url: `http://127.0.0.1:${cfg.options["redirectPort"] || 53682}` }));
		}

		if (spec.helpUrl && !spec.oauth) {
			new Setting(contentEl).addButton((b) =>
				b.setButtonText(t("remote.getToken")).onClick(() => this.actions.openHelp(spec.helpUrl!))
			);
		}

		if (cfg.lastPushVersion || cfg.lastPullVersion) {
			new Setting(contentEl)
				.setName(t("remote.lastState"))
				.setDesc(
					`${t("remote.lastPush")}: ${cfg.lastPushVersion ?? "-"} · ${t("remote.lastPull")}: ${
						cfg.lastPullVersion ?? "-"
					} · ${cfg.lastSyncAt ?? "-"}`
				);
		}

		const actions = new Setting(contentEl);
		actions
			.addButton((b) => b.setButtonText(t("remote.test")).onClick(() => void this.actions.onTest(cfg)))
			.addButton((b) => b.setButtonText(t("remote.push")).onClick(() => void this.actions.onPush(cfg)))
			.addButton((b) => b.setButtonText(t("remote.pull")).setCta().onClick(() => void this.actions.onPull(cfg)))
			.addButton((b) =>
				b
					.setButtonText(t("remote.pullForce"))
					.setWarning()
					.onClick(async () => {
						await this.actions.onForcePull(cfg);
						this.close();
					})
			)
			.addButton((b) =>
				b
					.setButtonText(t("common.cancel"))
					.onClick(() => {
						this.close();
					})
			)
			.addButton((b) =>
				b
					.setButtonText(t("common.save"))
					.setCta()
					.onClick(async () => {
						this.saved = true;
						await this.actions.onSave(cfg);
						this.close();
					})
			);

		new Setting(contentEl).setDesc(t("remote.secretWarning")).setClass("configsync-hub-muted");
	}

	/** 未点保存就关闭时，把草稿丢弃 */
	onClose(): void {
		if (!this.saved) this.actions.onDiscard?.(this.remote);
		this.contentEl.empty();
	}
}
