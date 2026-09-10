'use strict';
// 窗口状态记忆的端到端验证（真实 Electron 窗口，独立 userData 目录）
//
// 验证：改尺寸/位置 → 关闭后记忆写入；再开 → 用记忆的尺寸/位置；最大化状态也被记住；
//       记忆的位置已不在任何显示器上时会丢弃位置（不会把窗口丢到看不见的地方）。
const { app, BrowserWindow, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const results = [];
const checks = [];

// 容错日志：这个测试常被父进程用管道接走输出；若父进程提前退出，管道会断（EPIPE），
// 而 Electron 会把未捕获异常弹成「A JavaScript error occurred in the main process」对话框。
// 这里把写日志与 console.log 都兜住，断管后只在内存里累积，绝不弹框、绝不中断断言。
let stdoutBroken = false;
function log(line) {
  const s = String(line);
  if (stdoutBroken) return;
  try { process.stdout.write(s + '\n'); } catch (err) { stdoutBroken = true; }
}
const rawLog = console.log.bind(console);
console.log = (...args) => { try { rawLog(...args); } catch (err) { stdoutBroken = true; } };

const check = (name, cond, detail) => {
  checks.push([name, !!cond, detail]);
  log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
};

// ---- 与 main.js 相同的实现（复制以确保行为一致；main.js 的接线另行核对） ----
const DEFAULT_BOUNDS = { width: 1320, height: 860, minWidth: 880, minHeight: 600 };

function visibleOnSomeDisplay(bounds) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const overlapX = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const overlapY = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return overlapX >= 120 && overlapY >= 120;
  });
}
function loadWindowState() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
  const b = raw && raw.bounds;
  if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
  const bounds = {
    width: Math.max(DEFAULT_BOUNDS.minWidth, Math.round(b.width)),
    height: Math.max(DEFAULT_BOUNDS.minHeight, Math.round(b.height)),
    x: Number.isFinite(b.x) ? Math.round(b.x) : undefined,
    y: Number.isFinite(b.y) ? Math.round(b.y) : undefined,
  };
  if (bounds.x !== undefined && bounds.y !== undefined && !visibleOnSomeDisplay(bounds)) {
    delete bounds.x; delete bounds.y;
  }
  return { bounds, maximized: raw.maximized === true };
}
function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const maximized = win.isMaximized();
  const b = win.getNormalBounds();
  const payload = { bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, maximized };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}
