/**
 * QQ 群聊语音能力探测（不发消息）
 * ---------------------------------------------------------------------------
 * 与 probe-voice.mjs 的区别：这个只做【上传】，不发送。
 * 目的是验证群聊路径的富媒体上传是否可用：
 *   c2c   → /v2/users/{user_openid}/files
 *   group → /v2/groups/{group_openid}/files   ← 用户实际场景，此前未验证
 *
 * 上传成功只消耗一次上传额度，不会在群里留下任何消息。
 *
 * 用法：node probe-group-voice.mjs <group_openid> [音频路径]
 */

import { readFileSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const SDK_DIST = '<<<DSH_HOME>>>/profiles/web/node_modules/@tencent-connect/qqbot-nodejs/dist';
const loadSdkModule = (relative) => import(pathToFileURL(join(SDK_DIST, relative)).href);

const { MediaFileType } = await loadSdkModule('protocol/types.js');
const { TokenManager } = await loadSdkModule('protocol/api/token.js');
const { ApiClient } = await loadSdkModule('protocol/api/api-client.js');
const { MediaApi } = await loadSdkModule('protocol/api/media.js');

const APP_ID = process.env.DSH_QQ_APP_ID ?? '<<<你的appId>>>';
const SECRET_KEY = 'DSH_QQ_APP_SECRET';

const groupOpenid = process.argv[2];
const audioPath = process.argv[3] ?? '<<<插件目录>>>/out/silverwolf-REAL.wav';

if (!groupOpenid) {
  console.error('用法: node probe-group-voice.mjs <group_openid> [音频路径]');
  process.exit(2);
}

function readSecret() {
  const line = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trimStart().startsWith(`${SECRET_KEY}:`));
  if (!line) throw new Error('凭据里找不到 app secret');
  const value = line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '');
  if (!value) throw new Error('凭据值为空');
  return value;
}

const logger = {
  info: (m) => console.log(`  [sdk] ${m}`),
  error: (m) => console.log(`  [sdk:error] ${m}`),
  warn: (m) => console.log(`  [sdk:warn] ${m}`),
  debug: () => {},
};

const secret = readSecret();
const bytes = readFileSync(audioPath);

console.log('=== QQ 群聊语音上传探测（不发送消息）===\n');
console.log(`scope     : group`);
console.log(`group     : ${groupOpenid}`);
console.log(`音频      : ${basename(audioPath)} (${(bytes.length / 1024).toFixed(1)} KB)\n`);

const tokenManager = new TokenManager({ logger });
const client = new ApiClient({ logger });
const mediaApi = new MediaApi(client, tokenManager, { logger });

const token = await tokenManager.getAccessToken(APP_ID, secret);
console.log(`[1/2] token OK（${token.length} 字符，不打印）\n`);

console.log('[2/2] 以 file_type=3 上传到【群聊】端点 ...');
try {
  const upload = await mediaApi.uploadMedia('group', groupOpenid, MediaFileType.VOICE, {
    appId: APP_ID,
    clientSecret: secret,
  }, {
    buffer: bytes,
    srvSendMsg: false,   // false = 仅上传，绝不发送
    fileName: basename(audioPath),
  });
  console.log(`      ✅ 群聊上传成功`);
  console.log(`      file_uuid = ${upload.file_uuid}`);
  console.log(`      file_info = ${String(upload.file_info).slice(0, 24)}... (${String(upload.file_info).length} chars)`);
  console.log(`      ttl       = ${upload.ttl}s\n`);
  console.log('结论：群聊富媒体上传路径可用，sendVoice 在群聊场景应能工作。');
  console.log('（本次未发送任何群消息）');
} catch (error) {
  console.error('\n❌ 群聊上传失败\n');
  console.error(`  name    : ${error?.name}`);
  console.error(`  message : ${error?.message}`);
  if (error?.httpStatus !== undefined) console.error(`  httpStatus: ${error.httpStatus}`);
  if (error?.bizCode !== undefined) console.error(`  bizCode : ${error.bizCode}`);
  if (error?.bizMessage) console.error(`  bizMessage: ${error.bizMessage}`);
  if (error?.path) console.error(`  path    : ${error.path}`);
  process.exit(1);
}
