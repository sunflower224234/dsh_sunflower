'use strict';
/**
 * DSH 后端管理（纯 Node 实现，不依赖 Electron，便于单独测试）。
 * 职责：定位 node 与 dsh、探测/启动 dsh web 服务、等待就绪、结束进程树。
 */
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LOG = (...args) => console.log('[dsh-desktop]', ...args);

/** 当前由本模块拉起、尚未退出的后端子进程（用于退出时兜底清理）。 */
let liveChild = null;

/**
 * 定位系统 node 的绝对路径。
 * Electron 主进程里 process.execPath 是 electron.exe，不是 node，所以需要单独找。
 */
function resolveNode() {
  const override = process.env.DSH_NODE;
  if (override && fs.existsSync(override)) return override;
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(cmd, ['node'], { encoding: 'utf8' });
    if (r.status === 0) {
      const first = (r.stdout || '').trim().split(/\r?\n/)[0].trim();
      if (first) return first;
    }
  } catch { /* ignore */ }
  return 'node';
}

/** 定位 @deepseek-ai/dsh 的 bin.js 绝对路径。 */
function resolveDshBin() {
  const candidates = [
    process.env.DSH_BIN,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : null,
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
    if (r.status === 0) {
      const p = path.join((r.stdout || '').trim(), '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return null;
}

/** 探测一个 HTTP URL，返回 { status, contentType }，不可达时返回 null。 */
function probeHttp(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const status = res.statusCode;
      const contentType = res.headers['content-type'] || '';
      res.resume();
      resolve({ status, contentType });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/** 轮询直到 URL 返回 200，或超时。 */
function waitHttp(url, timeoutMs = 30000, intervalMs = 400) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const r = await probeHttp(url, 2000);
      if (r && r.status === 200) return resolve(r);
      if (Date.now() - start > timeoutMs) return reject(new Error(`等待服务就绪超时：${url}`));
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}（${ms}ms）`)), ms)),
  ]);
}

/** 从新版 dsh web 的启动提示中提取完整回环 URL（包括认证 token）。 */
function extractDshUrl(output) {
  const match = /dsh web:\s*(https?:\/\/127\.0\.0\.1(?::\d+)?(?:\/[^\s]*)?)/u.exec(output);
  return match ? match[1] : null;
}

/**
 * 启动 dsh web 后端进程。
 * @returns {{ child: import('node:child_process').ChildProcess, urlPromise: Promise<string> }}
 *          urlPromise 会从进程 stdout 解析出实际监听地址（支持 --port 0 自动分配的情况）。
 */
function startBackend(port, opts = {}) {
  const node = resolveNode();
  const bin = resolveDshBin();
  if (!bin) {
    throw new Error(
      '未找到 dsh 安装。请先执行：npm install -g @deepseek-ai/dsh\n' +
      '或设置环境变量 DSH_BIN 指向其 lib/bin.js。'
    );
  }
  const args = ['web', '--port', String(port)];
  LOG('启动后端进程:', node, bin, args.join(' '));
  const stdio = opts.stdio || ['ignore', 'pipe', 'pipe'];
  const child = spawn(node, [bin, ...args], { stdio, windowsHide: true });
  liveChild = child;
  child.on('exit', () => { if (liveChild === child) liveChild = null; });

  let output = '';
  let settled = false;
  const urlPromise = new Promise((resolve, reject) => {
    const onChunk = (d) => {
      output += d.toString();
      if (output.length > 64 * 1024) output = output.slice(-16 * 1024);
      if (!settled) {
        const url = extractDshUrl(output);
        if (url) { settled = true; resolve(url); }
      }
    };
    if (child.stdout) child.stdout.on('data', onChunk);
    if (child.stderr) child.stderr.on('data', onChunk);
    child.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        reject(new Error(`dsh web 提前退出（code=${code}${signal ? ', signal=' + signal : ''}）\n${output.slice(-2000)}`));
      }
    });
  });
  return { child, urlPromise };
}

/** 结束进程：先用 Node 自带 kill（最可靠），Windows 下再尽力连带结束子进程树。 */
function killTree(child) {
  if (!child) return;
  try { child.kill(); } catch { /* ignore */ }
  if (process.platform === 'win32' && child.pid) {
    try {
      // 补充清扫 dsh 可能派生出的子进程（受限环境里 taskkill 可能被禁用，此时上面的 kill 已覆盖主进程）
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* ignore */ }
  }
}

/**
 * 确保一个可用的 DSH web 服务：
 *   1) 首选端口已有 DSH 服务 → 直接复用（owned=false，退出时不会结束它）；
 *   2) 否则在首选端口启动；若失败则改用 --port 0 让系统分配端口并解析实际地址。
 * @returns {Promise<{url: string, owned: boolean, child: import('node:child_process').ChildProcess|null}>}
 */
async function ensureServer() {
  const preferred = Number(process.env.DSH_PORT) || 3080;
  const reuseUrl = `http://127.0.0.1:${preferred}/`;

  const existing = await probeHttp(reuseUrl, 1500);
  if (existing && existing.status === 200 && /text\/html/.test(existing.contentType)) {
    LOG(`检测到已运行的 DSH 服务，直接复用：${reuseUrl}`);
    return { url: `http://127.0.0.1:${preferred}`, owned: false, child: null };
  }

  let b = startBackend(preferred);
  try {
    const url = await withTimeout(b.urlPromise, 20000, '等待 dsh web 输出监听地址');
    await waitHttp(url, 30000);
    return { url, owned: true, child: b.child };
  } catch (err) {
    LOG('首选端口启动失败，改用系统分配端口。原因：', err.message);
    killTree(b.child);
    const b2 = startBackend(0);
    const url = await withTimeout(b2.urlPromise, 20000, '等待 dsh web 输出监听地址');
    await waitHttp(url, 30000);
    return { url, owned: true, child: b2.child };
  }
}

/** 结束本模块当前拉起的后端子进程（若存在）。用于应用退出时的兜底清理。 */
function killAll() {
  if (liveChild) {
    killTree(liveChild);
    liveChild = null;
  }
}

module.exports = { resolveNode, resolveDshBin, extractDshUrl, probeHttp, waitHttp, startBackend, killTree, killAll, ensureServer, LOG };
