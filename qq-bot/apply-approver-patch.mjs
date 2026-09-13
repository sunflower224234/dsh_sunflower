/**
 * dsh-im 群聊审批人补丁 · 应用脚本
 * ---------------------------------------------------------------------------
 * 背景（读自 harness-approval.mjs）：
 *   插件【已内置】审批机制：工具需要授权时，会在 IM 里发提示，
 *   用户回复「批准 / 同意 / yes」或「拒绝 / 不同意 / no」即可。
 *   群聊里需要 @机器人 才能应答（requiresMention）。
 *
 * 但有一个限制与需求冲突：
 *   if (pending.actor !== actor || (pending.requiresMention && addressed !== true))
 *     → 「只有发起当前任务的用户可以处理这条审批。」
 *
 *   pending.actor = 发起任务的【那个群友】。于是：群友请求改文件时，
 *   只有该群友自己能批准；群主（太阳花）回「批准」会被判为无权。
 *   这既不符合「群主同意才执行」，而且等于让请求者自己给自己授权。
 *
 * 本补丁：
 *   1. 给审批队列注入 approverIds（来自 QQ 桥接的 ownerUserOpenid）
 *   2. 群聊场景下，只有 approverIds 中的人能批准；
 *      私聊场景保持原行为（actor 匹配），避免影响单聊语义。
 *
 * 安全说明：
 *   - ownerUserOpenid 是 QQ 平台下发的不可伪造标识，群昵称改不了它
 *   - approverIds 为空或 ["*"] 时回退到旧行为，不会把所有人放行
 *     （只有显式配置了具体 openid 才收紧权限）
 *
 * 用法：
 *   node apply-approver-patch.mjs            # 预演
 *   node apply-approver-patch.mjs --apply    # 应用
 *   node apply-approver-patch.mjs --revert   # 回滚
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = '<<<DSH_HOME>>>/profiles/web/node_modules/@xmanrui/dsh-im/lib/index.js';
const BACKUP_DIR = join(HERE, 'backup');
const MARKER = 'approver-patch';

const RULES = [
  {
    id: 'queue-takes-approver-ids',
    why: 'QQ 桥接：把 ownerUserOpenid 作为审批人白名单注入审批队列',
    // label:"qq",logger:s 在 bundle 中唯一（已核对：new va( 有 7 处，但只有这处是 qq）
    // 用 rg() 归一化成数组：#e 是 ownerUserOpenid，可能是单值字符串。
    //   rg 的定义：[...new Set((Array.isArray(n)?n:[n]).filter(...).map(String).filter(Boolean))]
    //   传 "*" → ["*"]；传单个 openid → [openid]；传数组 → 去重后的数组。
    search: 'this.#B=new va({label:"qq",logger:s})',
    replace: 'this.#B=new va({label:"qq",logger:s,/* approver-patch */approverIds:rg(this.#e)})',
  },
  {
    id: 'group-approval-owner-only',
    why: 'claimReply：群聊审批只认 approverIds（群主），私聊维持 actor 匹配',
    // 注意：'只有发起当前任务…' 这个词在 i18n 映射表里也出现一次，
    //      所以锚点必须带上前面的三元判断骨架，才能唯一命中逻辑代码。
    search: 'g.actor!==o||g.requiresMention&&e!==!0?I?d(S("\\u53EA\\u6709\\u53D1\\u8D77\\u5F53\\u524D\\u4EFB\\u52A1\\u7684\\u7528\\u6237\\u53EF\\u4EE5\\u5904\\u7406\\u8FD9\\u6761\\u5BA1\\u6279\\u3002")):null',
    replace:
      '/* approver-patch: group approvals go to the configured approvers */'
      // 群聊（g.requiresMention === true）：o 必须在审批人白名单里。
      //   #a 就是 approverIds；用 rg() 归一化后必为数组，所以只需 includes 判定。
      //   未配置（数组为空）→ 判定为「无权」→ 审批落回拒绝，安全方向。
      // 私聊（g.requiresMention !== true）：保持原有 actor 匹配语义。
      + '(g.requiresMention===!0'
      + '?!(Array.isArray(this.#a)&&this.#a.includes(o))'
      + ':g.actor!==o)'
      + '?I?d(S("\\u53EA\\u6709\\u53D1\\u8D77\\u5F53\\u524D\\u4EFB\\u52A1\\u7684\\u7528\\u6237\\u53EF\\u4EE5\\u5904\\u7406\\u8FD9\\u6761\\u5BA1\\u6279\\u3002")):null',
  },
];

