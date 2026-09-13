#!/usr/bin/env node
/**
 * 银狼 TTS 服务 · 常驻启动器
 * ---------------------------------------------------------------------------
 * 为什么需要这个脚本（而不是直接用 start-silverwolf-tts.ps1）：
 *
 *  1. 原 .ps1 用 `Start-Process` + `if ($process.HasExited)` 判断就绪，
 *     实测会误判 —— 日志里 Uvicorn 已经 `Application startup complete`
 *     且 /docs 返回 200，脚本仍抛 "did not become ready within 120 seconds"。
 *  2. 从自动化环境（如 DSH 的一次性终端会话）用 Start-Job / Start-Process
 *     起的子进程会随会话结束被清理，服务活不下来。
 *
 * 本脚本的做法：`spawn(..., { detached: true })` + `unref()`，
 * 让 uvicorn 成为独立进程；就绪判定改为【轮询 TCP 端口】，不看进程对象。
 *
 * 用法：
 *   node start-tts-service.mjs              # 启动（已在跑则直接返回）
 *   node start-tts-service.mjs --status     # 只看状态
 *   node start-tts-service.mjs --stop       # 停止
 *   node start-tts-service.mjs --force      # 忽略已有实例，强制重启
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, mkdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const TTS_ROOT = '<<<GPT-SoVITS目录>>>';
const PYTHON = join(TTS_ROOT, '.venv/Scripts/python.exe');
const CONFIG = 'GPT_SoVITS/configs/tts_infer-silverwolf.yaml';
const PID_FILE = join(TTS_ROOT, 'tts-silverwolf.pid');
const STDOUT_LOG = join(TTS_ROOT, 'tts-silverwolf.stdout.log');
const STDERR_LOG = join(TTS_ROOT, 'tts-silverwolf.stderr.log');
const HOST = '127.0.0.1';
const PORT = 9880;
const READY_TIMEOUT_MS = 240_000;

const args = process.argv.slice(2);
const wantStatus = args.includes('--status');
const wantStop = args.includes('--stop');
const force = args.includes('--force');

const log = (msg) => console.log(`[银狼TTS] ${msg}`);

/** 探测端口是否可建立 TCP 连接（比看进程对象可靠） */
function probePort(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: HOST, port: PORT });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function readPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stop() {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    // 没有记录的 pid，退一步：按端口找占用者
    log('没有可用的 pid 记录，尝试按端口停止...');
  } else {
    try {
      process.kill(pid, 'SIGTERM');
      log(`已发送停止信号给 pid=${pid}`);
    } catch (error) {
      log(`停止失败：${error.message}`);
    }
  }
  // 等服务真正退出
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await probePort())) break;
  }
  try { unlinkSync(PID_FILE); } catch {}
  const still = await probePort();
  log(still ? '⚠ 端口仍在监听（可能由其他进程占用）' : '已停止，端口已释放');
  return !still;
}

async function status() {
  const pid = readPid();
  const listening = await probePort();
  const info = {
    listening,
    pid: pid ?? null,
    pidAlive: isAlive(pid),
    endpoint: `http://${HOST}:${PORT}`,
    config: CONFIG,
    python: PYTHON,
    pythonExists: existsSync(PYTHON),
  };
  console.log(JSON.stringify(info, null, 2));
  return listening;
}

async function start() {
  if (await probePort()) {
    if (!force) {
      log(`服务已在运行（http://${HOST}:${PORT}），无需重复启动。`);
      await status();
      return true;
    }
    log('--force 指定，先停止现有实例...');
    await stop();
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (!existsSync(PYTHON)) {
    log(`❌ 找不到 python：${PYTHON}`);
    process.exit(2);
  }
  if (!existsSync(join(TTS_ROOT, CONFIG))) {
    log(`❌ 找不到配置：${join(TTS_ROOT, CONFIG)}`);
    process.exit(2);
  }

  mkdirSync(TTS_ROOT, { recursive: true });
  const out = openSync(STDOUT_LOG, 'a');
  const err = openSync(STDERR_LOG, 'a');

  log(`加载银狼权重（${CONFIG}）...`);
  const child = spawn(
    PYTHON,
    ['api_v2.py', '-a', HOST, '-p', String(PORT), '-c', CONFIG],
    {
      cwd: TTS_ROOT,
      detached: true,          // 关键：脱离父进程组
      stdio: ['ignore', out, err],
      windowsHide: true,
    },
  );
  child.unref();               // 关键：不阻塞父进程退出

  writeFileSync(PID_FILE, String(child.pid), 'utf8');
  log(`进程已脱离启动，pid=${child.pid}（日志：tts-silverwolf.{stdout,stderr}.log）`);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await probePort()) { ready = true; break; }
    if (!isAlive(child.pid)) {
      log(`❌ 进程 ${child.pid} 已退出。stderr 尾部：`);
      try {
        const tail = readFileSync(STDERR_LOG, 'utf8').split(/\r?\n/).slice(-25).join('\n');
        console.error(tail);
      } catch {}
      try { unlinkSync(PID_FILE); } catch {}
      process.exit(1);
    }
  }

  if (!ready) {
    log(`❌ ${READY_TIMEOUT_MS / 1000}s 内端口未就绪。stderr 尾部：`);
    try {
      const tail = readFileSync(STDERR_LOG, 'utf8').split(/\r?\n/).slice(-25).join('\n');
      console.error(tail);
    } catch {}
    process.exit(1);
  }

  log(`✅ 就绪：http://${HOST}:${PORT}（pid=${child.pid}）`);
  return true;
}

if (wantStop) {
  await stop();
  process.exit(0);
} else if (wantStatus) {
  const listening = await status();
  process.exit(listening ? 0 : 1);
} else {
  await start();
  process.exit(0);
}
