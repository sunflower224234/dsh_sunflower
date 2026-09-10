'use strict';
// DSH 桌面端 —— 后端生命周期自测（纯 Node，不需要 Electron）
const backend = require('./lib/backend');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** 目录是否可写（真正试写，避免 accessSync 对沙箱误报）。 */
function canWriteDir(dir) {
  try {
    const p = path.join(dir, '.dsh-wtest-' + Date.now());
    fs.writeFileSync(p, 'x');
    fs.rmSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保存在一个可写的 DSH_HOME 供启动测试：
 * 默认 ~/.dsh 可写时直接用；不可写（如受限沙箱）时，
 * 用工作区临时目录 + junction 复用真实 profiles 的依赖。
 */
function ensureWritableDshHome() {
  const real = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profileDir = path.join(real, 'profiles', 'web');
  if (fs.existsSync(profileDir) && canWriteDir(profileDir)) return real;

  const alt = path.join(__dirname, '..', '.dsh-test');
  fs.rmSync(alt, { recursive: true, force: true });
  const altProfile = path.join(alt, 'profiles', 'web');
  fs.mkdirSync(altProfile, { recursive: true });
  for (const f of ['package.json', 'cordis.yml', 'pnpm-workspace.yaml']) {
    const src = path.join(real, 'profiles', 'web', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(altProfile, f));
  }
  try {
    fs.symlinkSync(path.join(real, 'profiles', 'node_modules'), path.join(alt, 'profiles', 'node_modules'), 'junction');
  } catch { /* 无 node_modules 可复用也无妨 */ }
  console.log('  默认 DSH_HOME 不可写，改用临时目录：' + alt);
  return alt;
}

const results = [];
function check(name, cond, extra) {
  results.push([name, !!cond]);
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  [' + extra + ']' : ''));
}

(async () => {
  // 1. 定位 node 与 dsh
  const node = backend.resolveNode();
  check('resolveNode 返回路径', typeof node === 'string' && node.length > 0, node);

  const bin = backend.resolveDshBin();
  check('resolveDshBin 找到 bin.js', !!bin, bin);

  // 2. 探测当前已在运行的 3080 服务（若存在）
  const existing = await backend.probeHttp('http://127.0.0.1:3080/', 1500);
  console.log('  探测 3080：' + (existing ? 'status=' + existing.status : '未运行（跳过复用检查）'));

  // 3. 启动一个全新的 dsh web（独立端口）→ 就绪 → 结束 → 端口释放
  if (!bin) {
    console.log('  跳过启动测试：未找到 dsh 安装');
    return finish();
  }
  process.env.DSH_HOME = ensureWritableDshHome();
  const port = await freePort();
  console.log('  使用空闲端口 ' + port + ' 启动全新 dsh web…');

  const b = backend.startBackend(port);

  let ready = false;
  let readyUrl = 'http://127.0.0.1:' + port + '/';
  try {
    readyUrl = await Promise.race([
      b.urlPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('等待启动 URL 超时')), 120000)),
    ]);
    await backend.waitHttp(readyUrl, 120000);
    ready = true;
  } catch (e) {
    check('新服务就绪 (HTTP 200)', false, e.message);
  }
  check('新服务就绪 (HTTP 200)', ready, readyUrl.replace(/token=[^&]+/u, 'token=<redacted>'));

  backend.killTree(b.child);
  // 轮询等待端口释放（child.kill() 通常在几百毫秒内完成）
  let released = null;
  for (let t = 0; t < 5000; t += 250) {
    await new Promise((r) => setTimeout(r, 250));
    const after = await backend.probeHttp(`http://127.0.0.1:${port}/`, 400);
    if (after === null) { released = t + 250; break; }
  }
  check('关闭后端口已释放', released !== null, released === null ? '5 秒内未释放' : '释放耗时约 ' + released + 'ms');

  // 4. 新版 dsh 的 URL 带认证 token，桌面壳必须完整保留查询串。
  const parsed = backend.extractDshUrl('dsh web: http://127.0.0.1:64243/?token=test-token');
  check('URL 行解析并保留认证 token', parsed === 'http://127.0.0.1:64243/?token=test-token', parsed);

  finish();
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});

function finish() {
  const fails = results.filter((r) => !r[1]).length;
  console.log('\n结果: ' + (results.length - fails) + ' 通过, ' + fails + ' 失败');
  process.exit(fails ? 1 : 0);
}
