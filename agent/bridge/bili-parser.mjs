import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// 仓库根目录：本文件位于 <root>/.agent/bridge/，往上两级即 <root>。
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..');

/**
 * 自动从环境或安全配置文件加载 B 站登录态：
 * 优先级：process.env -> <root>/.agent/.env -> <root>/.env -> ~/.dsh/.env
 *
 * 注意：候选路径必须以「本模块位置」为锚，而不是 process.cwd()。
 * 否则从 bridge 子目录调用时会去找 <root>/.agent/bridge/.agent/.env，
 * 静默失配 -> 需要登录态的字幕轨直接判为不可用。
 */
function loadSessdata() {
  if (process.env.DSH_BILI_SESSDATA && process.env.DSH_BILI_SESSDATA.trim()) {
    return process.env.DSH_BILI_SESSDATA.trim();
  }
  const candidates = [
    path.join(REPO_ROOT, '.agent', '.env'),
    path.join(REPO_ROOT, '.env'),
    path.join(MODULE_DIR, '.agent', '.env'),
    path.join(MODULE_DIR, '.env'),
    path.join(os.homedir(), '.dsh', '.env')
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const text = fs.readFileSync(file, 'utf8');
        const m = text.match(/^DSH_BILI_SESSDATA=(.+)$/m);
        if (m && m[1].trim()) {
          return m[1].trim().replace(/^['"]|['"]$/g, '');
        }
      } catch {}
    }
  }
  return null;
}

function cookieHeader() {
  const sess = loadSessdata();
  return sess ? `SESSDATA=${sess}` : null;
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === 'https:' ? https : http;
    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com',
      ...headers
    };
    const cookie = cookieHeader();
    if (cookie) requestHeaders.Cookie = cookie;
    const req = client.get(url, {
      headers: requestHeaders
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(get(nextUrl, headers));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data, json: JSON.parse(data), finalUrl: url });
        } catch {
          resolve({ status: res.statusCode, data, json: null, finalUrl: url });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

function extractBvId(input) {
  if (typeof input !== 'string') return null;
  const m = input.match(/BV[0-9a-zA-Z]{10}/);
  return m ? m[0] : null;
}

// 锚定校验：判定「整条输入」是否为合法 BV 号 / B 站视频链接 / b23.tv 短链。
// extractBvId 必须保持宽容的全文搜索（解析重定向后的最终地址要用它），所以它不能
// 兼任安全边界 —— 否则 `x"; whoami; #BV...` 这类拼接串会被静默接受。
const BV_EXACT_RE = /^BV[0-9A-Za-z]{10}$/;
const BILI_VIDEO_EXACT_RE = /^https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/BV[0-9A-Za-z]{10}(?:[/?#]|$)/;
const B23_EXACT_RE = /^https?:\/\/(?:www\.)?b23\.tv\/[0-9A-Za-z]+(?:[/?#]|$)/;

function isAcceptableInput(s) {
  return BV_EXACT_RE.test(s) || BILI_VIDEO_EXACT_RE.test(s) || B23_EXACT_RE.test(s);
}

export async function parseBilibiliVideo(urlOrBv, options = {}) {
  let cleanInput = String(urlOrBv || '').trim().replace(/^['"\(<]+|['"\)>]+$/g, '');
  if (!isAcceptableInput(cleanInput)) {
    const preview = cleanInput.replace(/\s+/g, ' ').slice(0, 60);
    throw new Error(`输入不是合法的 BV 号或 B 站视频链接，已拒绝: ${preview}`);
  }
  let bvid = extractBvId(cleanInput);
  if (!bvid && cleanInput.includes('b23.tv')) {
    try {
      let targetUrl = cleanInput;
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
      }
      const res = await get(targetUrl);
      if (res.finalUrl) {
        bvid = extractBvId(res.finalUrl);
      }
    } catch {}
  }

  if (!bvid) {
    throw new Error(`无法从输入解析出有效 BV 号: ${urlOrBv}`);
  }

  // 1. 获取基本元数据
  const viewRes = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  if (viewRes.json?.code !== 0) {
    throw new Error(`获取视频信息失败: ${viewRes.json?.message || viewRes.status}`);
  }

  const vData = viewRes.json.data;
  const aid = vData.aid;
  const cid = vData.cid;
  const title = vData.title;
  const desc = vData.desc;
  const owner = vData.owner?.name;
  const duration = vData.duration;

  // 2. 尝试获取字幕
  let subtitleText = '';
  let subtitleReason = 'none';
  try {
    const playerRes = await get(`https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`);
    const subData = playerRes.json?.data;
    const subs = subData?.subtitle?.subtitles || [];
    if (subs.length > 0 && subs[0].subtitle_url) {
      const raw = subs[0].subtitle_url;
      const subUrl = raw.startsWith('//') ? `https:${raw}` : raw;
      const subRes = await get(subUrl);
      if (subRes.json?.body) {
        subtitleText = subRes.json.body.map(item => {
          const m = Math.floor(item.from / 60);
          const s = Math.floor(item.from % 60);
          const time = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
          return `[${time}] ${item.content}`;
        }).join('\n');
      }
    } else if (subData?.need_login_subtitle && !cookieHeader()) {
      subtitleReason = 'login-required';
    }  } catch {
    subtitleReason = 'fetch-failed';
  }
  if (subtitleText) subtitleReason = 'ok';

  // 3. 获取直接播放流地址 (360p/480p) - 仅在显式要求时拉取（如视觉多模态交付），避免浪费一次网络往返
  let videoStreamUrl = null;
  if (options.fetchStream) {
    try {
      const playRes = await get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=16&platform=html5`);
      if (playRes.json?.code === 0 && playRes.json.data?.durl?.length > 0) {
        videoStreamUrl = playRes.json.data.durl[0].url;
      }
    } catch {}
  }

  return {
    bvid,
    aid,
    cid,
    title,
    desc,
    owner,
    duration,
    hasSubtitles: !!subtitleText,
    subtitleText,
    subtitleReason,
    videoStreamUrl
  };
}

// 命令行直接测试
if (process.argv[1] && /[\\/]bili-parser\.mjs$/.test(process.argv[1])) {
  const target = process.argv[2] || 'BV1xx411c7mD';
  console.log(`[Bili Parser] 正在解析: ${target}...`);
  parseBilibiliVideo(target, { fetchStream: true }).then(res => {
    console.log({
      bvid: res.bvid,
      title: res.title,
      owner: res.owner,
      durationSeconds: res.duration,
      hasSubtitles: res.hasSubtitles,
      hasVideoStream: !!res.videoStreamUrl
    });
  }).catch(console.error);
}
