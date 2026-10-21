/** 同步日志文件输出（FR-704） */

import { appendFileSync, mkdirSync } from "fs";
import * as path from "path";
import { Logger, LogLevel } from "../core/logger";
import { clearTimer, setTimer } from "./timers";

export class FileLogger implements Logger {
	private buffer: string[] = [];
	private timer: number | null = null;

	constructor(
		private readonly opts: {
			getPath: () => string | null;
			isEnabled: () => boolean;
		}
	) {}

	private push(level: LogLevel, message: string): void {
		if (!this.opts.isEnabled()) return;
		const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
		this.buffer.push(line);
		if (this.timer !== null) return;
		this.timer = setTimer(() => {
			this.timer = null;
			this.flush();
		}, 400);
	}

	flush(): void {
		if (this.timer !== null) {
			clearTimer(this.timer);
			this.timer = null;
		}
		const lines = this.buffer.splice(0);
		if (!lines.length) return;
		const p = this.opts.getPath();
		if (!p) return;
		try {
			mkdirSync(path.dirname(p), { recursive: true });
			appendFileSync(p, lines.join("\n") + "\n", "utf8");
		} catch {
			/* 日志失败不应影响主流程 */
		}
	}

	debug(message: string): void {
		this.push("debug", message);
	}
	info(message: string): void {
		this.push("info", message);
	}
	warn(message: string): void {
		this.push("warn", message);
	}
	error(message: string): void {
		this.push("error", message);
	}
}
