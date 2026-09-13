/**
 * dsh-im 发送者身份补丁 · 应用脚本
 * ---------------------------------------------------------------------------
 * 目标：让 QQ 群聊里的 agent 知道「谁在说话」。
 *
 * 现状（补丁前）：
 *   QQ SDK 的 event-dispatcher.js 在 GROUP_AT_MESSAGE_CREATE 分支里提供了
 *     senderId:   ev.author.member_openid   （每个成员不同）
 *     senderName: ev.author.username        （昵称）
 *   但 dsh-im 的 QQ 通道没有实现 `contextSource`，所以这些字段在
 *   「消息对象 → context-enhancement」之间丢失了。agent 收到的只有正文。
 *
 *   对比：Discord / Telegram / Slack / WhatsApp / iMessage / 钉钉 都实现了
 *   `contextSource: () => ({ senderName: ... })`，唯独 QQ 缺失。
 *
 * 本补丁：给 QQ 的 accept() 补一个 contextSource 提取器。
 *   ⚠ 只负责「把身份送进上下文管道」。真正是否注入到 prompt，由
 *     context-enhancement 设置决定（默认关闭，需另开）——见配套脚本
 *     enable-user-identity.mjs。
 *
 * 用法：
 *   node apply-sender-identity-patch.mjs            # 预演
 *   node apply-sender-identity-patch.mjs --apply    # 应用
 *   node apply-sender-identity-patch.mjs --revert   # 回滚
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = '<<<DSH_HOME>>>/profiles/web/node_modules/@xmanrui/dsh-im/lib/index.js';
const BACKUP_DIR = join(HERE, 'backup');
const MARKER = 'sender-identity-patch';

// 锚点：QQ accept() 里消息对象的构造起点。
// 注意真实文本是 `,t={...A,...}` —— t 早在前一行 let 里声明过，此处没有 let 前缀。
// 该形态在 bundle 中唯一（其他渠道的 accept 不认识 rawEventType/groupOpenid）。
const SEARCH = '{...A,kind:i,conversationId:e},r=$a(t.messageId),s=$a(t.senderId);';

// 替换：不重新赋值 t，只在对象字面量里补一个 contextSource。
// 之所以不用 `t={...t,contextSource:...}`，是因为那会多一次无谓的展开，
// 而且依赖 `t` 在表达式内的临时绑定语义；直接加属性更短也更明确。
const REPLACE = [
  '{...A,kind:i,conversationId:e',
  // sender-identity-patch: expose the QQ sender to the context-enhancement pipeline.
  // The QQ SDK already carries senderName/senderId; dsh-im never extracted them,
  // which is exactly why group members were indistinguishable.
  // The marker string below is load-bearing: it makes this patch idempotent.
  '/* sender-identity-patch */',
  ',contextSource:()=>({',
  'conversationType:i==="group"?"group":"direct",',
  'senderName:$a(t.senderName),',
  'senderId:$a(t.senderId)',
  '})}',
  ',r=$a(t.messageId),s=$a(t.senderId);',
].join('');

const RULES = [
  {
    id: 'qq-context-source',
    why: 'QQ accept()：补 contextSource，把 senderName/senderId 送进增强管道',
    search: SEARCH,
    replace: REPLACE,
  },
];

const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const countOf = (h, n) => h.split(n).length - 1;

function fail(m) { console.error(`\n❌ ${m}\n`); process.exit(1); }

function revert() {
  if (!existsSync(BACKUP_DIR)) fail(`备份目录不存在：${BACKUP_DIR}`);
  const backups = readdirSync(BACKUP_DIR).filter((n) => n.startsWith('index.js.bak-')).sort();
  if (!backups.length) fail(`没有 index.js 备份`);
  const newest = backups[backups.length - 1];
  const bytes = readFileSync(join(BACKUP_DIR, newest));
  writeFileSync(TARGET, bytes);
  console.log(`✅ 已从 ${newest} 恢复`);
  console.log(`   sha256 = ${sha256(bytes)}`);
  process.exit(0);
}

