'use strict';
/**
 * DeepSeek Harness 桌面端（Electron 外壳，无边框 + 注入式自定义标题栏）。
 * 自动启动（或复用已运行的）dsh web 后端，用无边框窗口加载其 Web UI。
 * 标题栏由 preload 注入到页面内部（半透明 + backdrop 模糊），浮在 dsh 内容上方，
 * 让真实背景透上来并被模糊 —— 与背景融为一体；内容下移让出标题栏。
 * 关闭窗口时自动结束后端进程。
 */
const { app, BrowserWindow, Menu, dialog, shell, nativeTheme, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const backend = require('./lib/backend');
const { TITLEBAR_HEIGHT } = require('./titlebar-common');

const APP_TITLE = 'DeepSeek Harness';
const SMOKE = process.env.DSH_DESKTOP_SMOKE === '1';
const BACKGROUND_DIR = path.join(__dirname, 'assets', 'backgrounds');

/** 首次启动（还没有记忆文件）时的窗口尺寸。 */
const DEFAULT_BOUNDS = { width: 1320, height: 860, minWidth: 880, minHeight: 600 };
/** 窗口状态（尺寸/位置/最大化）存到用户数据目录，避免每次重调。 */
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
let saveStateTimer = null;

let mainWindow = null;
let server = null; // { url, owned, child }
let launchBackground = null; // { file, url, dataUrlPromise } 本次启动随机选中的背景图

/** 图片 MIME（按扩展名）。 */
function imageMime(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

/**
 * 读取上次记住的窗口状态。
 * 返回 null 表示「没有可用记忆」（首次启动、文件损坏、或记下的位置如今不在任何显示器上）。
 */
/** 读取记忆文件（容错）：不存在或损坏都返回 null。 */
function readStateFile() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 原子写入记忆文件（临时文件 + rename，避免半截 JSON 被读到）。
 * 只合并传入的字段，不动文件里已有的其它键（例如 lastBackground）。
 */
function writeStateFile(patch) {
  try {
    const current = readStateFile() || {};
    const next = { ...current, ...patch };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    return next;
  } catch (err) {
    backend.LOG('窗口状态保存失败：', err && err.message ? err.message : err);
    return null;
  }
}

function loadWindowState() {
  const raw = readStateFile();
  if (!raw) return null; // 首次启动或文件损坏：用默认尺寸
  const b = raw && raw.bounds
  if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
  const bounds = {
    width: Math.max(DEFAULT_BOUNDS.minWidth, Math.round(b.width)),
    height: Math.max(DEFAULT_BOUNDS.minHeight, Math.round(b.height)),
    x: Number.isFinite(b.x) ? Math.round(b.x) : undefined,
    y: Number.isFinite(b.y) ? Math.round(b.y) : undefined,
  };
  // 位置要落在某块显示器上，否则（拔掉外接屏/改过分辨率）会把窗口恢复到看不见的地方
  if (bounds.x !== undefined && bounds.y !== undefined && !visibleOnSomeDisplay(bounds)) {
    delete bounds.x
    delete bounds.y
  }
  return { bounds, maximized: raw.maximized === true };
}

/** 上一次用过的那张壁纸（用于「避开上一张」），没有则返回 null。 */
function loadLastBackground() {
  const raw = readStateFile();
  return raw && typeof raw.lastBackground === 'string' && raw.lastBackground ? raw.lastBackground : null;
}

/** 记忆的矩形是否与任一显示器有足够交集（至少 120px 可见）。 */
function visibleOnSomeDisplay(bounds) {
  try {
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      const overlapX = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
      const overlapY = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
      return overlapX >= 120 && overlapY >= 120;
    });
  } catch {
    return true; // 拿不到显示器信息时不要擅自丢弃用户的位置
  }
}

