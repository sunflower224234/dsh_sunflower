/**
 * dsh-im 语音投递补丁 · 应用脚本
 * ---------------------------------------------------------------------------
 * 给 @xmanrui/dsh-im 打上「按需发 QQ 语音条」能力。
 *
 * 背景：dsh-im 的 lib/index.js 是 esbuild 压成单文件的 bundle（约 8.3MB），
 * 本机没有 esbuild 无法重新构建，所以只能对 bundle 做精确字符串替换。
 * 所有替换都要求锚点【恰好出现一次】，任一命中数不为 1 就整体中止、不写文件。
 *
 * 设计：不动共享投递层（artifact-delivery），只在 QQ 桥接的 sendFile 闭包
 * 按 mediaType 分流 —— audio/* 走新增的 sendVoice，其余照旧走文件。
 *
 * 用法：
 *   node apply-voice-patch.mjs            # 预演（dry-run，不写文件）
 *   node apply-voice-patch.mjs --apply    # 实际应用
 *   node apply-voice-patch.mjs --revert   # 从 backup/ 恢复
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = '<<<DSH_HOME>>>/profiles/web/node_modules/@xmanrui/dsh-im/lib/index.js';
const BACKUP_DIR = join(HERE, 'backup');
const MARKER = 'Audio artifact through QQ native voice message';

/**
 * 新增函数的标识符。
 *
 * ⚠ 必须选压缩器不会生成的形状（带下划线前缀），并且在应用前实测该名字
 * 在 bundle 里零占用。踩过的坑：最初用 `pV`，它在顶层已被
 * `var pV=te(...)`（esbuild 的 CommonJS 模块包装）占用 —— 同作用域下
 * `var` 赋值会覆盖函数声明，运行时调用直接抛 TypeError。
 */
const VOICE_FN = '__dshImSendQqVoice';

// ------------------------------------------------------------------ 替换规则

const RULES = [
  {
    id: 'qq-sendFile-audio-branch',
    why: 'QQ 桥接：sendFile 闭包遇到 audio/* 改走新增的音频发送函数',
    search: 'sendFile:t=>SKe(this.#t,A,t,{signal:this.#o,timeoutMs:this.#d})',
    replace: `sendFile:t=>t?.mediaType?.startsWith("audio/")?${VOICE_FN}(this.#t,A,t,{signal:this.#o,timeoutMs:this.#d}):SKe(this.#t,A,t,{signal:this.#o,timeoutMs:this.#d})`,
  },
  {
    id: 'qq-add-sendVoice-fn',
    why: '新增 sendVoice 实现，与 SKe(sendFile) 同构',
    search: 'async function SKe(n,A,o,{signal:a,timeoutMs:e=qD}={})',
    replace:
      `async function ${VOICE_FN}(n,A,o,{signal:a,timeoutMs:e=qD}={}){`
      + 'if(a?.throwIfAborted(),typeof n?.sendVoice!="function"){'
      + 'let i=new Error("QQ voice delivery is unavailable");'
      + 'throw i.code="artifact-provider-unavailable",i}'
      + 'try{'
      + 'let i=AbortSignal.timeout(e),t=a?AbortSignal.any([a,i]):i,'
      + 'r=n.sendVoice(A,{buffer:o.bytes},{onProgress:()=>a?.throwIfAborted()});'
      + 'return As(o,r),await H$(r,t)'
      + '}catch(i){throw a?.aborted?h2(a):U$(i,{dispatched:!0})}}'
      + '/* Audio artifact through QQ native voice message */'
      + `async function SKe(n,A,o,{signal:a,timeoutMs:e=qD}={})`,
  },
  {
    id: 'mime-audio-extensions',
    why: 'MIME 表补音频扩展名 —— 否则 .wav 被识别成 application/octet-stream，audio/* 判断永不成立',
    search: '[".html","text/html"],[".jpeg","image/jpeg"]',
    replace:
      '[".html","text/html"],'
      + '[".aac","audio/aac"],[".amr","audio/amr"],'
      + '[".flac","audio/flac"],[".m4a","audio/mp4"],'
      + '[".mp3","audio/mpeg"],[".ogg","audio/ogg"],'
      + '[".opus","audio/opus"],[".silk","audio/silk"],'
      + '[".wav","audio/wav"],[".weba","audio/webm"],'
      + '[".jpeg","image/jpeg"]',
  },
];