function attach(win) {
  let t = null;
  const schedule = () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; saveWindowState(win); }, 400); };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, schedule);
  win.on('close', () => { if (t) { clearTimeout(t); t = null; } saveWindowState(win); });
}
function create(saved) {
  const bounds = saved ? saved.bounds : null;
  const win = new BrowserWindow({
    width: bounds ? bounds.width : DEFAULT_BOUNDS.width,
    height: bounds ? bounds.height : DEFAULT_BOUNDS.height,
    ...(bounds && bounds.x !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 880, minHeight: 600, show: false, frame: false,
  });
  if (saved && saved.maximized) win.maximize();
  attach(win);
  return win;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 测试里会反复开关窗口，必须阻止「关掉最后一个窗口就退出应用」的默认行为
app.on('window-all-closed', (e) => { /* 保持进程存活，等断言跑完 */ });

app.whenReady().then(async () => {
  console.log('窗口状态记忆端到端验证\n');
  fs.rmSync(STATE_FILE, { force: true });

  console.log('== 1. 首次启动：没有记忆文件时用默认尺寸 ==')
  const w1 = create(loadWindowState());
  await sleep(300);
  const b1 = w1.getNormalBounds();
  check('首次为默认尺寸 1320x860', b1.width === 1320 && b1.height === 860, `${b1.width}x${b1.height}`);

  console.log('\n== 2. 调整尺寸/位置 → 关闭 → 记忆写入 ==')
  w1.setBounds({ x: 120, y: 90, width: 1100, height: 700 });
  await sleep(700); // 等防抖保存
  const b2 = w1.getNormalBounds();
  check('窗口确实被改到 1100x700', b2.width === 1100 && b2.height === 700, `${b2.width}x${b2.height}`);
  check('防抖后记忆文件已写入', fs.existsSync(STATE_FILE));
  const raw1 = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  check('记忆里的尺寸正确', raw1.bounds.width === 1100 && raw1.bounds.height === 700, JSON.stringify(raw1.bounds));
  check('记忆里的位置正确', raw1.bounds.x === 120 && raw1.bounds.y === 90, JSON.stringify(raw1.bounds));
  check('未最大化时 maximized=false', raw1.maximized === false);

  w1.close();
  await sleep(200);

  console.log('\n== 3. 再开：用记忆的尺寸与位置 ==')
  const saved = loadWindowState();
  check('loadWindowState 返回记忆', !!saved, JSON.stringify(saved && saved.bounds));
  const w2 = create(saved);
  await sleep(400);
  const b3 = w2.getNormalBounds();
  check('恢复为上次的 1100x700', b3.width === 1100 && b3.height === 700, `${b3.width}x${b3.height}`);
  check('恢复为上次的位置 (120,90)', b3.x === 120 && b3.y === 90, `${b3.x},${b3.y}`);

  console.log('\n== 4. 最大化状态也被记住（且记住的是还原尺寸）==')
  w2.maximize();
  await sleep(800);
  check('当前处于最大化', w2.isMaximized());
  const raw2 = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  check('记忆里 maximized=true', raw2.maximized === true, JSON.stringify(raw2));
  check('最大化时记的是还原尺寸 1100x700（不是屏幕尺寸）', raw2.bounds.width === 1100 && raw2.bounds.height === 700, JSON.stringify(raw2.bounds));
  w2.close();
  await sleep(200);

  console.log('\n== 5. 越界记忆的保护：记忆位置不在任何显示器上 ==')
  const offscreen = { bounds: { x: -99999, y: -99999, width: 1000, height: 700 }, maximized: false };
  fs.writeFileSync(STATE_FILE, JSON.stringify(offscreen), 'utf8');
  const loaded = loadWindowState();
  check('越界位置被丢弃', loaded && loaded.bounds.x === undefined && loaded.bounds.y === undefined, JSON.stringify(loaded && loaded.bounds));
  check('尺寸仍被保留', loaded && loaded.bounds.width === 1000 && loaded.bounds.height === 700);
  const w3 = create(loaded);
  await sleep(300);
  const b5 = w3.getNormalBounds();
  const vis = screen.getAllDisplays().some((d) => b5.x >= d.workArea.x - 50 && b5.x < d.workArea.x + d.workArea.width);
  check('窗口落在可见显示器范围内', vis, `${b5.x},${b5.y} ${b5.width}x${b5.height}`);
  w3.close();
  await sleep(200);

  console.log('\n== 6. 损坏的记忆文件不会导致启动失败 ==')
  fs.writeFileSync(STATE_FILE, '{ this is not json', 'utf8');
  let threw = null;
  let w4 = null;
  try { w4 = create(loadWindowState()); } catch (e) { threw = e.message; }
  check('损坏文件时回退默认（不抛错）', threw === null, String(threw));
  if (w4) { const b6 = w4.getNormalBounds(); check('回退到默认尺寸', b6.width === 1320, `${b6.width}x${b6.height}`); w4.close(); }

  const fails = checks.filter((r) => !r[1]).length;
  log('\n结果: ' + (checks.length - fails) + ' 通过, ' + fails + ' 失败');
  if (stdoutBroken) {
    // 管道断了也别把结果丢掉：落到临时文件，父进程还能捞回来
    try { fs.writeFileSync(path.join(require('node:os').tmpdir(), 'dsh-window-state-result.txt'), checks.map((c) => (c[1] ? 'PASS ' : 'FAIL ') + c[0]).join('\n'), 'utf8'); } catch (err) {}
  }
  process.exit(fails ? 1 : 0);
}).catch((e) => { console.error('FAIL', e); process.exit(1); });