/** 把当前窗口状态写入记忆文件（原子写：临时文件 + rename）。 */
function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  // 最大化时 getBounds 返回的是最大化后的矩形，不能拿它当「还原尺寸」；
  // getNormalBounds 才是还原后的尺寸，这样「最大化→关闭→再开」也能记住原来的大小。
  const b = win.getNormalBounds();
  writeStateFile({ bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, maximized: win.isMaximized() });
}

/** 绑定窗口状态的记忆：改变尺寸/位置/最大化状态后防抖保存，关闭时立即保存。 */
function attachWindowStatePersistence(win) {
  const schedule = () => {
    if (saveStateTimer) clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => { saveStateTimer = null; saveWindowState(win); }, 400);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, schedule);
  win.on('close', () => {
    if (saveStateTimer) { clearTimeout(saveStateTimer); saveStateTimer = null; }
    saveWindowState(win);
  });
}

/**
 * 每次启动从 assets/backgrounds 随机挑一张背景图，并**避开上次用过的那张**
 * （纯随机也允许连续两张一样，但观感上很扎眼；排除上一张后其余等概率，
 * 仍保留随机性，只是消掉「连着两次一模一样」）。
 *   - 启动界面：经 ?bg=<file> 传给 loading.html（它自己按相对路径取图）；
 *   - 主界面：经 IPC 以 data URL 下发（dsh 页面跑在 http://127.0.0.1:3080，
 *     CSP 会拦掉 file:// 图片 —— 实测 file:// 图片在该页面里 naturalWidth 恒为 0，
 *     而 data URL 正常，所以这里由主进程读文件后编码下发，与 titlebar:icon 同一套做法）。
 * 两者共用同一次随机结果，保证启动界面和进入应用后是同一张。
 * 上一张记录在记忆文件里，所以重启进程后依然有效；只有一张图时自然就选它。
 */
function pickBackground(exclude) {
  try {
    const files = fs.readdirSync(BACKGROUND_DIR)
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .sort();
    if (!files.length) return null;
    // 候选 = 除上一次那张以外的全部；候选为空（只有一张图）时退回全部
    const pool = files.length > 1 && exclude ? files.filter((f) => f !== exclude) : files;
    const candidates = pool.length ? pool : files;
    const file = candidates[Math.floor(Math.random() * candidates.length)];
    const filePath = path.join(BACKGROUND_DIR, file);
    let cached = null; // 懒编码 + 缓存，避免每次取用都重读一遍 2MB 图
    return {
      file,
      url: pathToFileURL(filePath).toString(),
      dataUrl: () => {
        if (cached === null) {
          cached = `data:${imageMime(file)};base64,` + fs.readFileSync(filePath).toString('base64');
        }
        return cached;
      },
    };
  } catch (err) {
    backend.LOG('背景图读取失败，回退到纯色背景：', err && err.message ? err.message : err);
    return null;
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    backend.LOG('关闭 DSH 后端进程…');
    backend.killAll();
  });

  Menu.setApplicationMenu(null);

  // 注入式标题栏的窗口控制
  ipcMain.on('titlebar:minimize', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.on('titlebar:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('titlebar:close', () => { if (mainWindow) mainWindow.close(); });

  // 标题栏图标（鲸鱼娘）给注入式 preload，避免沙箱渲染进程直接读文件
  ipcMain.handle('titlebar:icon', () => {
    try {
      const p = path.join(__dirname, 'splash.png');
      return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
    } catch {
      return null;
    }
  });

  // 标题栏高度（单一来源 titlebar-common.js）：沙箱化 preload 不能 require 本地文件，
  // 由主进程经 IPC 把 TITLEBAR_HEIGHT 下发，保证与 main.js 的顶层占位参数始终一致。
  ipcMain.handle('titlebar:height', () => TITLEBAR_HEIGHT);

  // 本次启动选中的背景图（data URL），供注入式壁纸层在 dsh 主界面上铺底
  ipcMain.handle('titlebar:background', () => {
    try {
      return launchBackground ? launchBackground.dataUrl() : null;
    } catch (err) {
      backend.LOG('背景图编码失败：', err && err.message ? err.message : err);
      return null;
    }
  });

  app.whenReady().then(run).catch((err) => fail(err));
}

function createWindow() {
  // 原生主题切深色，与深色界面一致
  nativeTheme.themeSource = 'dark';
  const saved = loadWindowState();
  const bounds = saved ? saved.bounds : null;
  const win = new BrowserWindow({
    width: bounds ? bounds.width : DEFAULT_BOUNDS.width,
    height: bounds ? bounds.height : DEFAULT_BOUNDS.height,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 880,
    minHeight: 600,
    title: APP_TITLE,
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#0e1420',
    frame: false,          // 无边框
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'titlebar-preload.js'),
    },
  });
  mainWindow = win;

  // 最大化状态要在窗口显示前恢复，否则会先闪一下小窗
  if (saved && saved.maximized) win.maximize();

  attachWindowStatePersistence(win);

  // 先显示 loading（preload 会把标题栏同步注入）
  // 随机背景图经查询参数交给 loading.html 的样式变量，避免渲染进程直接读文件
  win.loadFile(path.join(__dirname, 'loading.html'), {
    query: launchBackground ? { bg: launchBackground.file } : {},
  });

  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => notifyMaximized(true));
  win.on('unmaximize', () => notifyMaximized(false));
  win.on('closed', () => { mainWindow = null; });
  wireWindow(win.webContents);
  return win;
}

