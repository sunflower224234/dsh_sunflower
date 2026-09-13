import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { parseBilibiliVideo } from './bili-parser.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// 缓存 / 任务队列一律锚定仓库根，避免依赖调用时的 cwd。
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..');
const AGENT_DIR = path.join(REPO_ROOT, '.agent');
const CACHE_DIR = path.join(AGENT_DIR, 'cache');
const INBOX_DIR = path.join(AGENT_DIR, 'inbox');
const RESULTS_DIR = path.join(INBOX_DIR, 'results');

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}分${s.toString().padStart(2, '0')}秒`;
}

function getVisualSummaryFromCache(bvid) {
  try {
    const cacheFile = path.join(CACHE_DIR, 'visual-summaries.json');
    if (fs.existsSync(cacheFile)) {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (data[bvid]?.visualSummary) {
        return data[bvid].visualSummary;
      }
    }
  } catch {}
  return null;
}

function saveVisualSummaryToCache(bvid, title, summary) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const cacheFile = path.join(CACHE_DIR, 'visual-summaries.json');
    let data = {};
    if (fs.existsSync(cacheFile)) {
      try { data = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
    }
    data[bvid] = { bvid, title, visualSummary: summary, analyzedAt: new Date().toISOString() };
    fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

async function downloadVideoStream(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com' }
    }, res => {
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed with status ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(destPath);
      });
    });
    req.on('error', err => {
      file.close();
      reject(err);
    });
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

async function requestVisualAnalysis(video) {
  const cached = getVisualSummaryFromCache(video.bvid);
  if (cached) return cached;

  if (video.duration > 600) return null;

  let videoFile = null;
  try {
    const streamInfo = await parseBilibiliVideo(video.bvid, { fetchStream: true });
    if (!streamInfo.videoStreamUrl) return null;

    const cacheDir = path.join(AGENT_DIR, 'cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    videoFile = path.join(cacheDir, `${video.bvid}.mp4`);

    if (!fs.existsSync(videoFile)) {
      await downloadVideoStream(streamInfo.videoStreamUrl, videoFile);
    }

    const inboxDir = path.join(AGENT_DIR, 'inbox');
    const resultsDir = path.join(inboxDir, 'results');
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

    const taskId = `visual-${video.bvid}-${Date.now()}`;
    const taskPayload = {
      id: taskId,
      bvid: video.bvid,
      title: video.title,
      videoPath: path.resolve(videoFile),
      prompt: `请阅读该视频画面，提取核心画面内容、人物操作与亮点，不超过200字。`,
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(inboxDir, `${taskId}.json`), JSON.stringify(taskPayload, null, 2), 'utf8');

    const resultFile = path.join(resultsDir, `${taskId}.json`);
    const start = Date.now();
    while (Date.now() - start < 12000) {
      if (fs.existsSync(resultFile)) {
        try {
          const res = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
          if (res.summary) {
            saveVisualSummaryToCache(video.bvid, video.title, res.summary);
            return res.summary;
          }
        } catch {}
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch {} finally {
    // 看完即焚：自动清理临时下载的 mp4 视频文件，彻底不留磁盘痕迹
    if (videoFile && fs.existsSync(videoFile)) {
      try { fs.unlinkSync(videoFile); } catch {}
    }
  }

  return null;
}

/**
 * 从字幕轨里机械抽样覆盖全片
 */
function summarizeSubtitles(subtitleText, budget = 260) {
  const lines = subtitleText.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { summary: '', keyTimestamps: [] };

  const stripped = lines.map(l => l.replace(/^\[\d+:\d+\]\s*/, ''));

  const keyTimestamps = [];
  const slots = Math.min(5, lines.length);
  for (let i = 0; i < slots; i++) {
    const idx = slots === 1 ? 0 : Math.round((i * (lines.length - 1)) / (slots - 1));
    const line = lines[idx];
    if (!keyTimestamps.includes(line)) keyTimestamps.push(line);
  }

  const fullText = stripped.join(' ');
  if (fullText.length <= budget) return { summary: fullText, keyTimestamps };

  const avgLen = Math.max(1, Math.floor(fullText.length / stripped.length));
  let n = Math.max(3, Math.min(stripped.length, Math.floor(budget / avgLen)));
  let picked = [];
  while (n >= 3) {
    picked = [];
    for (let i = 0; i < n; i++) {
      const idx = Math.round((i * (stripped.length - 1)) / (n - 1));
      if (!picked.includes(stripped[idx])) picked.push(stripped[idx]);
    }
    if (picked.join(' ').length <= budget) break;
    n -= 1;
  }

  let summary = picked.join(' ');
  if (summary.length > budget) summary = summary.slice(0, budget) + '…';
  return { summary, keyTimestamps };
}

export { summarizeSubtitles, formatDuration };

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.log('用法: node bili-summary.mjs <BV号或B站URL>');
    process.exit(1);
  }

  try {
    const video = await parseBilibiliVideo(input);

    console.log(`🎬 视频：${video.title}`);
    console.log(`👤 UP主：${video.owner} | ⏱️ 时长：${formatDuration(video.duration)}`);
    console.log(`🔗 BV号：${video.bvid}`);
    console.log(`──────────────────────────────────────────`);

    if (video.hasSubtitles && video.subtitleText) {
      const { summary, keyTimestamps } = summarizeSubtitles(video.subtitleText);
      console.log(`📌【字幕内容抽样】：`);
      console.log(summary || '（未能提取到有效文字）');
      console.log(``);
      if (keyTimestamps.length > 0) {
        console.log(`⏱️【精彩时序节点】：`);
        for (const t of keyTimestamps) {
          console.log(`  ${t}`);
        }
      }
    } else {
      const visual = await requestVisualAnalysis(video);
      if (visual) {
        console.log(`📌【画面视觉核心】：`);
        console.log(visual);
        console.log(``);
        console.log(`💡【字幕状态】：该视频无字幕轨，内容由多模态视觉总线解析画面。`);
      } else {
        console.log(`📌【视频简介说明】：`);
        const cleanDesc = (video.desc || 'UP主没有留下简介').trim().replace(/\n+/g, ' ');
        console.log(cleanDesc.length > 200 ? cleanDesc.slice(0, 200) + '...' : cleanDesc);
        console.log(``);
        console.log(`💡【字幕状态】：该视频未检测到字幕轨（纯画面/无声操作/纯音乐）。`);
      }
    }
  } catch (err) {
    console.error(`❌ 解析失败: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && /[\\/]bili-summary\.mjs$/.test(process.argv[1])) main();

