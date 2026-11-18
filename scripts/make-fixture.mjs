// 生成仅含 ftyp box 的 fMP4 片段：结构合法但不含 emsg，
// 用于区分“已领取且确认零事件”与“来源缺失、不能宣称无事件”。
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const brand = 'iso5';
const payload = Buffer.concat([Buffer.from(brand, 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('iso5', 'ascii'), Buffer.from('dash', 'ascii')]);
const bytes = Buffer.alloc(8 + payload.length);
bytes.writeUInt32BE(bytes.length, 0);
bytes.write('ftyp', 4, 'ascii');
payload.copy(bytes, 8);
await writeFile(join(here, '..', 'fixtures', 'resource-06.bin'), bytes);
console.log(`resource-06.bin ${bytes.length} bytes`);