// ------------------------------------------------------------------ 工具

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function revert() {
  if (!existsSync(BACKUP_DIR)) fail(`备份目录不存在：${BACKUP_DIR}`);
  const backups = readdirSync(BACKUP_DIR).filter((n) => n.startsWith('index.js.bak-'));
  if (backups.length === 0) fail(`备份目录里没有 index.js 备份：${BACKUP_DIR}`);
  backups.sort();
  const newest = backups[backups.length - 1];
  const source = join(BACKUP_DIR, newest);
  const bytes = readFileSync(source);
  writeFileSync(TARGET, bytes);
  console.log(`✅ 已从 ${newest} 恢复`);
  console.log(`   sha256 = ${sha256(bytes)}`);
  console.log('   重启 dsh web 后生效。');
  process.exit(0);
}

// ------------------------------------------------------------------ 主流程

const args = process.argv.slice(2);
if (args.includes('--revert')) revert();
const apply = args.includes('--apply');

if (!existsSync(TARGET)) fail(`目标文件不存在：${TARGET}`);

const original = readFileSync(TARGET, 'utf8');
const originalHash = sha256(original);

console.log('=== dsh-im 语音投递补丁 ===\n');
console.log(`目标 : ${TARGET}`);
console.log(`体积 : ${(Buffer.byteLength(original) / 1024 / 1024).toFixed(2)} MB`);
console.log(`哈希 : ${originalHash}\n`);

// --- 幂等检查：已经打过就直接退出
if (original.includes(MARKER)) {
  console.log('ℹ️  检测到补丁标记，似乎已经应用过了。');
  console.log('   如需重新应用，请先 --revert 恢复备份。');
  process.exit(0);
}

// --- 防撞名：新增函数名必须在 bundle 里零占用
console.log('--- 新增标识符占用检查 ---');
{
  const occupied = countOf(original, VOICE_FN);
  console.log(`${occupied === 0 ? '✅' : '❌'} ${VOICE_FN} 占用=${occupied}（要求 0）`);
  if (occupied !== 0) {
    fail(
      `新增函数名 "${VOICE_FN}" 在 bundle 里已出现 ${occupied} 次。`
      + '\n   同作用域重名会被 var 赋值覆盖，运行时必然报错。请换一个名字。',
    );
  }
}

// --- 逐条校验锚点唯一性
console.log('\n--- 锚点校验 ---');
let patched = original;
for (const rule of RULES) {
  const hits = countOf(patched, rule.search);
  const status = hits === 1 ? '✅' : '❌';
  console.log(`${status} ${rule.id.padEnd(28)} 命中=${hits}`);
  console.log(`     ${rule.why}`);
  if (hits !== 1) {
    fail(
      `锚点 "${rule.id}" 命中 ${hits} 次（要求恰好 1 次）。\n`
      + '   可能插件版本已变，或补丁已被打过一部分。未写入任何内容。',
    );
  }
  patched = patched.replace(rule.search, rule.replace);
}

// --- 应用后复检
console.log('\n--- 应用后复检 ---');
const checks = [
  ['新增音频发送函数', () => patched.includes(`async function ${VOICE_FN}(`)],
  ['sendFile 分流已生效', () => patched.includes(`startsWith("audio/")?${VOICE_FN}(`)],
  ['新函数名仍唯一', () => countOf(patched, VOICE_FN) === 2],
  ['MIME 含 .wav', () => patched.includes('[".wav","audio/wav"]')],
  ['MIME 含 .silk', () => patched.includes('[".silk","audio/silk"]')],
  ['补丁标记存在', () => patched.includes(MARKER)],
  ['原有 sendFile 实现仍在', () => patched.includes('async function SKe(')],
  ['原有 sendImage 实现仍在', () => patched.includes('async function mKe(')],
  ['文件体积未明显缩水', () => patched.length >= original.length],
];
let allOk = true;
for (const [label, test] of checks) {
  const ok = test();
  if (!ok) allOk = false;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
}
if (!allOk) fail('复检未通过，未写入任何内容。');

// --- 语法校验（写完临时文件后由外部 node --check 复核）
console.log('\n--- 结果 ---');
console.log(`原体积 : ${original.length} 字符`);
console.log(`新体积 : ${patched.length} 字符 (+${patched.length - original.length})`);
console.log(`新哈希 : ${sha256(patched)}`);

if (!apply) {
  const preview = join(HERE, 'index.patched.preview.js');
  writeFileSync(preview, patched);
  console.log(`\n🔍 预演模式（未改动目标文件）`);
  console.log(`   候选结果已写到：${preview}`);
  console.log('   复核语法：node --check "' + preview + '"');
  console.log('   确认无误后加 --apply 实际应用。');
  process.exit(0);
}

// --- 备份 + 落盘
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupPath = join(BACKUP_DIR, `index.js.bak-${stamp}`);
writeFileSync(backupPath, original);
console.log(`\n已备份原文件 -> ${backupPath}`);

writeFileSync(TARGET, patched);
console.log(`✅ 补丁已应用 -> ${TARGET}`);
console.log('\n下一步：重启 dsh web 让改动生效。');
