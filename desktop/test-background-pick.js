'use strict';
// 背景图选择策略测试（真实 Electron 环境跑，因为要复刻 main.js 的 fs/path 用法）
//
// 用一个只有测试图的小目录 + 独立 userData，直接复刻 main.js 里
// pickBackground(exclude) 与 loadLastBackground()/writeStateFile() 的行为：
//   1) 连续 300 次「启动」绝不出现连着两次同一张
//   2) 5 张图的出现频率仍然大致均匀（避开上一张后应接近 1/4，而不是某张独大）
//   3) 只有一张图时不会死循环/返回 null
//   4) 记忆文件损坏 / 无记忆时不崩
//   5) lastBackground 会随每次选择更新，且不影响窗口状态字段
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const DIR = path.join(os.tmpdir(), 'dsh-bgtest-' + process.pid);
const STATE = path.join(app.getPath('userData'), 'window-state.json');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

// ---- 复刻 main.js 的三个函数 ----
function readStateFile() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}
function writeStateFile(patch) {
  const current = readStateFile() || {};
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, STATE);
  return next;
}
function loadLastBackground() {
  const raw = readStateFile();
  return raw && typeof raw.lastBackground === 'string' && raw.lastBackground ? raw.lastBackground : null;
}
function pickBackground(exclude) {
  const files = fs.readdirSync(DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  if (!files.length) return null;
  const pool = files.length > 1 && exclude ? files.filter((f) => f !== exclude) : files;
  const candidates = pool.length ? pool : files;
  const file = candidates[Math.floor(Math.random() * candidates.length)];
  return { file, url: pathToFileURL(path.join(DIR, file)).toString() };
}

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
};

const NAMES = ['bg-a.png', 'bg-b.png', 'bg-c.png', 'bg-d.png', 'bg-e.png'];
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

function resetDir(names) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(DIR, n), PNG);
}
function resetState() {
  fs.rmSync(STATE, { force: true });
}

console.log('背景图选择策略测试（避开上一张）\n');

// ---- 1) 连续启动 300 次：不重复 + 频率 ----
resetDir(NAMES);
resetState();
const seq = [];
for (let i = 0; i < 300; i++) {
  const bg = pickBackground(loadLastBackground());
  writeStateFile({ lastBackground: bg.file });
  seq.push(bg.file);
}
let repeats = 0;
for (let i = 1; i < seq.length; i++) if (seq[i] === seq[i - 1]) repeats++;
check('300 次启动没有连着两次同一张', repeats === 0, '连着重复 ' + repeats + ' 次');
const freq = {};
for (const f of seq) freq[f] = (freq[f] || 0) + 1;
const values = Object.values(freq);
check('5 张图都出现过', Object.keys(freq).length === 5, JSON.stringify(freq));
const min = Math.min(...values), max = Math.max(...values);
check('分布仍然均匀（极差 < 12%）', (max - min) / 300 < 0.12, 'min=' + min + ' max=' + max + ' -> ' + JSON.stringify(freq));
console.log('        频率: ' + Object.entries(freq).map(([k, v]) => k + '=' + v).join('  '));

// ---- 2) 对照：不做排除时会连着重复（说明测试本身有区分力） ----
resetDir(NAMES);
resetState();
let repeatsPlain = 0;
let prev = null;
for (let i = 0; i < 300; i++) {
  const bg = pickBackground(null);
  if (prev && bg.file === prev) repeatsPlain++;
  prev = bg.file;
}
check('对照组（不排除）确实会连着重复 —— 证明本测试有区分力', repeatsPlain > 0, '连着重复 ' + repeatsPlain + ' 次');

// ---- 3) 只有一张图时不崩、仍返回它 ----
resetDir(['only.png']);
resetState();
const one1 = pickBackground(loadLastBackground());
writeStateFile({ lastBackground: one1.file });
const one2 = pickBackground(loadLastBackground());
check('只有一张图时返回该图（不返回 null）', one1 && one2 && one1.file === 'only.png' && one2.file === 'only.png', JSON.stringify([one1 && one1.file, one2 && one2.file]));

// ---- 4) 记忆里记的图已被删除时不崩（过滤后候选为空则退回全部） ----
resetDir(NAMES);
resetState();
writeStateFile({ lastBackground: 'bg-deleted.png' });
const afterDeleted = pickBackground(loadLastBackground());
check('记忆指向已删除的图时仍能正常选图', !!afterDeleted && NAMES.includes(afterDeleted.file), afterDeleted && afterDeleted.file);

// ---- 5) 记忆文件损坏时不崩 ----
fs.writeFileSync(STATE, '{ 这不是 json', 'utf8');
let threw = null, bg5 = null;
try { bg5 = pickBackground(loadLastBackground()); } catch (e) { threw = e.message }
check('记忆文件损坏时不抛错且能选图', threw === null && !!bg5, String(threw));

// ---- 6) 不影响窗口状态字段（合并写，不覆盖 bounds/maximized） ----
resetState();
writeStateFile({ bounds: { x: 1, y: 2, width: 1100, height: 700 }, maximized: true });
writeStateFile({ lastBackground: 'bg-a.png' });
const merged = JSON.parse(fs.readFileSync(STATE, 'utf8'));
check('写 lastBackground 不会丢掉 bounds', merged.bounds && merged.bounds.width === 1100, JSON.stringify(merged));
check('写 lastBackground 不会丢掉 maximized', merged.maximized === true, JSON.stringify(merged));
check('两个字段能共存', merged.lastBackground === 'bg-a.png' && merged.bounds && merged.maximized === true);

// ---- 7) 每次都写回 lastBackground（下次启动才知道该避开谁） ----
resetState();
const r1 = pickBackground(loadLastBackground());
writeStateFile({ lastBackground: r1.file });
check('第一次选择后 lastBackground 已落盘', loadLastBackground() === r1.file, String(loadLastBackground()));
const r2 = pickBackground(loadLastBackground());
check('第二次选择不等于上一次', r2.file !== r1.file, r1.file + ' -> ' + r2.file);

fs.rmSync(DIR, { recursive: true, force: true });
fs.rmSync(STATE, { force: true });
console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
app.exit(failed ? 1 : 0);