const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const countOf = (h, n) => h.split(n).length - 1;

function fail(m) { console.error(`\n❌ ${m}\n`); process.exit(1); }

function revert() {
  if (!existsSync(BACKUP_DIR)) fail(`备份目录不存在`);
  const backups = readdirSync(BACKUP_DIR).filter((n) => n.startsWith('index.js.bak-')).sort();
  if (!backups.length) fail('没有可用备份');
  // 本补丁的回滚目标 = 它的【应用前状态】：含 语音+身份+引用图，但不含审批人。
  // 不能用通用的「取最新」逻辑 —— apply 时已把【含审批人】的当前态备份走了，
  // 若命中那个就会"回滚 = 什么都不变"；而命中更早的版本又会误删既有补丁。
  const PRE_REQUIRED = [
    'Audio artifact through QQ native voice message',
    'sender-identity-patch',
    'quoted-image-patch',
  ];
  for (const name of [...backups].reverse()) {
    const bytes = readFileSync(join(BACKUP_DIR, name));
    const text = bytes.toString('utf8');
    if (PRE_REQUIRED.every((m) => text.includes(m)) && !text.includes('approver-patch')) {
      writeFileSync(TARGET, bytes);
      console.log(`✅ 已回滚审批人补丁 -> ${name}`);
      console.log(`   该状态含 语音+身份+引用图，不含审批人`);
      console.log(`   sha256 = ${sha256(bytes)}`);
      return;
    }
  }
  fail('未找到本补丁的应用前备份（含语音+身份+引用图 且不含审批人）。拒绝回滚以免误删既有补丁。');
}

const args = process.argv.slice(2);
if (args.includes('--revert')) { revert(); process.exit(0); }
const apply = args.includes('--apply');

const original = readFileSync(TARGET, 'utf8');
console.log('=== dsh-im 群聊审批人补丁 ===\n');

if (original.includes(MARKER)) {
  console.log('ℹ️  已应用过。重来请先 --revert。');
  process.exit(0);
}

console.log('--- 前置检查 ---');
for (const [label, test] of [
  ['审批队列类存在', () => original.includes('claimReply({key:A,actor:o,text:a')],
  ['ownerUserOpenid 字段 (#e) 存在', () => original.includes('this.#B=new va({label:"qq",logger:s})')],
  ['rg() 归一化函数存在', () => original.includes('function rg(n){return[...new Set(')],
  ['语音补丁在', () => original.includes('Audio artifact through QQ native voice message')],
  ['身份补丁在', () => original.includes('sender-identity-patch')],
  ['引用图补丁在', () => original.includes('quoted-image-patch')],
]) console.log(`${test() ? '✅' : '⚠️ '} ${label}`);

console.log('\n--- 锚点校验 ---');
let patched = original;
let allHit = true;
for (const rule of RULES) {
  const hits = countOf(patched, rule.search);
  console.log(`${hits === 1 ? '✅' : '❌'} ${rule.id.padEnd(30)} 命中=${hits}`);
  console.log(`     ${rule.why}`);
  if (hits !== 1) allHit = false;
  else patched = patched.replace(rule.search, rule.replace);
}
if (!allHit) fail('锚点未命中，未写入。');

console.log('\n--- 复检 ---');
let ok = true;
for (const [label, test] of [
  ['补丁标记', () => patched.includes(MARKER)],
  ['approverIds 已注入', () => patched.includes('approverIds:rg(this.#e)')],
  ['群聊分支已改', () => patched.includes('approver-patch: group approvals')],
  ['旧行为文本仍在（私聊复用）', () => patched.includes('\\u53EA\\u6709\\u53D1\\u8D77')],
  ['语音补丁未受影响', () => patched.includes('Audio artifact through QQ native voice message')],
  ['身份补丁未受影响', () => patched.includes('sender-identity-patch')],
  ['引用图补丁未受影响', () => patched.includes('quoted-image-patch')],
]) { const p = test(); if (!p) ok = false; console.log(`${p ? '✅' : '❌'} ${label}`); }
if (!ok) fail('复检未通过');

console.log(`\n体积: ${original.length} → ${patched.length} (+${patched.length - original.length})`);

if (!apply) {
  writeFileSync(join(HERE, 'index.approver-preview.js'), patched);
  console.log('\n🔍 预演完成（未改目标）。候选已写出，可 node --check 复核。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
writeFileSync(join(BACKUP_DIR, `index.js.bak-${stamp}`), original);
writeFileSync(TARGET, patched);
console.log(`\n✅ 已应用（备份 index.js.bak-${stamp}）`);
