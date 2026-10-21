/**
 * 远端传输的统一入口：按 kind 取实现，并描述每种远端在 UI 上需要哪些配置字段。
 */

import { RemoteConfig, RemoteKind, RemoteKindMeta } from "../../core/types";
import { RemoteTransport } from "../../core/remote/types";
import { githubTransport, gitlabTransport, giteaTransport } from "./gitHost";
import { authorizeGoogleDrive, googleDriveTransport } from "./googledrive";
import { authorizeOneDrive, oneDriveTransport } from "./onedrive";
import { webdavTransport } from "./webdav";
import { localTransport } from "./local";

export interface RemoteFieldSpec {
	key: string;
	labelKey: string;
	descKey?: string;
	/** 敏感字段用密码框呈现 */
	secret?: boolean;
	optional?: boolean;
}

export interface RemoteSpec extends RemoteKindMeta {
	fields: RemoteFieldSpec[];
	/** 创建 OAuth 应用 / 获取 token 的说明页 */
	helpUrl?: string;
}

const PATH_FIELD: RemoteFieldSpec = { key: "path", labelKey: "remote.field.path", descKey: "remote.field.path.desc", optional: true };
const GIT_BASE_FIELD: RemoteFieldSpec = {
	key: "apiBase",
	labelKey: "remote.field.apiBase",
	descKey: "remote.field.apiBase.desc",
	optional: true,
};

export const REMOTE_SPECS: Record<RemoteKind, RemoteSpec> = {
	github: {
		id: "github",
		labelKey: "remote.kind.github",
		descKey: "remote.kind.github.desc",
		oauth: false,
		helpUrl: "https://github.com/settings/tokens/new?description=ConfigSync%20Hub&scopes=repo",
		fields: [
			{ key: "token", labelKey: "remote.field.token", descKey: "remote.field.token.desc", secret: true },
			{ key: "owner", labelKey: "remote.field.owner" },
			{ key: "repo", labelKey: "remote.field.repo" },
			{ key: "branch", labelKey: "remote.field.branch", optional: true },
			PATH_FIELD,
		],
	},
	gitlab: {
		id: "gitlab",
		labelKey: "remote.kind.gitlab",
		descKey: "remote.kind.gitlab.desc",
		oauth: false,
		helpUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
		fields: [
			{ key: "token", labelKey: "remote.field.token", descKey: "remote.field.token.desc", secret: true },
			{ key: "owner", labelKey: "remote.field.group" },
			{ key: "repo", labelKey: "remote.field.repo" },
			{ key: "branch", labelKey: "remote.field.branch", optional: true },
			GIT_BASE_FIELD,
			PATH_FIELD,
		],
	},
	gitea: {
		id: "gitea",
		labelKey: "remote.kind.gitea",
		descKey: "remote.kind.gitea.desc",
		oauth: false,
		fields: [
			{ key: "token", labelKey: "remote.field.token", descKey: "remote.field.token.desc", secret: true },
			{ key: "owner", labelKey: "remote.field.owner" },
			{ key: "repo", labelKey: "remote.field.repo" },
			{ key: "branch", labelKey: "remote.field.branch", optional: true },
			GIT_BASE_FIELD,
			PATH_FIELD,
		],
	},
	googledrive: {
		id: "googledrive",
		labelKey: "remote.kind.googledrive",
		descKey: "remote.kind.googledrive.desc",
		oauth: true,
		helpUrl: "https://console.cloud.google.com/apis/credentials",
		fields: [
			{ key: "clientId", labelKey: "remote.field.clientId", descKey: "remote.field.clientId.desc" },
			{ key: "clientSecret", labelKey: "remote.field.clientSecret", descKey: "remote.field.clientSecret.desc", secret: true, optional: true },
			{ key: "redirectPort", labelKey: "remote.field.redirectPort", descKey: "remote.field.redirectPort.desc", optional: true },
			{ key: "folderId", labelKey: "remote.field.folderId", descKey: "remote.field.folderId.desc", optional: true },
			PATH_FIELD,
		],
	},
	onedrive: {
		id: "onedrive",
		labelKey: "remote.kind.onedrive",
		descKey: "remote.kind.onedrive.desc",
		oauth: true,
		helpUrl: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
		fields: [
			{ key: "clientId", labelKey: "remote.field.clientIdAzure", descKey: "remote.field.clientIdAzure.desc" },
			{ key: "redirectPort", labelKey: "remote.field.redirectPort", descKey: "remote.field.redirectPort.desc", optional: true },
			PATH_FIELD,
		],
	},
	webdav: {
		id: "webdav",
		labelKey: "remote.kind.webdav",
		descKey: "remote.kind.webdav.desc",
		oauth: false,
		fields: [
			{ key: "url", labelKey: "remote.field.url", descKey: "remote.field.url.desc" },
			{ key: "user", labelKey: "remote.field.user" },
			{ key: "password", labelKey: "remote.field.password", descKey: "remote.field.password.desc", secret: true },
			PATH_FIELD,
		],
	},
	local: {
		id: "local",
		labelKey: "remote.kind.local",
		descKey: "remote.kind.local.desc",
		oauth: false,
		fields: [{ key: "dir", labelKey: "remote.field.dir", descKey: "remote.field.dir.desc" }, PATH_FIELD],
	},
};

const TRANSPORTS: Record<RemoteKind, RemoteTransport> = {
	github: githubTransport,
	gitlab: gitlabTransport,
	gitea: giteaTransport,
	googledrive: googleDriveTransport,
	onedrive: oneDriveTransport,
	webdav: webdavTransport,
	local: localTransport,
};

export function getTransport(kind: RemoteKind): RemoteTransport {
	const t = TRANSPORTS[kind];
	if (!t) throw new Error(`不支持的远端类型：${kind}`);
	return t;
}

/** 需要 OAuth 的远端走各自的授权流程，token 写回 cfg.options */
export async function authorizeRemote(cfg: RemoteConfig): Promise<void> {
	switch (cfg.kind) {
		case "googledrive":
			await authorizeGoogleDrive(cfg);
			return;
		case "onedrive":
			await authorizeOneDrive(cfg);
			return;
		default:
			throw new Error("该类型不需要 OAuth 授权，直接填写凭据即可");
	}
}

export function newRemoteConfig(kind: RemoteKind, name: string): RemoteConfig {
	return {
		id: `remote-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
		kind,
		name,
		enabled: true,
		options: {},
	};
}
