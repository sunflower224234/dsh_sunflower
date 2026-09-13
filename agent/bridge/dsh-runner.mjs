import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { logTask } from './audit-logger.mjs';

const require = createRequire(import.meta.url);

const COLLAB_SESSION_TITLE = '【协同频道】Antigravity ↔ DSH';
const COLLAB_CACHE_FILE = '.agent/collab-session.json';

function resolveWsModule() {
  const candidates = [
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'ws'),
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'ws')
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return require(p);
    } catch {}
  }
  return null;
}

function resolveDshBin() {
  if (process.env.DSH_BIN && existsSync(process.env.DSH_BIN)) {
    return process.env.DSH_BIN;
  }
  const candidates = [
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : null,
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 尝试获取正在运行的 DSH Desktop 后端凭据
 */
function getDesktopBackendInfo() {
  try {
    const backendFile = join(process.env.APPDATA || '', 'dsh-desktop', 'backend.json');
    if (!existsSync(backendFile)) return null;
    const data = JSON.parse(readFileSync(backendFile, 'utf8'));
    if (!data.url || !data.origin) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 通过桌面端后端 URL 换取授权 Cookie
 */
async function fetchAuthCookie(backendUrl) {
  return new Promise((resolvePromise, reject) => {
    const urlObj = new URL(backendUrl);
    const req = http.get(backendUrl, {
      headers: {
        Host: urlObj.host,
        Origin: urlObj.origin
      }
    }, res => {
      const setCookie = res.headers['set-cookie'];
      if (!setCookie || setCookie.length === 0) {
        return reject(new Error('未能从 DSH 桌面端获取到 Set-Cookie'));
      }
      const cookie = setCookie[0].split(';')[0];
      resolvePromise(cookie);
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('连接 DSH 桌面端后端超时'));
    });
  });
}

/**
 * 向 DSH Web API 发起 RPC 一元调用
 */
async function rpcCall(origin, cookie, method, payload) {
  const rpcId = crypto.randomUUID();
  const body = JSON.stringify({
    type: 'client-request',
    rpcId,
    method,
    payload
  });

  const urlObj = new URL(origin);

  return new Promise((resolvePromise, reject) => {
    const req = http.request(`${origin}/api/${method}`, {
      method: 'POST',
      headers: {
        Host: urlObj.host,
        Origin: urlObj.origin,
        'Content-Type': 'application/json',
        Cookie: cookie
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.result?.ok === false) {
            reject(new Error(parsed.result.error?.message || `RPC ${method} 调用失败`));
          } else {
            resolvePromise(parsed.result?.value);
          }
        } catch {
          reject(new Error(`RPC ${method} 返回无效数据: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error(`RPC ${method} 请求超时`));
    });
    req.write(body);
    req.end();
  });
}

/**
 * 获取或创建专属协同会话
 */
async function getOrCreateCollabSession(origin, cookie, cwd) {
  // 1. 检查本地缓存中的 sessionId 是否仍然有效
  if (existsSync(COLLAB_CACHE_FILE)) {
    try {
      const cached = JSON.parse(readFileSync(COLLAB_CACHE_FILE, 'utf8'));
      if (cached.sessionId) {
        // 验证该 session 是否在 list 中存在
        const listRes = await rpcCall(origin, cookie, 'session/list', { args: { _request: {} } });
        const exists = (listRes?.items || []).some(s => s.sessionId === cached.sessionId);
        if (exists) {
          return cached.sessionId;
        }
      }
    } catch {}
  }

  // 2. 从 DSH 现有会话中寻找专属协同会话
  const listRes = await rpcCall(origin, cookie, 'session/list', { args: { _request: {} } });
  const items = listRes?.items || [];
  const found = items.find(s => s.projections?.values?.title === COLLAB_SESSION_TITLE);
  if (found) {
    if (!existsSync('.agent')) mkdirSync('.agent', { recursive: true });
    writeFileSync(COLLAB_CACHE_FILE, JSON.stringify({ sessionId: found.sessionId, title: COLLAB_SESSION_TITLE }, null, 2), 'utf8');
    return found.sessionId;
  }

  // 3. 不存在则新建一个会话并命名为专属协同频道
  console.log(`[DSH Bridge] 正在为双智能体协同创建专属常驻会话: "${COLLAB_SESSION_TITLE}"...`);
  const createRes = await rpcCall(origin, cookie, 'session/create', {
    args: {
      request: {
        cwd: resolve(cwd)
      }
    }
  });

  const newSessionId = createRes.sessionId;
  await rpcCall(origin, cookie, 'session/rename', {
    args: {
      request: {
        sessionId: newSessionId,
        title: COLLAB_SESSION_TITLE
      }
    }
  });

  if (!existsSync('.agent')) mkdirSync('.agent', { recursive: true });
  writeFileSync(COLLAB_CACHE_FILE, JSON.stringify({ sessionId: newSessionId, title: COLLAB_SESSION_TITLE }, null, 2), 'utf8');
  console.log(`[DSH Bridge] 专属协同会话创建完成: ${newSessionId}`);
  return newSessionId;
}

/**
 * 方案 A：直接通过正在运行的 DSH 桌面端实时协同（单会话持续追问 + 桌面端实时流式可见）
 */
async function executeViaLiveDesktop({
  backend,
  taskId,
  taskTitle,
  prompt,
  cwd,
  timeoutSeconds
}) {
  const WebSocket = resolveWsModule();
  if (!WebSocket) {
    throw new Error('未找到 ws 模块，无法开启实时流式传输');
  }

  const startTime = Date.now();
  const origin = backend.origin;
  const cookie = await fetchAuthCookie(backend.url);
  const sessionId = await getOrCreateCollabSession(origin, cookie, cwd);

  console.log(`[DSH Bridge] 已接入 DSH 桌面端活动会话: ${sessionId}`);
  console.log(`[DSH Bridge] 提示：您可直接在已打开的 DSH 桌面端窗口中看到本次协同的实时思考与工具调用！`);

  // 连接 WebSocket 获取实时流
  const wsUrl = `${origin.replace(/^http/, 'ws')}/api/remote.mux`;
  const urlObj = new URL(origin);
  const ws = new WebSocket(wsUrl, {
    headers: {
      Host: urlObj.host,
      Origin: origin,
      Cookie: cookie
    }
  });

  await new Promise((resolvePromise, reject) => {
    ws.on('open', resolvePromise);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000);
  });

  const streamId = crypto.randomUUID();
  const followRequest = {
    type: 'open',
    streamId,
    endpoint: 'session/follow',
    payload: {
      args: {
        request: {
          address: { kind: 'session', sessionId },
          assistantStream: true
        }
      }
    }
  };

  let assistantText = '';
  let reasoningText = '';
  let turnFinished = false;
  let turnError = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'item' && msg.streamId === streamId) {
        const item = msg.value;
        if (item.type === 'assistant-stream') {
          const frame = item.frame;
          if (frame.type === 'chunk') {
            const chunk = frame.chunk;
            if (chunk?.type === 'reasoning-delta') {
              process.stdout.write(`\x1b[90m${chunk.text || ''}\x1b[0m`);
              reasoningText += (chunk.text || '');
            } else if (chunk?.type === 'text-delta') {
              process.stdout.write(chunk.text || '');
              assistantText += (chunk.text || '');
            } else if (chunk?.type === 'tool-call-delta') {
              process.stdout.write(`\x1b[33m${chunk.argumentsDelta || ''}\x1b[0m`);
            }
          }
        } else if (item.event?.type === 'tool/call') {
          const data = item.event.data;
          console.log(`\n\x1b[33m[Tool Call]\x1b[0m ${data.name}(${data.arguments || ''})`);
        } else if (item.event?.type === 'tool/result') {
          console.log(`\x1b[32m[Tool Result]\x1b[0m 完成`);
        } else if (item.event?.type === 'turn/end') {
          turnFinished = true;
        }
      } else if (msg.type === 'error' && msg.streamId === streamId) {
        turnError = new Error(msg.error?.message || 'Remote stream error');
        turnFinished = true;
      }
    } catch (e) {
      // 容错处理单个帧的解析异常
    }
  });

  ws.send(JSON.stringify(followRequest));
  await new Promise(r => setTimeout(r, 400));

  // 发送本次任务提示词
  const userPromptText = [
    `【协同任务 ${taskId}】${taskTitle}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    prompt
  ].join('\n');

  console.log(`[DSH Bridge] 正在下发任务契约至会话...`);
  const promptRequestId = crypto.randomUUID();
  await rpcCall(origin, cookie, 'session/prompt', {
    args: {
      request: {
        requestId: promptRequestId,
        sessionId,
        mode: 'queue',
        content: [
          { type: 'text', text: userPromptText }
        ]
      }
    }
  });

  console.log(`[DSH Bridge] 任务已接受，DSH 正在执行中...\n`);

  // 等待本轮对话结束
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (!turnFinished && Date.now() < deadline) {
    if (turnError) break;
    await new Promise(r => setTimeout(r, 300));
  }

  try { ws.close(); } catch {}

  if (turnError) throw turnError;
  if (!turnFinished) throw new Error(`DSH 执行超时（超过 ${timeoutSeconds} 秒）`);

  const durationMs = Date.now() - startTime;
  console.log(`\n[DSH Bridge] 协同任务 ${taskId} 执行完成 (${(durationMs / 1000).toFixed(1)}s)`);

  const result = {
    taskId,
    taskTitle,
    success: true,
    exitCode: 0,
    durationMs,
    result: assistantText.trim(),
    reasoning: reasoningText.trim(),
    sessionId,
    mode: 'live-desktop'
  };

  logTask({
    taskId,
    taskTitle,
    success: true,
    durationMs,
    exitCode: 0
  });

  return result;
}

/**
 * 方案 B：回退方案（当 DSH 桌面端未运行时，使用 headless CLI 独立执行）
 */
function executeViaHeadlessCli({
  taskId,
  taskTitle,
  prompt,
  cwd = process.cwd(),
  timeoutSeconds = 300
}) {
  return new Promise((resolvePromise, reject) => {
    const startTime = Date.now();
    const fullPrompt = [
      `【协同任务 ${taskId}】${taskTitle}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      prompt
    ].join('\n');

    console.log(`[DSH Bridge] 未检测到运行中的 DSH 桌面端，正在以 headless 模式启动独立进程...`);

    const COLLAB_PROFILE = process.env.DSH_COLLAB_PROFILE || 'collab';
    const binPath = resolveDshBin();
    let proc;

    if (binPath) {
      proc = spawn(process.execPath, [binPath, '--profile', COLLAB_PROFILE, fullPrompt], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } else {
      proc = spawn('dsh.cmd', ['--profile', COLLAB_PROFILE, fullPrompt], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      process.stdout.write(chunk);
    });

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
      process.stderr.write(chunk);
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`DSH 执行超时（超过 ${timeoutSeconds} 秒）`));
    }, timeoutSeconds * 1000);

    proc.on('close', code => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const success = code === 0;

      const result = {
        taskId,
        taskTitle,
        success,
        exitCode: code,
        durationMs,
        result: stdout.trim(),
        reasoning: stderr.trim(),
        mode: 'headless-cli'
      };

      logTask({
        taskId,
        taskTitle,
        success,
        durationMs,
        exitCode: code
      });

      resolvePromise(result);
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 统一执行入口：优先直连桌面端活动会话，否则回退到独立 CLI 引擎
 */
export async function executeDshTask(params) {
  const { taskId, taskTitle, prompt, cwd = process.cwd(), timeoutSeconds = 300 } = params;

  // 记录到当前任务板
  if (!existsSync('.agent')) mkdirSync('.agent', { recursive: true });
  writeFileSync('.agent/CURRENT_TASK.md', `# 当前协同任务：${taskTitle}\n\n- **任务编号**: \`${taskId}\`\n- **下发时间**: ${new Date().toLocaleString()}\n\n## 任务需求\n\n${prompt}`, 'utf8');

  const backend = getDesktopBackendInfo();
  if (backend) {
    try {
      return await executeViaLiveDesktop({
        backend,
        taskId,
        taskTitle,
        prompt,
        cwd,
        timeoutSeconds
      });
    } catch (err) {
      console.warn(`[DSH Bridge] 直连桌面端会话遇到问题: ${err.message}，正在无缝切换到备用模式...`);
    }
  }

  return await executeViaHeadlessCli({
    taskId,
    taskTitle,
    prompt,
    cwd,
    timeoutSeconds
  });
}
