/** 定时器封装：Obsidian 渲染进程里用 window，其他环境回退到全局定时器 */

export function setTimer(fn: () => void, ms: number): number {
	if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
		return window.setTimeout(fn, ms) as unknown as number;
	}
	return setTimeout(fn, ms) as unknown as number;
}

export function setRepeating(fn: () => void, ms: number): number {
	if (typeof window !== "undefined" && typeof window.setInterval === "function") {
		return window.setInterval(fn, ms) as unknown as number;
	}
	return setInterval(fn, ms) as unknown as number;
}

export function clearTimer(id: number | null): void {
	if (id === null) return;
	if (typeof window !== "undefined" && typeof window.clearTimeout === "function") {
		window.clearTimeout(id);
		window.clearInterval(id);
		return;
	}
	clearTimeout(id);
	clearInterval(id);
}
