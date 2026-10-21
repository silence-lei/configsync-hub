/**
 * 同步计划器：比对 Hub 清单与目标库现状，产出「要做什么」的清单。
 *
 * 纯函数，不触碰文件系统（NFR-05）。Dry-run 与真实同步共用同一份计划（FR-307）。
 */

import { FileEntry } from "./types";
import { pluginIdOf } from "./rules";

export type FileAction = "create" | "update" | "delete" | "skip";

export interface PlannedFile {
	/** .obsidian 内相对路径 */
	path: string;
	action: FileAction;
	hubHash?: string;
	localHash?: string;
	/** Hub 侧文件大小 */
	size: number;
	pluginId?: string | null;
}

export interface PlanSummary {
	create: number;
	update: number;
	delete: number;
	skip: number;
	/** 预计写入字节数 */
	bytes: number;
}

export interface LocalFileInfo {
	h: string;
	s: number;
	m: number;
}

export interface VaultPlan {
	/** 目标库绝对路径 */
	vaultPath: string;
	vaultName: string;
	changes: PlannedFile[];
	summary: PlanSummary;
	/** 计划阶段就失败（如目标库不存在） */
	error?: string;
}

export interface PlanOptions {
	/** 是否删除 Hub 中已不存在的文件 */
	prune: boolean;
}

function emptySummary(): PlanSummary {
	return { create: 0, update: 0, delete: 0, skip: 0, bytes: 0 };
}

export function planVault(
	vaultPath: string,
	vaultName: string,
	hub: Map<string, FileEntry>,
	local: Map<string, LocalFileInfo>,
	opts: PlanOptions
): VaultPlan {
	const changes: PlannedFile[] = [];
	const summary = emptySummary();

	for (const [rel, entry] of hub) {
		const l = local.get(rel);
		if (!l) {
			changes.push({ path: rel, action: "create", hubHash: entry.sha256, size: entry.size, pluginId: pluginIdOf(rel) });
			summary.create++;
			summary.bytes += entry.size;
		} else if (l.h !== entry.sha256) {
			changes.push({
				path: rel,
				action: "update",
				hubHash: entry.sha256,
				localHash: l.h,
				size: entry.size,
				pluginId: pluginIdOf(rel),
			});
			summary.update++;
			summary.bytes += entry.size;
		} else {
			changes.push({ path: rel, action: "skip", hubHash: entry.sha256, size: entry.size, pluginId: pluginIdOf(rel) });
			summary.skip++;
		}
	}

	if (opts.prune) {
		for (const [rel, info] of local) {
			if (hub.has(rel)) continue;
			changes.push({ path: rel, action: "delete", localHash: info.h, size: info.s, pluginId: pluginIdOf(rel) });
			summary.delete++;
		}
	}

	// 变更项排在前面，跳过项在后，便于预览
	changes.sort((a, b) => {
		const rank = (x: FileAction) => (x === "skip" ? 1 : 0);
		if (rank(a.action) !== rank(b.action)) return rank(a.action) - rank(b.action);
		return a.path.localeCompare(b.path);
	});

	return { vaultPath, vaultName, changes, summary };
}

export function planIsEmpty(plan: VaultPlan): boolean {
	return plan.summary.create === 0 && plan.summary.update === 0 && plan.summary.delete === 0;
}
