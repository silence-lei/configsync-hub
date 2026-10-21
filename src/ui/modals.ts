/** 各类弹窗：确认、同步预览、结果报告、备份列表 */

import { App, Modal, Notice, Setting } from "obsidian";
import { SyncPlan } from "../core/engine";
import { SyncReport, VaultResult } from "../core/engine";
import { BackupInfo } from "../core/backup";
import { Translate } from "../i18n";

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly opts: {
			title: string;
			message: string;
			confirmText: string;
			cancelText: string;
			danger?: boolean;
			onConfirm: () => void | Promise<void>;
		}
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(this.opts.title);
		for (const line of this.opts.message.split("\n")) {
			contentEl.createEl("p", { text: line });
		}
		new Setting(contentEl)
			.addButton((b) => {
				b.setButtonText(this.opts.confirmText).setCta();
				if (this.opts.danger) b.setWarning();
				b.onClick(async () => {
					this.close();
					await this.opts.onConfirm();
				});
			})
			.addButton((b) => b.setButtonText(this.opts.cancelText).onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class PreviewModal extends Modal {
	constructor(
		app: App,
		private readonly t: Translate,
		private readonly plan: SyncPlan,
		private readonly onConfirm: () => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const t = this.t;
		const { contentEl, titleEl } = this;
		titleEl.setText(t("modal.preview.title"));

		const total = this.plan.plans.reduce(
			(acc, p) => ({
				create: acc.create + p.summary.create,
				update: acc.update + p.summary.update,
				delete: acc.delete + p.summary.delete,
			}),
			{ create: 0, update: 0, delete: 0 }
		);

		if (total.create + total.update + total.delete === 0) {
			contentEl.createEl("p", { text: t("modal.preview.nothing") });
			return;
		}

		contentEl.createEl("p", {
			text: `${t("modal.preview.desc")} ${total.create} / ${total.update} / ${total.delete}（新增/更新/删除）`,
		});

		const list = contentEl.createDiv({ cls: "configsync-hub-preview" });
		for (const vp of this.plan.plans) {
			if (vp.summary.create + vp.summary.update + vp.summary.delete === 0) continue;
			const details = list.createEl("details");
			details.createEl("summary", {
				text: `${vp.vaultName} — +${vp.summary.create} ~${vp.summary.update} -${vp.summary.delete}`,
			});
			const ul = details.createEl("ul");
			for (const c of vp.changes) {
				if (c.action === "skip") continue;
				const mark = c.action === "create" ? "+" : c.action === "update" ? "~" : "-";
				ul.createEl("li", { text: `${mark} ${c.path}`, cls: `configsync-hub-${c.action}` });
			}
		}

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText(t("common.confirm"))
					.setCta()
					.onClick(async () => {
						this.close();
						await this.onConfirm();
					})
			)
			.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ResultModal extends Modal {
	constructor(app: App, private readonly t: Translate, private readonly report: SyncReport) {
		super(app);
	}

	onOpen(): void {
		const t = this.t;
		const { contentEl, titleEl } = this;
		const r = this.report;
		titleEl.setText(t("modal.result.title"));
		contentEl.createEl("p", {
			text: t("modal.result.summary", { version: r.configVersion, ms: r.durationMs }),
		});
		contentEl.createEl("p", {
			text: t("notice.syncDone", { success: r.totals.success, skipped: r.totals.skipped, failed: r.totals.failed }),
		});

		for (const res of r.results) {
			const details = contentEl.createEl("details");
			details.createEl("summary", { text: `${statusIcon(res.status)} ${res.vaultName}（${res.status}）` });
			const body = details.createDiv();
			body.createEl("div", {
				text: `+${res.summary.create} ~${res.summary.update} -${res.summary.delete} =${res.summary.skip}`,
			});
			if (res.error) body.createEl("div", { text: res.error, cls: "configsync-hub-error" });
			if (res.backupPath) body.createEl("div", { text: res.backupPath, cls: "configsync-hub-muted" });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function statusIcon(status: VaultResult["status"]): string {
	if (status === "success") return "✓";
	if (status === "failed") return "✗";
	if (status === "dry-run") return "◦";
	return "=";
}

export interface BackupListHandlers {
	onRestore: (b: BackupInfo) => void | Promise<void>;
	onDelete: (b: BackupInfo) => void | Promise<void>;
}

export class BackupListModal extends Modal {
	constructor(
		app: App,
		private readonly t: Translate,
		private readonly backups: BackupInfo[],
		private readonly handlers: BackupListHandlers
	) {
		super(app);
	}

	onOpen(): void {
		const t = this.t;
		const { contentEl, titleEl } = this;
		titleEl.setText(t("modal.backups.title"));
		if (!this.backups.length) {
			contentEl.createEl("p", { text: t("modal.backups.empty") });
			return;
		}
		for (const b of this.backups) {
			const row = new Setting(contentEl).setName(b.name).setDesc(`${formatSize(b.size)} · ${new Date(b.mtimeMs).toLocaleString()}`);
			row.addButton((btn) => btn.setButtonText(t("backup.restore")).onClick(async () => {
				this.close();
				await this.handlers.onRestore(b);
			}));
			row.addButton((btn) =>
				btn.setButtonText(t("backup.delete")).setWarning().onClick(async () => {
					await this.handlers.onDelete(b);
					this.close();
					// 删除后重新打开以刷新列表
					new Notice(t("backup.deleted"));
				})
			);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
