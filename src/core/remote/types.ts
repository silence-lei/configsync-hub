/**
 * 远端同步抽象层。
 *
 * 设计要点：所有云平台只负责搬运「一个 Hub 快照 zip + 一份 meta」，
 * 与 Hub 内部结构解耦；这里定义的数据模型不含任何网络实现，便于单元测试。
 */

import { RemoteConfig, RemoteKind, RemoteSnapshotMeta } from "../types";

/** 传输层需要实现的最小接口（实现放在 src/platform/remote/） */
export interface RemoteTransport {
	readonly kind: RemoteKind;
	/** 读取远端 meta，不存在返回 null */
	readMeta(cfg: RemoteConfig): Promise<RemoteSnapshotMeta | null>;
	/** 下载远端快照内容 */
	download(cfg: RemoteConfig): Promise<{ meta: RemoteSnapshotMeta; data: Buffer }>;
	/** 上传快照与 meta */
	upload(cfg: RemoteConfig, snapshot: Buffer, meta: RemoteSnapshotMeta): Promise<void>;
	/** 连通性自检，失败请 throw Error(可直接展示的消息) */
	test(cfg: RemoteConfig): Promise<void>;
}

/** 远端与本地 Hub 的比较结果 */
export type RemoteComparison =
	/** 远端比本地新 */
	| "remote-newer"
	/** 本地比远端新 */
	| "local-newer"
	/** 版本一致 */
	| "same"
	/** 远端还没有快照 */
	| "empty";

export function compareVersions(local: string | undefined, remote: string | undefined): RemoteComparison {
	if (!remote) return "empty";
	if (!local) return "remote-newer";
	if (local === remote) return "same";
	// 版本号形如 `2026.09.30-3`，可直接按字典序比较
	return remote > local ? "remote-newer" : "local-newer";
}
