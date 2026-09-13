/**
 * dsh-im 引用图片补丁 · 应用脚本
 * ---------------------------------------------------------------------------
 * 场景：手机 QQ 无法「一张图 + 一句话」同时发送，群友的做法是
 *   ① 先发一张图  ② 再发「@机器人 分析一下上面这张图」
 * 拆成两条消息后，第二条是独立的 @消息，机器人看不到图片。
 *
 * 现状（补丁前）：
 *   QQ 把被引用消息放在 msgElements[0].attachments，**含可下载 url**
 *   （已实测确认：content_type/filename/size/url/width/height）。
 *   但 dsh-im 的 qqReplyReference() 只提取 kind 与 name，
 *   把 url 丢掉了 → agent 只知道「引用里有一张图」，读不到内容。
 *
 * 本补丁（两处，都在 qq-bridge.mjs 的 QQ 入站路径）：
 *   1. qqReplyReference：映射里补上 url
 *   2. qqInboundMessage：把被引用消息里的图片，按当前消息图片的同等形态
 *      加进 images[]（复用 fetchImageBuffer + QQ_IMAGE_HOSTS 白名单）
 *
 * 注：实测 url 主机是 multimedia.nt.qq.com.cn，已被既有白名单
 *     `.qq.com.cn` 覆盖，因此【不需要】放宽 SSRF 防护。
 *
 * 前提：msgElements 只在 message_type=103（引用消息）时存在元素，
 *       所以补丁不会误伤普通消息。
 *
 * 用法：
 *   node apply-quoted-image-patch.mjs            # 预演
 *   node apply-quoted-image-patch.mjs --apply    # 应用
 *   node apply-quoted-image-patch.mjs --revert   # 回滚
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = '<<<DSH_HOME>>>/profiles/web/node_modules/@xmanrui/dsh-im/lib/index.js';
const BACKUP_DIR = join(HERE, 'backup');
const MARKER = 'quoted-image-patch';

const RULES = [
  {
    id: 'reply-ref-keep-url',
    why: 'qqReplyReference：附件映射里补上 url（原来只留 kind/name）',
    search: 'let s=ya(r?.filename);return{kind:F$(r),...s?{name:s}:{}}}',
    replace: 'let s=ya(r?.filename),su=ya(r?.url);'
      + '/* quoted-image-patch */'
      + 'return{kind:F$(r),...s?{name:s}:{},...su?{url:su}:{}}}',
  },
  {
    id: 'inbound-quoted-images',
    why: 'qqInboundMessage：把被引用消息里的图片并入 images[]，复用 dn() 下载器与 hKe 白名单',
    // ⚠ 锚点必须钉在 L$（qqInboundMessage）内部。
    //    上一版用 `Mr(I),y=null,m=i===null;` 是错的 —— 那个形态同样出现在
    //    qq-bridge 的 #G 方法里，结果插错函数、引用了不存在的变量。
    //    这里改用 L$ 自己的收尾序：文件 push 结束后紧跟 `let e=l2(n);return{...}`。
    search: 'let e=l2(n);return{content:uf(n),images:o,files:a,',
    replace:
      // ⚠ 变量映射（读自 function L$(n,{fetchImpl:A=fetch}={})）：
      //   n = 入站消息对象   A = fetchImpl   o = images 数组   a = files 数组
      // 插在返回前：把被引用消息的图片补进 images，下游（hasInboundImages /
      // 图片 prompt 注入）会自动识别，无需改 #G。
      '/* quoted-image-patch: quoted message images */'
      + '{let _qe=Array.isArray(n?.msgElements)?n.msgElements[0]:null;'
      + 'for(let _qa of Array.isArray(_qe?.attachments)?_qe.attachments:[]){'
      + 'if(!p2(_qa))continue;'
      + 'let _qu=ya(_qa?.url);if(!_qu)continue;'
      + 'let _qn=ya(_qa?.filename),_qm=d2(_qa),_qs=Number(_qa?.size);'
      + 'o.push({..._qn?{name:"[\\u5F15\\u7528\\u56FE\\u7247] "+_qn}:{},'
      + '..._qm?.startsWith("image/")?{mediaType:_qm}:{},'
      + '...Number.isFinite(_qs)&&_qs>=0?{size:_qs}:{},'
      + 'load:({signal:_qg,maxBytes:_qI})=>dn(_qu,{fetchImpl:A,signal:_qg,maxBytes:_qI,allowedHosts:hKe})});}}'
      + 'let e=l2(n);return{content:uf(n),images:o,files:a,',
  },
];

const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const countOf = (h, n) => h.split(n).length - 1;

function fail(m) { console.error(`\n❌ ${m}\n`); process.exit(1); }

function revert() {
  const backups = existsSync(BACKUP_DIR)
    ? readdirSync(BACKUP_DIR).filter((n) => n.startsWith('index.js.bak-')).sort()
    : [];
  if (!backups.length) fail('没有可用备份');
  const newest = backups[backups.length - 1];
  const bytes = readFileSync(join(BACKUP_DIR, newest));
  writeFileSync(TARGET, bytes);
  console.log(`✅ 已从 ${newest} 恢复（sha256 ${sha256(bytes)}）`);
  process.exit(0);
}

const args = process.argv.slice(2);
if (args.includes('--revert')) revert();
const apply = args.includes('--apply');

const original = readFileSync(TARGET, 'utf8');
const originalHash = sha256(original);

console.log('=== dsh-im 引用图片补丁（预演版，待校正）===\n');
console.log(`目标 : ${TARGET}`);
console.log(`哈希 : ${originalHash}\n`);

if (original.includes(MARKER)) {
  console.log('ℹ️  已应用过。如需重来先 --revert。');
  process.exit(0);
}

console.log('--- 锚点校验 ---');
let patched = original;
let allHit = true;
for (const rule of RULES) {
  const hits = countOf(patched, rule.search);
  console.log(`${hits === 1 ? '✅' : '❌'} ${rule.id.padEnd(24)} 命中=${hits}`);
  console.log(`     ${rule.why}`);
  if (hits !== 1) allHit = false;
  else patched = patched.replace(rule.search, rule.replace);
}

if (!allHit) {
  console.log('\n⚠️  有锚点未命中 —— 说明 bundle 里的实际写法与预期不符。');
  console.log('   需要先取回真实字节再校正，暂不写入。');
  process.exit(1);
}

const checks = [
  ['补丁标记存在', () => patched.includes(MARKER)],
  ['url 已保留（引用附件映射）', () => patched.includes('let s=ya(r?.filename),su=ya(r?.url)')],
  ['引用图片已并入 images', () => patched.includes('quoted message images')],
  ['白名单常量引用正确', () => patched.includes('allowedHosts:hKe')],
  ['语音补丁未受影响', () => patched.includes('__dshImSendQqVoice')],
  ['身份补丁未受影响', () => patched.includes('sender-identity-patch')],
];
console.log('\n--- 复检 ---');
let ok = true;
for (const [label, test] of checks) {
  const pass = test();
  if (!pass) ok = false;
  console.log(`${pass ? '✅' : '❌'} ${label}`);
}
if (!ok) fail('复检未通过');

console.log(`\n体积: ${original.length} → ${patched.length} (+${patched.length - original.length})`);

if (!apply) {
  writeFileSync(join(HERE, 'index.quoted-preview.js'), patched);
  console.log('\n🔍 预演完成（未改目标）。候选已写出，可 node --check 复核。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
writeFileSync(join(BACKUP_DIR, `index.js.bak-${stamp}`), original);
writeFileSync(TARGET, patched);
console.log(`\n✅ 已应用（备份 index.js.bak-${stamp}）`);
