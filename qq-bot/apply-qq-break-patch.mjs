/**
 * dsh-im [break] 分气泡补丁 · 应用脚本
 * ---------------------------------------------------------------------------
 * 背景：人设要求银狼用 `[break]` 把回复拆成 2~3 个气泡，但 **dsh-im 任何版本都
 * 不解析这个标记**（4.19.2 与 4.28.1 的 lib/index.js 里都没有），README 也写明
 * QQ 是「以单条 Markdown 回复」。于是 [break] 一直原样发给用户。
 *
 * 好消息：多气泡的**发送**机制本来就有 —— `sendMarkdownReply()` 会把回复
 * `chunkMarkdownParts()` 成多个 chunk 并逐条发送（含 msg_seq 递增、markdown
 * 被拒回退纯文本、超长溢出提示）。缺的只是「让 chunker 在 [break] 处强制断开」。
 *
 * 所以本补丁只改一处：在 `oKe`（= chunkMarkdownParts）函数体开头插入一个
 * 分片守卫，遇到 [break] 就递归切分后返回。其余发送逻辑一行不动。
 *
 * 压缩名对照（esbuild 产物）：
 *   DEFAULT_CHUNK_LIMIT(4500) -> O$
 *   chunkMarkdownParts        -> oKe
 *
 * 用法：
 *   node apply-qq-break-patch.mjs            # 预演（dry-run，不写文件）
 *   node apply-qq-break-patch.mjs --apply    # 实际应用
 *   node apply-qq-break-patch.mjs --revert   # 从 backup/ 恢复
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 解析 DSH_HOME，使同一脚本在 PC（Windows）与服务器（Linux）都能用。
const DSH_HOME = process.env.DSH_HOME
  || (process.platform === 'win32'
    ? join(process.env.USERPROFILE ?? '', '.dsh')
    : join(process.env.HOME ?? '', '.dsh'));
const TARGET = join(DSH_HOME, 'profiles', 'web', 'node_modules', '@xmanrui', 'dsh-im', 'lib', 'index.js');
const BACKUP_DIR = join(HERE, 'backup');
const MARKER = 'qq-break-split-patch';

/** 锚点：oKe 的函数签名。必须恰好出现一次。 */
const ANCHOR = 'function oKe(n,A=O$){';

/**
 * 插入的分片守卫。
 *
 * 1. `String(n??"")` —— n 就是 chunkMarkdownParts 的 text 参数。
 * 2. 只按字面量 [break] 切（大小写不敏感）；前后紧贴反引号的 `[break]` 不切，
 *    因为那通常是在描述这个标记本身，切了会把行内代码劈成两半。
 *    （已知局限：反引号内嵌的 a[break]b 这种仍会切，属罕见情况。）
 * 3. 每段 trim 后丢弃空段，避免 [break] 前后换行产生空气泡。
 * 4. 上限 4 段：QQ 被动回复有 PASSIVE_REPLY_LIMIT（单聊 4 / 群聊 5），超过会走
 *    「回答较长，后续内容未能完整发送」的溢出分支。人设本来也只要求 2~3 个气泡，
 *    所以把多余段并进最后一段，既守规矩又不触发溢出提示。
 * 5. 递归调用自身：切出来的段里已不含 [break]，不会无限递归。
 */
const GUARD = 'const __dshImBreak=String(n??"").split(/(?<!`)\\[break\\](?!`)/iu);'
  + 'if(__dshImBreak.length>1){'
  + 'const __dshImSegs=[];'
  + 'for(const __s of __dshImBreak){const __t=__s.replace(/^\\s+|\\s+$/gu,"");if(__t)__dshImSegs.push(__t);}'
  + 'if(__dshImSegs.length>1){'
  + 'const __dshImCap=4;'
  + 'const __dshImParts=__dshImSegs.length>__dshImCap'
  + '?[...__dshImSegs.slice(0,__dshImCap-1),__dshImSegs.slice(__dshImCap-1).join("\\n")]'
  + ':__dshImSegs;'
  + 'const __dshImOut=[];'
  + 'for(const __t of __dshImParts)__dshImOut.push(...oKe(__t,A));'
  + 'return __dshImOut;'
  + '}}';

const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');

if (!existsSync(TARGET)) {
  console.error(`找不到目标文件：${TARGET}`);
  process.exit(1);
}

if (REVERT) {
  if (!existsSync(BACKUP_DIR)) {
    console.error('没有 backup 目录，无法回退。');
    process.exit(1);
  }
  const backups = readdirSync(BACKUP_DIR).filter((n) => n.startsWith('index.js.bak-')).sort();
  if (backups.length === 0) {
    console.error('backup 目录里没有可用的备份。');
    process.exit(1);
  }
  const latest = join(BACKUP_DIR, backups[backups.length - 1]);
  copyFileSync(latest, TARGET);
  console.log(`✅ 已从 ${latest} 恢复`);
  process.exit(0);
}

const original = readFileSync(TARGET, 'utf8');

if (original.includes(MARKER)) {
  console.log('✅ 补丁已应用过（检测到标记），跳过。');
  process.exit(0);
}

// ---------------------------------------------------------------- 锚点校验
const hits = original.split(ANCHOR).length - 1;
console.log(`锚点命中数：${hits}（应为 1）`);
if (hits !== 1) {
  console.error('❌ 锚点命中数不为 1，中止不写文件。bundle 可能已升级或已被别的补丁改动。');
  process.exit(1);
}

// ---------------------------------------------------------------- 生成结果
const injected = `/*${MARKER}*/${GUARD}`;
const patched = original.replace(ANCHOR, ANCHOR + injected);

// ---------------------------------------------------------------- 复检
const checks = [
  ['补丁标记存在', () => patched.includes(MARKER)],
  ['守卫已插入函数体', () => patched.includes(`{/*${MARKER}*/const __dshImBreak=`)]
    ,
  ['仍在 oKe 函数内', () => patched.includes(ANCHOR + injected)],
  ['分片正则存在', () => patched.includes('split(/(?<!`)\\[break\\](?!`)/iu)')],
  ['递归调用自身', () => patched.includes('...oKe(__t,A)')],
  ['原有函数体未被截断', () => patched.includes('if(o.length<=a)return o?[{markdown:o,plain:o}]:[]')],
  ['体积未缩水', () => patched.length > original.length],
];

console.log('\n--- 复检 ---');
let ok = true;
for (const [label, fn] of checks) {
  let pass = false;
  try { pass = fn(); } catch { pass = false; }
  if (!pass) ok = false;
  console.log(`${pass ? '✅' : '❌'} ${label}`);
}

console.log(`\n体积: ${original.length} → ${patched.length} (+${patched.length - original.length})`);

if (!ok) {
  console.error('\n❌ 复检未通过，未写入。');
  process.exit(1);
}

if (!APPLY) {
  const preview = join(HERE, 'index.break.preview.js');
  writeFileSync(preview, patched);
  console.log(`\n🔍 预演模式（未改动目标文件）`);
  console.log(`   候选结果已写到：${preview}`);
  console.log(`   复核语法：node --check "${preview}"`);
  console.log('   确认无误后加 --apply 实际应用。');
  process.exit(0);
}

// ---------------------------------------------------------------- 写入
mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = join(BACKUP_DIR, `index.js.bak-${stamp}`);
copyFileSync(TARGET, backup);
writeFileSync(TARGET, patched);
console.log(`\n已备份 -> ${backup}`);
console.log(`✅ 补丁已应用 -> ${TARGET}`);
console.log('下一步：重启 dsh-qq 让改动生效。');
