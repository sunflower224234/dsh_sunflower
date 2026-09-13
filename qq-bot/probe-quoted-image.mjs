/**
 * 验证：QQ 引用消息里，被引用的图片有没有可下载的 URL
 * ---------------------------------------------------------------------------
 * 背景：手机 QQ 无法同时发图+文字，群友会「先发图，再 @机器人 分析上图」。
 * 机器人要能分析，就必须能拿到【被引用消息】里的图片内容。
 *
 * dsh-im 的 qqReplyReference() 只从 msgElements[0].attachments 提取了
 * kind 和 name（丢掉了 url），所以先验证 SDK 层到底有没有 url 可用。
 *
 * 做法：直接调用 SDK 自己的 dispatchEvent，喂一个模拟的 GROUP_AT_MESSAGE_CREATE
 * 事件（message_type=103 引用类型），看它归一化后的输出结构。
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const SDK_DIST = '<<<DSH_HOME>>>/profiles/web/node_modules/@tencent-connect/qqbot-nodejs/dist';
const load = (rel) => import(pathToFileURL(join(SDK_DIST, rel)).href);

const { dispatchEvent } = await load('protocol/gateway/event-dispatcher.js');

/** 构造一个「引用了一张图」的群消息事件（字段名取自 SDK 的读取逻辑） */
const event = {
  id: 'ROBOT1.0_MSG_ID_SAMPLE',
  content: ' 分析一下上面这张图',
  timestamp: '2026-09-14T01:00:00+08:00',
  group_openid: '9A913A17AE50FF26B52E76DE6648D5A3',
  author: {
    member_openid: '9C1A2B3D4E5F60718293A4B5C6D7E8F9',
    username: '好犬儿',
    bot: false,
  },
  // message_type 103 = 引用消息（SDK 的 parseRefIndices 用这个判定）
  message_type: 103,
  // 引用信息：ref_msg_idx 指向被引用消息
  message_scene: {
    ext: ['ref_msg_idx=REF_MSG_INDEX_001', 'msg_idx=MSG_INDEX_001'],
  },
  msg_elements: [
    {
      msg_idx: 'REF_MSG_INDEX_001',
      content: '',
      // 关键：被引用消息的附件里有没有 url？
      attachments: [
        {
          content_type: 'image/png',
          filename: 'quoted-image.png',
          size: 123456,
          url: 'https://multimedia.nt.qq.com.cn/download?appid=xxx&fileid=yyy&rkey=zzz',
          width: 650,
          height: 680,
        },
      ],
    },
  ],
  mentions: [{ id: 'BOT_OPENID', bot: true }],
};

console.log('=== 用 SDK 的 dispatchEvent 解析模拟引用消息 ===\n');

const result = dispatchEvent('GROUP_AT_MESSAGE_CREATE', event, 'account', null);

console.log('action:', result?.action);
const msg = result?.msg;
if (!msg) {
  console.log('未返回 msg：', JSON.stringify(result).slice(0, 400));
  process.exit(0);
}

console.log('\n--- 归一化后的 msg 字段 ---');
for (const k of Object.keys(msg)) {
  const v = msg[k];
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  console.log(`  ${k.padEnd(16)} : ${String(s).slice(0, 150)}`);
}

console.log('\n--- 关键检查 ---');
console.log(`  refMsgIdx        : ${msg.refMsgIdx ?? '(无)'}`);
console.log(`  msgElements 数量 : ${Array.isArray(msg.msgElements) ? msg.msgElements.length : '(无)'}`);

const el = Array.isArray(msg.msgElements) ? msg.msgElements[0] : null;
if (el) {
  console.log(`  msgElements[0] 键: ${Object.keys(el).join(', ')}`);
  const atts = Array.isArray(el.attachments) ? el.attachments : [];
  console.log(`  被引用消息附件数 : ${atts.length}`);
  for (const [i, a] of atts.entries()) {
    console.log(`\n  [附件 ${i}] 字段: ${Object.keys(a).join(', ')}`);
    console.log(`    content_type : ${a.content_type ?? '(无)'}`);
    console.log(`    filename     : ${a.filename ?? '(无)'}`);
    console.log(`    size         : ${a.size ?? '(无)'}`);
    console.log(`    ★ url        : ${a.url ?? '(无！)'}`);
  }
}

console.log('\n--- 结论 ---');
const att = el?.attachments?.[0];
if (att?.url) {
  console.log('✅ 被引用图片【有】可下载 url → 可以打补丁让它进入 images，agent 就能读图');
  console.log('   需要改：qqReplyReference / qqInboundMessage，把 url 也带上并暴露 load()');
} else {
  console.log('❌ 被引用图片没有 url → SDK/平台没提供，只能另想办法（如 msgIdx 拉历史）');
}
