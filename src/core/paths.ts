/** 路径工具：集中定义 Hub / vault 内部的目录布局（§9.1、§9.3） */

import * as path from "path";

export const OBSIDIAN_DIR = ".obsidian";
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
