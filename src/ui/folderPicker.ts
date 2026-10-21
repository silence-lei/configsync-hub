/**
 * 目录 / 文件选择器（UI 层）。
 *
 * 三级策略，前两级在 `src/platform/shell.ts`（Node / Electron 只能在平台层调用）：
 * 1. Obsidian 内部 `electronDialog`；
 * 2. 系统原生选择器（osascript / PowerShell / zenity）；
 * 3. 隐藏 `<input>` —— 最后兜底（Electron ≥32 已移除 `File.path`，需走 webUtils，
 *    且新版 Chromium 里隐藏 input 的 click 可能弹不出对话框，故优先级最低）。
 *
 * 诊断日志默认关闭，打开「高级 → 控制台调试日志」后才会打印走了哪一级。
 */

import { App } from "obsidian";
import { debugWarn } from "../platform/debug";
import { pathForFile, pickViaElectronDialog, pickViaShell, revealInFileManager } from "../platform/shell";

/** 最后兜底：隐藏 <input> */
function pickViaInput(directory: boolean, accept?: string): Promise<string | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		if (directory) {
			input.setAttribute("webkitdirectory", "");
			input.setAttribute("directory", "");
		}
		if (accept) input.accept = accept;
		input.style.display = "none";

		let settled = false;
		const finish = (value: string | null): void => {
			if (settled) return;
			settled = true;
			window.clearTimeout(guard);
			input.remove();
			resolve(value);
		};

		input.addEventListener("change", () => {
			const file = input.files && input.files[0];
			finish(file ? pathForFile(file) : null);
		});

		// 窗口重新获得焦点但没选东西 = 用户取消了；once 会自动解绑
		window.addEventListener(
			"focus",
			() => {
				window.setTimeout(() => {
					if (input.files && input.files.length) return;
					finish(null);
				}, 300);
			},
			{ once: true }
		);

		const guard = window.setTimeout(() => finish(null), 5 * 60 * 1000);

		document.body.appendChild(input);
		const el = input as HTMLInputElement & { showPicker?: () => void };
		if (typeof el.showPicker === "function") {
			try {
				el.showPicker();
				return;
			} catch (e) {
				debugWarn("showPicker failed, falling back to click", e);
			}
		}
		input.click();
	});
}

/** 选择目录；返回绝对路径，取消返回 null */
export async function pickDirectory(app?: App): Promise<string | null> {
	const opts = { kind: "directory" as const, prompt: "选择目录（作为配置中枢 Hub）" };

	const viaApi = pickViaElectronDialog(app, opts);
	if (viaApi !== undefined) return viaApi;

	const viaShell = await pickViaShell(opts);
	if (viaShell !== undefined) return viaShell;

	return pickViaInput(true);
}

/** 选择单个文件；返回绝对路径，取消返回 null */
export async function pickFile(app: App | undefined, accept?: string): Promise<string | null> {
	const ext = (accept || "").replace(/^\./, "") || "zip";
	const opts = { kind: "file" as const, ext, prompt: "选择 zip 文件" };

	const viaApi = pickViaElectronDialog(app, opts);
	if (viaApi !== undefined) return viaApi;

	const viaShell = await pickViaShell(opts);
	if (viaShell !== undefined) return viaShell;

	return pickViaInput(false, accept);
}

/** 尽力在系统文件管理器中显示路径，失败时返回 false 由调用方降级 */
export function revealPath(target: string): boolean {
	return revealInFileManager(target);
}
