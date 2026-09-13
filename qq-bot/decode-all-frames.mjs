/**
 * 解出 DSH 会话文件里的【全部】 zstd 帧。
 *
 * 背景：session.v3.jsonl.zstd 是逐帧追加的 —— 单个 zstdDecompressSync 只返回
 * 第一帧（可能只有 205 字节的 session 头），而文件本身有几十 KB。
 * 必须循环解帧才能拿到完整事件流。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
const outFile = process.argv[3];

if (!file) {
  console.error('用法: node decode-all-frames.mjs <session.v3.jsonl.zstd> [输出文件]');
  process.exit(2);
}

const buf = readFileSync(file);
console.log(`压缩文件: ${buf.length} bytes`);

const chunks = [];
let offset = 0;
let frame = 0;

while (offset < buf.length) {
  const slice = buf.subarray(offset);
  let result;
  try {
    result = zstdDecompressSync(slice, { info: true });
  } catch (error) {
    console.log(`\n第 ${frame + 1} 帧解码失败 @offset ${offset}: ${error.message}`);
    break;
  }
  frame += 1;
  const text = result.buffer.toString('utf8');
  chunks.push(text);
  const consumed = result.engine.bytesWritten;
  const written = result.engine.bytesRead ?? consumed;
  console.log(`  帧 ${frame}: 消耗 ${consumed} bytes → 解出 ${text.length} 字符`);
  if (!consumed || consumed <= 0) {
    console.log('  （无法推进偏移，停止）');
    break;
  }
  offset += consumed;
}

const full = chunks.join('');
console.log(`\n共 ${frame} 帧，合计 ${full.length} 字符`);
console.log(`换行数: ${(full.match(/\n/g) || []).length}`);

console.log('\n--- 关键词计数 ---');
for (const n of ['silverwolf-tts', 'dsh_im_return_file', 'tool/call', 'tool/result', '.wav', 'artifact', 'isError', 'voice']) {
  let c = 0, from = 0;
  for (;;) {
    const i = full.indexOf(n, from);
    if (i < 0) break;
    c += 1; from = i + n.length;
  }
  console.log(`  ${n}: ${c}`);
}

if (outFile) {
  writeFileSync(outFile, full, 'utf8');
  console.log(`\n已写出: ${outFile}`);
}
