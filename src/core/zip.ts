/**
 * 极简 ZIP 读写实现（仅依赖 node:zlib）。
 *
 * Obsidian 插件不能引入第三方依赖，因此自实现一个够用的 ZIP：
 * 写入使用 deflate（体积显著变小则压缩，否则 store），读取支持 store 与 deflate。
 * 备份（FR-501）与导入导出（FR-504/505）都基于它。
 */

type Zlib = {
	deflateRawSync(d: Buffer): Buffer;
	inflateRawSync(d: Buffer): Buffer;
};

let zlibCache: Zlib | null | undefined;
function getZlib(): Zlib | null {
	if (zlibCache !== undefined) return zlibCache;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires -- 打包产物是 CJS，动态 require zlib 以启用 deflate 压缩，不可用时回退 store 模式
		zlibCache = require("zlib") as Zlib;
	} catch {
		zlibCache = null;
	}
	return zlibCache;
}

/* ------------------------------ CRC32 ------------------------------ */

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[i] = c >>> 0;
	}
	return t;
})();

export function crc32(data: Buffer): number {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------ 写入 ------------------------------ */

export interface ZipEntryInput {
	name: string;
	data: Buffer;
}

export interface ZipEntryOutput {
	name: string;
	data: Buffer;
}

function dosDateTime(d: Date): { time: number; date: number } {
	const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
	const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
	return { time, date };
}

export function createZip(entries: ZipEntryInput[], now: Date = new Date()): Buffer {
	const { time, date } = dosDateTime(now);
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const e of entries) {
		const nameBuf = Buffer.from(e.name, "utf8");
		const crc = crc32(e.data);

		let method = 0;
		let payload = e.data;
		const z = getZlib();
		if (z && e.data.length > 128) {
			try {
				const deflated = z.deflateRawSync(e.data);
				if (deflated.length < e.data.length) {
					method = 8;
					payload = deflated;
				}
			} catch {
				method = 0;
			}
		}

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(e.data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x0014, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(date, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(e.data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);

		locals.push(local, nameBuf, payload);
		centrals.push(central, nameBuf);
		offset += local.length + nameBuf.length + payload.length;
	}

	const centralBuf = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ------------------------------ 读取 ------------------------------ */

export function readZip(buf: Buffer): ZipEntryOutput[] {
	const eocdIdx = findSignature(buf, 0x06054b50, buf.length - 4, Math.max(0, buf.length - 65557));
	if (eocdIdx < 0) throw new Error("不是有效的 zip 文件（未找到 EOCD）");
	const count = buf.readUInt16LE(eocdIdx + 10);
	let cdOffset = buf.readUInt32LE(eocdIdx + 16);

	const out: ZipEntryOutput[] = [];
	const z = getZlib();
	let cursor = cdOffset;
	for (let i = 0; i < count; i++) {
		if (buf.readUInt32LE(cursor) !== 0x02014b50) throw new Error("zip 中央目录损坏");
		const method = buf.readUInt16LE(cursor + 10);
		const compSize = buf.readUInt32LE(cursor + 20);
		const uncompSize = buf.readUInt32LE(cursor + 24);
		const nameLen = buf.readUInt16LE(cursor + 28);
		const extraLen = buf.readUInt16LE(cursor + 30);
		const commentLen = buf.readUInt16LE(cursor + 32);
		const localOffset = buf.readUInt32LE(cursor + 42);
		const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLen);
		cursor += 46 + nameLen + extraLen + commentLen;

		const localNameLen = buf.readUInt16LE(localOffset + 26);
		const localExtraLen = buf.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLen + localExtraLen;
		let data = buf.subarray(dataStart, dataStart + compSize);
		if (method === 8) {
			if (!z) throw new Error("当前环境不支持解压 deflate 条目");
			data = z.inflateRawSync(Buffer.from(data));
		} else if (method !== 0) {
			throw new Error(`不支持的压缩方式：${method}`);
		}
		if (uncompSize && data.length !== uncompSize) {
			throw new Error(`条目 ${name} 解压后大小不符`);
		}
		out.push({ name, data: Buffer.from(data) });
	}
	return out;
}

/** 在 [from, to] 区间内从后往前查找 4 字节小端签名 */
function findSignature(buf: Buffer, sig: number, from: number, to: number): number {
	for (let i = from; i >= to && i >= 0; i--) {
		if (buf.readUInt32LE(i) === sig) return i;
	}
	return -1;
}
