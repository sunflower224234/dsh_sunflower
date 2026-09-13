/** 转储 DSH 会话 zstd 事件的解压原文，便于人工排查 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
const mode = process.argv[3] ?? 'head';

const text = zstdDecompressSync(readFileSync(file)).toString('utf8');

console.log(`解压后长度: ${text.length}`);
console.log(`换行数: ${(text.match(/\n/g) || []).length}`);

const needles = [
  'silverwolf-tts',
  'dsh_im_return_file',
  'tool/call',
  'tool/result',
  '.wav',
  'artifact',
  'isError',
  'QQ voice',
  'artifact-provider',
];
console.log('\n--- 关键词计数 ---');
for (const n of needles) {
  let count = 0;
  let from = 0;
  for (;;) {
    const i = text.indexOf(n, from);
    if (i < 0) break;
    count += 1;
    from = i + n.length;
  }
  console.log(`  ${n}: ${count}`);
}

if (mode === 'grep') {
  // 每个关键词给一段上下文
  for (const n of needles) {
    const i = text.indexOf(n);
    if (i < 0) continue;
    console.log(`\n=== 「${n}」上下文 ===`);
    console.log(text.slice(Math.max(0, i - 500), i + 900));
  }
} else {
  console.log('\n--- 前 3000 字符 ---');
  console.log(text.slice(0, 3000));
  console.log('\n--- 后 3000 字符 ---');
  console.log(text.slice(-3000));
}
