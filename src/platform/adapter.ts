/**
 * 平台适配层：把所有依赖 Obsidian / Electron 内部 API 的地方集中到这里（NFR-04 / §10 风险对策）。
 *
 * 若未来 `FileSystemAdapter.getBasePath()` 失效，只需改这一个文件，
 * 其余逻辑自动降级为「手动选择 vault 路径」。
 */

import { App, FileSystemAdapter } from "obsidian";
import { FsApi } from "../core/fs";
import { nodeFs } from "./nodeFs";
import { discoverVaults, VaultInfo } from "./vaultRegistry";

export interface PlatformAdapter {
	readonly fs: FsApi;
	/** 是否运行在桌面端（只有桌面端能读写 vault 之外的路径） */
	readonly isDesktop: boolean;
	readonly canAccessExternalFs: boolean;
	getCurrentVaultPath(): string | null;
	getCurrentVaultName(): string;
	discoverVaults(): Promise<{ vaults: VaultInfo[]; registryPath: string | null; warning?: string }>;
}

export function createNodeAdapter(app: App): PlatformAdapter {
	return {
		fs: nodeFs,
		isDesktop: true,
		canAccessExternalFs: true,

		getCurrentVaultPath(): string | null {
			try {
				const adapter = app.vault.adapter as FileSystemAdapter;
				if (adapter && typeof adapter.getBasePath === "function") {
					const base = adapter.getBasePath();
					if (base) return base;
				}
			} catch {
				/* 内部 API 不可用时返回 null，由调用方降级 */
			}
			return null;
		},

		getCurrentVaultName(): string {
			try {
				return app.vault.getName();
			} catch {
				return "";
			}
		},

		discoverVaults() {
			return discoverVaults(nodeFs);
		},
	};
}
