import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.resolve(process.cwd(), '.agent/.env');

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com',
        ...headers
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        }
      });
    }).on('error', reject);
  });
}

export async function verifySessdata(sessdata) {
  const clean = String(sessdata || '').trim().replace(/^['"]|['"]$/g, '');
  const res = await get('https://api.bilibili.com/x/web-interface/nav', {
    Cookie: `SESSDATA=${clean}`
  });
  if (res.json?.code === 0 && res.json.data?.isLogin) {
    return { ok: true, uname: res.json.data.uname, mid: res.json.data.mid };
  }
  return { ok: false, message: res.json?.message || '凭据无效或已过期' };
}

export function saveSessdata(sessdata) {
  const clean = String(sessdata || '').trim().replace(/^['"]|['"]$/g, '');
  const dir = path.dirname(ENV_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let existing = '';
  if (fs.existsSync(ENV_PATH)) {
    existing = fs.readFileSync(ENV_PATH, 'utf8');
  }

  const lines = existing.split('\n').filter(l => !l.startsWith('DSH_BILI_SESSDATA='));
  lines.push(`DSH_BILI_SESSDATA=${clean}`);
  fs.writeFileSync(ENV_PATH, lines.filter(Boolean).join('\n') + '\n', 'utf8');
  console.log(`✅ SESSDATA 已安全保存至: ${ENV_PATH}`);
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--set' && process.argv[3]) {
    const val = process.argv[3];
    console.log('正在验证 SESSDATA 凭据有效性...');
    const v = await verifySessdata(val);
    if (v.ok) {
      console.log(`🎉 验证成功！登录账号: ${v.uname} (UID: ${v.mid})`);
      saveSessdata(val);
    } else {
      console.error(`❌ 凭据验证失败: ${v.message}`);
      process.exit(1);
    }
    return;
  }

  if (arg === '--check') {
    if (!fs.existsSync(ENV_PATH)) {
      console.log('❌ 未找到 .agent/.env 文件');
      return;
    }
    const text = fs.readFileSync(ENV_PATH, 'utf8');
    const m = text.match(/^DSH_BILI_SESSDATA=(.+)$/m);
    if (!m) {
      console.log('❌ .agent/.env 中未配置 DSH_BILI_SESSDATA');
      return;
    }
    console.log('正在检查当前配置的 SESSDATA...');
    const v = await verifySessdata(m[1].trim());
    if (v.ok) {
      console.log(`✅ 当前凭据正常！账号: ${v.uname} (UID: ${v.mid})`);
    } else {
      console.log(`⚠️ 凭据已失效: ${v.message}`);
    }
    return;
  }

  console.log('用法:');
  console.log('  node bili-auth.mjs --set <SESSDATA>');
  console.log('  node bili-auth.mjs --check');
}

if (process.argv[1] && /[\\/]bili-auth\.mjs$/.test(process.argv[1])) main();
