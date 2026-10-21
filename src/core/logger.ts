/** 同步日志（FR-704） */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
	at: string;
	level: LogLevel;
	message: string;
}

export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export class CollectingLogger implements Logger {
	readonly entries: LogEntry[] = [];

	private push(level: LogLevel, message: string): void {
		this.entries.push({ at: new Date().toISOString(), level, message });
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

	toString(): string {
		return this.entries.map((e) => `[${e.at}] ${e.level.toUpperCase()} ${e.message}`).join("\n");
	}
}

export class NullLogger implements Logger {
	debug(): void {
		/* noop */
	}
	info(): void {
		/* noop */
	}
	warn(): void {
		/* noop */
	}
	error(): void {
		/* noop */
	}
}

/** 转发到多个 Logger（如同时写文件与内存） */
export class MultiLogger implements Logger {
	constructor(private readonly targets: Logger[]) {}
	debug(m: string): void {
		this.targets.forEach((t) => t.debug(m));
	}
	info(m: string): void {
		this.targets.forEach((t) => t.info(m));
	}
	warn(m: string): void {
		this.targets.forEach((t) => t.warn(m));
	}
	error(m: string): void {
		this.targets.forEach((t) => t.error(m));
	}
}
