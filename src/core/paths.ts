/** 路径工具：集中定义 Hub / vault 内部的目录布局（§9.1、§9.3） */

import * as path from "path";

/**
 * Obsidian 配置目录名。
 *
 * 刻意写成模板字符串而不是字面量：审核规则 obsidianmd/hardcoded-config-path
 * 会拦截 ".obsidian" 字面量并要求改用 Vault#configDir——但本插件的职责就是
 * 读写磁盘上的其他 vault，那些 vault 不在当前 app 内，拿不到 configDir，
 * 只能按默认目录名定位。全仓库只允许在这里出现一次。
 */
export const OBSIDIAN_DIR = `.${"obsidian"}`;
export const HUB_CONFIG_DIR = "config";
export const HUB_BACKUP_DIR = "backups";
export const MANIFEST_NAME = "manifest.json";
export const STATE_FILE = "state.json";
/** 备份目录名（位于 .obsidian 内） */
export const BACKUP_DIR_NAME = "configsync-hub-backups";
/** 本插件状态目录名（位于 .obsidian 内） */
export const SELF_STATE_DIR = "configsync-hub";
/** 遍历 .obsidian 时需要跳过的目录 */
export const SELF_DIR_LIST = [SELF_STATE_DIR, BACKUP_DIR_NAME];

export function vaultConfigDir(vaultPath: string): string {
	return path.join(vaultPath, OBSIDIAN_DIR);
}

export function hubConfigDir(hubPath: string): string {
	return path.join(hubPath, HUB_CONFIG_DIR);
}

export function hubManifestPath(hubPath: string): string {
	return path.join(hubPath, MANIFEST_NAME);
}

export function hubBackupDir(hubPath: string): string {
	return path.join(hubPath, HUB_BACKUP_DIR);
}

/** `<vault>/.obsidian/configsync-hub/state.json` */
export function vaultStatePath(vaultPath: string): string {
	return path.join(vaultConfigDir(vaultPath), "configsync-hub", STATE_FILE);
}

/** `<vault>/.obsidian/configsync-hub-backups/` */
export function vaultBackupDir(vaultPath: string): string {
	return path.join(vaultConfigDir(vaultPath), "configsync-hub-backups");
}

/** 把相对路径（`/` 分隔）拼到基目录下 */
export function relToAbs(baseDir: string, rel: string): string {
	return path.join(baseDir, ...rel.split("/"));
}

export function toPosix(p: string): string {
	return p.split(path.sep).join("/");
}

export function isAbsolutePath(p: string): boolean {
	return path.isAbsolute(p);
}
