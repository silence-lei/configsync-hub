/**
 * 系统外壳能力：原生目录/文件选择器、Electron 桥接。
 *
 * Obsidian 没有公开的「选择目录」API，可用手段在不同版本里各不相同：
 * 1. `app.electronDialog.showOpenDialogSync()` —— Obsidian 内部 API，部分版本存在；
 * 2. 系统原生选择器（macOS osascript / Windows PowerShell / Linux zenity|kdialog）——
 *    Electron 的 `dialog` 属于主进程模块，渲染进程里拿不到，只能借系统的；
 * 3. 隐藏 `<input>` —— 最后兜底，留在 `src/ui/folderPicker.ts`（需要 DOM）。
 *
 * 所有 Node / Electron 调用都收在这里，UI 层不直接碰。
 */

import { App } from "obsidian";
import { debugLog, debugWarn } from "./debug";
import { setTimer } from "./timers";

export type ShellPickKind = "directory" | "file";

export interface ShellPickOptions {
	kind: ShellPickKind;
	prompt: string;
	/** 文件模式下的扩展名过滤 */
	ext?: string;
}

interface OpenDialogOptions {
	properties?: string[];
	filters?: { name: string; extensions: string[] }[];
}

interface ElectronDialogApi {
	showOpenDialogSync(options: OpenDialogOptions): string[] | undefined;
}

/** 当前平台，取不到时返回 "other" */
export function platformKind(): "darwin" | "win32" | "linux" | "other" {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const p = (require("process") as { platform?: string }).platform;
		if (p === "darwin" || p === "win32" || p === "linux") return p;
	} catch {
		/* 忽略 */
	}
	return "other";
}

/** 判断某个可执行文件是否存在（Linux 下用于探测 zenity / kdialog） */
function hasBinary(name: string): boolean {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("fs") as { existsSync: (p: string) => boolean };
		return fs.existsSync(`/usr/bin/${name}`) || fs.existsSync(`/usr/local/bin/${name}`);
	} catch {
		return false;
	}
}

/** 策略 1：Obsidian 内部 electronDialog；不可用返回 undefined，取消返回 null */
export function pickViaElectronDialog(app: App | undefined, opts: ShellPickOptions): string | null | undefined {
	const dlg = (app as unknown as { electronDialog?: ElectronDialogApi } | undefined)?.electronDialog;
	if (!dlg || typeof dlg.showOpenDialogSync !== "function") return undefined;
	try {
		const res =
			opts.kind === "directory"
				? dlg.showOpenDialogSync({ properties: ["openDirectory", "createDirectory", "showHiddenFiles"] })
				: dlg.showOpenDialogSync({
						properties: ["openFile", "showHiddenFiles"],
						filters: [{ name: "ZIP", extensions: [opts.ext || "zip"] }],
				  });
		return res && res.length ? res[0] : null;
	} catch (e) {
		debugWarn("electronDialog 调用失败，降级", e);
		return undefined;
	}
}

/** 生成各平台的原生选择命令（不可用时返回 null） */
function shellCommand(opts: ShellPickOptions): { cmd: string; args: string[] } | null {
	try {
		const prompt = opts.prompt.replace(/'/g, "");
		switch (platformKind()) {
			case "darwin": {
				const script =
					opts.kind === "directory"
						? `POSIX path of (choose folder with prompt "${prompt}")`
						: `POSIX path of (choose file with prompt "${prompt}")`;
				return { cmd: "osascript", args: ["-e", script] };
			}
			case "win32": {
				const script =
					opts.kind === "directory"
						? "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '" +
						  prompt +
						  "'; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }"
						: "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = '" +
						  prompt +
						  "'; $d.Filter = 'Zip archive (*.zip)|*.zip|All files (*.*)|*.*'; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }";
				return { cmd: "powershell", args: ["-NoProfile", "-STA", "-Command", script] };
			}
			case "linux": {
				if (hasBinary("zenity")) {
					return {
						cmd: "zenity",
						args: opts.kind === "directory" ? ["--file-selection", "--directory", `--title=${prompt}`] : ["--file-selection", `--title=${prompt}`],
					};
				}
				if (hasBinary("kdialog")) {
					return { cmd: "kdialog", args: opts.kind === "directory" ? ["--getexistingdirectory", prompt] : ["--getopenfilename", ".", prompt] };
				}
				return null;
			}
			default:
				return null;
		}
	} catch (e) {
		debugWarn("原生选择器不可用", e);
		return null;
	}
}

/** 策略 2：系统原生选择器（异步执行，不阻塞渲染进程） */
export function pickViaShell(opts: ShellPickOptions): Promise<string | null | undefined> {
	const spec = shellCommand(opts);
	if (!spec) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		let settled = false;
		const done = (v: string | null): void => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const cp = require("child_process") as {
				spawn: (
					c: string,
					a: string[],
					o?: unknown
				) => {
					stdout: { on: (ev: string, cb: (d: unknown) => void) => void } | null;
					on: (ev: string, cb: (arg: unknown) => void) => void;
				};
			};
			const child = cp.spawn(spec.cmd, spec.args, { windowsHide: true });
			let out = "";
			child.stdout?.on("data", (d: unknown) => (out += String(d)));
			child.on("error", (e: unknown) => {
				debugWarn("原生选择器启动失败", e);
				done(null);
			});
			child.on("close", (code: unknown) => {
				const p = out.trim().split("\n")[0]?.trim() || "";
				done(code === 0 && p ? p : null);
			});
			// 兜底：5 分钟没动静就放弃
			setTimer(() => done(null), 5 * 60 * 1000);
		} catch (e) {
			debugWarn("原生选择器异常", e);
			done(null);
		}
	});
}

/** 从 File 对象尽力取绝对路径（兼容新旧 Electron） */
export function pathForFile(file: File): string | null {
	const direct = (file as File & { path?: string }).path;
	if (direct) return direct;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const electron = require("electron") as { webUtils?: { getPathForFile?: (f: File) => string } };
		const p = electron?.webUtils?.getPathForFile?.(file);
		if (p) return p;
	} catch {
		/* 忽略 */
	}
	return null;
}

/** 尽力在系统文件管理器中显示路径，失败时返回 false 由调用方降级 */
export function revealInFileManager(target: string): boolean {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const electron = require("electron") as { shell?: { showItemInFolder?: (p: string) => void; openPath?: (p: string) => void } };
		const shell = electron?.shell;
		if (shell?.showItemInFolder) {
			shell.showItemInFolder(target);
			return true;
		}
		if (shell?.openPath) {
			shell.openPath(target);
			return true;
		}
	} catch (e) {
		debugLog("revealInFileManager 不可用", e);
	}
	return false;
}
