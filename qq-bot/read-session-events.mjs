/**
 * 读取 DSH 会话事件日志（zstd 压缩的 jsonl）
 * 用途：查清 QQ 群会话里 agent 到底执行了哪些工具调用、结果如何。
 *
 * 用法：
 *   node read-session-events.mjs <session.v3.jsonl.zstd> [--tools] [--tail N]
 */

import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const toolsOnly = args.includes('--tools');
const tailIdx = args.indexOf('--tail');
const tail = tailIdx >= 0 ? Number(args[tailIdx + 1]) : 60;

if (!file) {
  console.error('用法: node read-session-events.mjs <session.v3.jsonl.zstd> [--tools] [--tail N]');
  process.exit(2);
}

let text;
try {
  const compressed = readFileSync(file);
  text = zstdDecompressSync(compressed).toString('utf8');
} catch (error) {
  console.error(`解压失败: ${error.message}`);
  console.error(`（Node ${process.version}，zstd 支持需 Node 22.15+ / 23.8+）`);
  process.exit(1);
}

const lines = text.split(/\r?\n/).filter((l) => l.trim());
console.log(`总事件数: ${lines.length}\n`);

const parsed = [];
for (const line of lines) {
  try { parsed.push(JSON.parse(line)); } catch {}
}

/** 汇总工具调用 */
const toolCalls = [];
const toolResults = [];
for (const ev of parsed) {
  const t = ev?.type ?? ev?.event?.type;
  const d = ev?.data ?? ev?.event?.data ?? ev;
  if (t === 'tool/call') toolCalls.push({ ev, d });
  if (t === 'tool/result') toolResults.push({ ev, d });
}

if (toolsOnly) {
  console.log(`=== 工具调用（${toolCalls.length} 次）===`);
  for (const { d } of toolCalls) {
    const name = d?.name ?? '(unknown)';
    let argStr = typeof d?.arguments === 'string' ? d.arguments : JSON.stringify(d?.arguments ?? {});
    if (argStr.length > 300) argStr = argStr.slice(0, 300) + '…';
    console.log(`\n→ ${name}`);
    console.log(`  参数: ${argStr}`);
  }
  console.log(`\n=== 工具结果（${toolResults.length} 次）===`);
  for (const { d } of toolResults) {
    let out = typeof d?.result === 'string' ? d.result : JSON.stringify(d?.result ?? d ?? {});
    if (typeof out !== 'string') out = JSON.stringify(out);
    if (out.length > 600) out = out.slice(0, 600) + '…';
    console.log(`\n← isError=${d?.isError ?? '?'}`);
    console.log(`  ${out}`);
  }
  process.exit(0);
}

console.log(`=== 事件类型分布 ===`);
const counts = new Map();
for (const ev of parsed) {
  const t = ev?.type ?? ev?.event?.type ?? '(none)';
  counts.set(t, (counts.get(t) ?? 0) + 1);
}
[...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, c]) => console.log(`  ${String(c).padStart(5)}  ${t}`));

console.log(`\n=== 最后 ${tail} 条事件 ===`);
for (const ev of parsed.slice(-tail)) {
  const t = ev?.type ?? ev?.event?.type ?? '(none)';
  let body = JSON.stringify(ev?.data ?? ev?.event?.data ?? ev);
  if (body.length > 400) body = body.slice(0, 400) + '…';
  console.log(`\n[${t}]`);
  console.log(`  ${body}`);
}
