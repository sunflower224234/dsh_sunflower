#!/usr/bin/env node
/**
 * 银狼语音生成 · 给 agent 用的调用入口
 * ---------------------------------------------------------------------------
 * 拿 text 调本地 GPT-SoVITS，产出一个 wav，把【绝对路径】打到 stdout。
 * agent 拿到路径后调 dsh_im_return_file，插件就会把它当语音条发出去
 * （已打补丁：audio/* 走 QQ sendVoice）。
 *
 * ⚠ 音色取决于 :9880 上跑的是哪个配置，而不是这个脚本。
 *   默认 tts_infer.yaml = 原版预训练音色；银狼音色要跑：
 *       <<<GPT-SoVITS目录>>>\start-silverwolf-tts.ps1
 *   （该配置指向 GPT_weights_v2/silverwolf_v2-e15.ckpt +
 *     SoVITS_weights_v2/silverwolf_v2_e8_s200.pth）
 *
 * 用法：
 *   node silverwolf-tts.mjs "要说的话"
 *   node silverwolf-tts.mjs "要说的话" --speed 1.1
 *   node silverwolf-tts.mjs "要说的话" --out F:\somewhere\a.wav
 *   node silverwolf-tts.mjs --probe          # 只探测服务当前状态
 *
 * stdout 只打路径（便于 agent 直接取用）；诊断信息走 stderr。
 */

import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argv, exit } from 'node:process';

const TTS_ROOT = '<<<GPT-SoVITS目录>>>';
const ENDPOINT = 'http://127.0.0.1:9880/tts';
const OUT_DIR = '<<<插件目录>>>/out';

/** 参考音频与它的原始转录（转录取自 train/silverwolf/dataset/labels.list 第 22 行）*/
const REF_AUDIO = join(TTS_ROOT, 'reference-银狼.wav');
const PROMPT_TEXT = '这么快就上钩了好像有点棘手。';

// ------------------------------------------------------------------ 参数解析

function parseArgs(list) {
  const opts = { text: null, speed: 1.0, out: null, probe: false };
  const rest = [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '--probe') opts.probe = true;
    else if (arg === '--speed') opts.speed = Number(list[++i]);
    else if (arg === '--out') opts.out = list[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else rest.push(arg);
  }
  if (rest.length > 0) opts.text = rest.join(' ');
  return opts;
}

const opts = parseArgs(argv.slice(2));

if (opts.help) {
  console.error(`用法: node silverwolf-tts.mjs "要说的话" [--speed 1.0] [--out 路径]
       node silverwolf-tts.mjs --probe`);
  exit(0);
}

const warn = (msg) => console.error(`[银狼TTS] ${msg}`);

// ------------------------------------------------------------------ 服务探测

/** @returns {Promise<{ok: boolean, note: string}>} */
async function probeService() {
  try {
    const res = await fetch('http://127.0.0.1:9880/docs', {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, note: `HTTP ${res.status}` };
    return { ok: true, note: 'ok' };
  } catch (error) {
    return { ok: false, note: error?.cause?.code ?? error?.name ?? String(error) };
  }
}

const service = await probeService();

if (opts.probe) {
  console.log(JSON.stringify({
    listening: service.ok,
    detail: service.note,
    endpoint: ENDPOINT,
    refAudio: REF_AUDIO,
    refAudioExists: existsSync(REF_AUDIO),
    promptText: PROMPT_TEXT,
    note: service.ok
      ? '服务在跑；音色取决于它启动时的 -c 配置（用 tts_infer.yaml 则是原版音色）'
      : '服务没起来，先跑 start-silverwolf-tts.ps1',
  }, null, 2));
  exit(service.ok ? 0 : 1);
}

if (!service.ok) {
  warn(`TTS 服务不可达（${service.note}）：${ENDPOINT}`);
  warn('先启动：powershell -File F:\\AI\\GPT-SoVITS\\start-silverwolf-tts.ps1');
  exit(2);
}

if (!opts.text || !opts.text.trim()) {
  warn('缺少要合成的文本。用法: node silverwolf-tts.mjs "要说的话"');
  exit(2);
}

if (!existsSync(REF_AUDIO)) {
  warn(`参考音频不存在：${REF_AUDIO}`);
  exit(2);
}

// ------------------------------------------------------------------ 合成

const outputPath = resolve(
  opts.out ?? join(OUT_DIR, `silverwolf-${Date.now()}.wav`),
);

const body = {
  text: opts.text,
  text_lang: 'zh',
  ref_audio_path: REF_AUDIO,
  prompt_text: PROMPT_TEXT,
  prompt_lang: 'zh',
  text_split_method: 'cut5',
  batch_size: 1,
  parallel_infer: false,
  streaming_mode: false,
  media_type: 'wav',
  speed_factor: Number.isFinite(opts.speed) && opts.speed > 0 ? opts.speed : 1.0,
};

warn(`合成中（${opts.text.length} 字，速度 ${body.speed_factor}）...`);

let response;
try {
  response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
} catch (error) {
  warn(`请求失败：${error?.cause?.code ?? error?.message ?? error}`);
  exit(3);
}

if (!response.ok) {
  const detail = await response.text().catch(() => '');
  warn(`服务返回 HTTP ${response.status}：${detail.slice(0, 400)}`);
  exit(3);
}

const audio = Buffer.from(await response.arrayBuffer());

// GPT-SoVITS 出错时偶尔会回一个 JSON 而不是音频，这里挡一下
const head = audio.subarray(0, 4).toString('ascii');
if (head !== 'RIFF') {
  warn(`返回内容不是 WAV（头是 "${head}"），前 300 字节：`);
  warn(audio.subarray(0, 300).toString('utf8'));
  exit(3);
}

mkdirSync(join(outputPath, '..'), { recursive: true });
writeFileSync(outputPath, audio);

const size = statSync(outputPath).size;
warn(`完成：${(size / 1024).toFixed(1)} KB`);

// stdout 只留路径，方便 agent 直接拿
console.log(outputPath);
