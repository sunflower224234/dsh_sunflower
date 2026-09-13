/**
 * 通过 DSH 桌面端 RPC 查询会话状态（只读）
 * 复用 dsh-runner.mjs 的取 cookie 机制。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APPDATA = process.env.APPDATA ?? '';

function backend() {
  const f = join(APPDATA, 'dsh-desktop', 'backend.json');
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8'));
}

function fetchCookie(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get(url, { headers: { Host: u.host, Origin: u.origin } }, (res) => {
      const sc = res.headers['set-cookie'];
      if (!sc?.length) return reject(new Error('no set-cookie'));
      resolve(sc[0].split(';')[0]);
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function rpc(origin, cookie, method, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload });
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request(`${origin}/api/${method}`, {
      method: 'POST',
      headers: {
        Host: u.host, Origin: u.origin,
        'Content-Type': 'application/json', Cookie: cookie,
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(d);
          if (p.result?.ok === false) reject(new Error(p.result.error?.message ?? 'rpc failed'));
          else resolve(p.result?.value);
        } catch { reject(new Error(`invalid: ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('rpc timeout')); });
    req.write(body);
    req.end();
  });
}

const b = backend();
if (!b) { console.error('找不到 backend.json'); process.exit(1); }
console.log(`后端: ${b.origin}  pid=${b.pid}`);

const cookie = await fetchCookie(b.url);
console.log('已取得授权 cookie\n');

const list = await rpc(b.origin, cookie, 'session/list', { args: { _request: {} } });
const items = list?.items ?? [];
console.log(`会话总数: ${items.length}\n`);

const GROUP = 'session-2a883e5d-a50f-49f5-b386-071cda4e607e';

for (const s of items) {
  const id = s.sessionId;
  const title = s.projections?.values?.title ?? '';
  const mark = id === GROUP ? '  ★ 群会话' : '';
  if (id === GROUP || title.includes('QQ')) {
    console.log(`--- ${id}${mark}`);
    console.log(`    标题: ${title}`);
    console.log(`    cwd : ${s.projections?.values?.cwd ?? s.header?.cwd ?? '?'}`);
    const perms = s.projections?.values?.permissions;
    if (perms) console.log(`    权限: ${JSON.stringify(perms)}`);
    const agentPreset = s.projections?.values?.agentPreset;
    if (agentPreset) console.log(`    preset: ${agentPreset}`);
  }
}

console.log('\n=== 群会话完整投影（找投递/错误信息）===');
const target = items.find((s) => s.sessionId === GROUP);
if (!target) {
  console.log('未找到群会话');
} else {
  const vals = target.projections?.values ?? {};
  for (const [k, v] of Object.entries(vals)) {
    let str = JSON.stringify(v);
    if (str.length > 700) str = str.slice(0, 700) + '…';
    console.log(`\n[${k}]`);
    console.log(`  ${str}`);
  }
}