// 内容页面的窗口策略与快捷键
function wireWindow(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    if (server && server.url) {
      try {
        if (new URL(url).origin !== new URL(server.url).origin) {
          event.preventDefault();
          shell.openExternal(url);
        }
      } catch { /* 忽略非法 URL */ }
    }
  });

  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') { wc.toggleDevTools(); event.preventDefault(); }
    if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
      wc.reload();
      event.preventDefault();
    }
  });
}

function notifyMaximized(maximized) {
  try { mainWindow?.webContents.send('titlebar:maximized', Boolean(maximized)); } catch {}
}

async function run() {
  // 无窗口冒烟测试（供自动化验证）：拉起后端 → 就绪 → 退出
  if (SMOKE) {
    try {
      server = await backend.ensureServer();
      backend.LOG('SMOKE READY', server.url, 'owned=' + String(server.owned));
      if (server.owned) backend.killTree(server.child);
      process.exit(0);
    } catch (err) {
      backend.LOG('SMOKE FAIL', err && err.message ? err.message : err);
      process.exit(1);
    }
  }

  // 避开上次用过的那张（记录在记忆文件里，重启进程后依然有效）
  launchBackground = pickBackground(loadLastBackground());
  if (launchBackground) writeStateFile({ lastBackground: launchBackground.file });
  backend.LOG('启动界面背景：', launchBackground ? launchBackground.file : '（无可用背景图）');
  mainWindow = createWindow();

  try {
    server = await backend.ensureServer();
    // 按 dsh-better-sidebar 的契约声明桌面壳的顶部占位：注入式自定义标题栏
    // 高 TITLEBAR_HEIGHT（titlebar-common.js 的单一来源）。插件据此把展开按钮
    // 与侧边栏内容下移到标题栏下方（data-dsh-title-bar-compat），避免被浮层标题栏盖住。
    // 仅本桌面壳加载时带参，普通浏览器访问 127.0.0.1:3080 不受影响。
    const target = new URL(server.url);
    target.searchParams.set('dsh-desktop-mode', 'advanced');
    target.searchParams.set('dsh-desktop-titlebar-inset', String(TITLEBAR_HEIGHT));
    await mainWindow.loadURL(target.toString());
  } catch (err) {
    fail(err);
  }
}

function fail(err) {
  const msg = err && err.message ? err.message : String(err);
  backend.LOG('启动失败：', msg);
  dialog.showErrorBox(APP_TITLE, '无法启动 DeepSeek Harness：\n\n' + msg);
  app.quit();
}