const args = process.argv.slice(2);
if (args.includes('--revert')) revert();
const apply = args.includes('--apply');

if (!existsSync(TARGET)) fail(`目标不存在：${TARGET}`);
const original = readFileSync(TARGET, 'utf8');
const originalHash = sha256(original);

console.log('=== dsh-im 发送者身份补丁 ===\n');
console.log(`目标 : ${TARGET}`);
console.log(`体积 : ${(Buffer.byteLength(original) / 1024 / 1024).toFixed(2)} MB`);
console.log(`哈希 : ${originalHash}\n`);

if (original.includes(MARKER)) {
  console.log('ℹ️  检测到补丁标记，已经应用过了。');
  console.log('   如需重来：先 --revert。');
  process.exit(0);
}

// --- 前置检查：确认原有的 senderName 使用点仍在（说明上游字段名没变）
const sanity = [
  ['上游 senderName 引用存在', () => original.includes('senderName:A.kind==="group"?A.senderName:void 0')],
  ['语音补丁仍在（不冲突）', () => original.includes('__dshImSendQqVoice')],
];
console.log('--- 前置检查 ---');
let sane = true;
for (const [label, test] of sanity) {
  const ok = test();
  if (!ok) sane = false;
  console.log(`${ok ? '✅' : '⚠️ '} ${label}`);
}
if (!sane) console.log('   （继续，但请留意上述不符项）');

console.log('\n--- 锚点校验 ---');
let patched = original;
for (const rule of RULES) {
  const hits = countOf(patched, rule.search);
  console.log(`${hits === 1 ? '✅' : '❌'} ${rule.id.padEnd(20)} 命中=${hits}`);
  console.log(`     ${rule.why}`);
  if (hits !== 1) fail(`锚点 "${rule.id}" 命中 ${hits} 次（要求 1）。未写入。`);
  patched = patched.replace(rule.search, rule.replace);
}

console.log('\n--- 应用后复检 ---');
const checks = [
  ['补丁标记存在', () => patched.includes(MARKER)],
  ['contextSource 已注入', () => patched.includes('contextSource:()=>({conversationType:i==="group"?"group":"direct"')],
  ['senderName 已提取', () => patched.includes('senderName:$a(t.senderName)')],
  ['senderId 已提取', () => patched.includes('senderId:$a(t.senderId)})}')],
  ['原有 messageId 校验仍在', () => patched.includes(',r=$a(t.messageId),s=$a(t.senderId);')],
  ['语音补丁未受影响', () => patched.includes('__dshImSendQqVoice')],
  ['体积未缩水', () => patched.length >= original.length],
];
let ok = true;
for (const [label, test] of checks) {
  const pass = test();
  if (!pass) ok = false;
  console.log(`${pass ? '✅' : '❌'} ${label}`);
}
if (!ok) fail('复检未通过，未写入。');

console.log('\n--- 结果 ---');
console.log(`原体积 : ${original.length} 字符`);
console.log(`新体积 : ${patched.length} 字符 (+${patched.length - original.length})`);
console.log(`新哈希 : ${sha256(patched)}`);

if (!apply) {
  const preview = join(HERE, 'index.sender-preview.js');
  writeFileSync(preview, patched);
  console.log(`\n🔍 预演模式（未改动目标）`);
  console.log(`   候选已写出：${preview}`);
  console.log(`   语法复核：node --check "${preview}"`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupPath = join(BACKUP_DIR, `index.js.bak-${stamp}`);
writeFileSync(backupPath, original);
console.log(`\n已备份 -> ${backupPath}`);
writeFileSync(TARGET, patched);
console.log(`✅ 已应用 -> ${TARGET}`);
console.log('\n下一步：启用 context-enhancement，然后重启 dsh web。');
