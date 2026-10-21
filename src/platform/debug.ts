/**
 * 控制台调试日志。
 *
 * Obsidian 插件指南明确要求：不要把诊断信息无条件打到开发者控制台。
 * 这里统一收口——默认完全静默，只有用户在「高级」Tab 打开开关
 * （或控制台执行 `window.configSyncDebug = true`）时才输出。
 */

const PREFIX = "[ConfigSync Hub]";

let enabled = false;

export function setDebugEnabled(value: boolean): void {
	enabled = value === true;
}

export function isDebugEnabled(): boolean {
	if (enabled) return true;
	try {
		const w = window as unknown as { configSyncDebug?: boolean } | undefined;
		return w?.configSyncDebug === true;
	} catch {
		return false;
	}
}

/* eslint-disable no-console */
export function debugLog(...args: unknown[]): void {
	if (!isDebugEnabled()) return;
	console.debug(PREFIX, ...args);
}

export function debugWarn(...args: unknown[]): void {
	if (!isDebugEnabled()) return;
	console.warn(PREFIX, ...args);
}
/* eslint-enable no-console */
