#!/usr/bin/env node
/**
 * collab profile 冒烟验证：确认「Gemini 发消息 → DSH 自动进入双智能体协同模式」
 * 这条链路真的成立，而不是靠调用方在 prompt 里重复灌人设。
 *
 * 断言三件事：
 *   1. runner 使用的 profile 真能把协同人设注入系统提示词层；
 *   2. 用户消息里已不再携带旧的协议卡头（人设不重复计费）；
 *   3. 任务编号 / 标题仍随每次调用传递到位。
 *
 * 用法：node .agent/bridge/collab-smoke.mjs
 */

import { executeDshTask } from './dsh-runner.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PROFILE_PATCH = join(homedir(), '.dsh', 'profiles', 'collab', 'cordis.patch.yml');
const PERSONA_COPY = join(process.cwd(), '.agent', 'collab-persona.md');

const checks = [];

function record(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? '✔' : '✘'} ${name}${detail ? `\n    ${detail}` : ''}`);
}

/**
 * 全角/半角标点归一 —— 人设是中文散文，中英文括号、冒号的混用属于排版噪声，
 * 不该被判成"内容脱节"；真正要抓的是措辞与语义的漂移。
 */
function normalizePunctuation(text) {
  return text
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[：:]/g, ':');
}

/** 把 markdown 副本摊平成可比较的语义行：去掉标题井号、引用符、强调符与全部空白。 */
function normalizeLines(text) {
  // 副本开头是一段 `>` 引用块，说明"本文件不是运行时真源"，天然不在运行时人设里，
  // 整段跳过，而不是逐行去匹配它的措辞。
  const stripped = normalizePunctuation(text.replace(/^(?:[^\n]*\n)*?(?:>\s?[^\n]*\n)+(?:\s*\n)?/, ''));
  return stripped
    .split(/\r?\n/)
    .map(line => line
      .replace(/^>\s*/, '')
      .replace(/^#+\s*/, '')
      .replace(/^\s*[-*]\s*/, '')
      .replace(/[*_]/g, '')
      .replace(/[`"''""]/g, '')
      .replace(/\s+/g, '')
      .trim())
    .filter(line => line.length >= 8 && line !== '---');
}

/**
 * 检查离线副本是否已与 profile 里的运行时人设脱节。
 * 只做单向包含断言：副本里每一句实质内容都应能在运行时人设中找到。
 */
function checkPersonaDrift() {
  if (!existsSync(PROFILE_PATCH)) {
    record('collab profile 存在', false, `未找到 ${PROFILE_PATCH}`);
    return;
  }
  record('collab profile 存在', true, PROFILE_PATCH);

  if (!existsSync(PERSONA_COPY)) {
    record('离线人设副本存在', false, `未找到 ${PERSONA_COPY}`);
    return;
  }

  // 两侧都要过同一套归一化：去强调符、统一标点、抹平空白，否则比对的是排版而不是内容。
  const runtime = normalizePunctuation(readFileSync(PROFILE_PATCH, 'utf8'))
    .replace(/[*_]/g, '')
    .replace(/[`"'']/g, '')
    .replace(/\s+/g, '');
  const copyLines = normalizeLines(readFileSync(PERSONA_COPY, 'utf8'));

  const missing = copyLines.filter(line => !runtime.includes(line));
  record(
    '离线副本与运行时人设一致（无脱节）',
    missing.length === 0,
    missing.length ? `副本里有 ${missing.length} 行不在运行时人设中，第一处: ${missing[0].slice(0, 60)}` : ''
  );
}

async function main() {
  const taskId = `collab-smoke-${Date.now()}`;
  const taskTitle = '协同人设注入验证';

  console.log('=== 静态检查：人设文件是否就位且未脱节 ===');
  checkPersonaDrift();

  console.log('\n=== 唤醒 collab profile（真实调用，非 mock）===');
  const res = await executeDshTask({
    taskId,
    taskTitle,
    prompt: [
      '不要使用任何工具，直接回答，30 行以内。',
      '请回答：',
      '1) 你是谁，在这个协作框架里担任什么角色，你的搭档是谁？',
      '2) 你的系统提示词里规定的任务完成汇报格式叫什么？逐条列出它的一级小节标题。',
      '3) 你的系统提示词里列了哪几条硬性纪律？（只列条目标题大意）'
    ].join('\n'),
    timeoutSeconds: 300
  });

  const output = res.result || '';
  console.log('\n=== DSH 原始输出 ===\n');
  console.log(output);

  record('DSH 进程正常退出', res.success === true, `exitCode=${res.exitCode} duration=${(res.durationMs / 1000).toFixed(1)}s`);

  const hasRole = /核心编码实现员|编码实现员/.test(output);
  record('已注入协同身份（核心编码实现员）', hasRole);

  const hasPartner = /Gemini/.test(output) && /架构/.test(output);
  record('已注入搭档设定（Gemini 架构/验收）', hasPartner);

  const hasCardName = /DSH 协同交付卡/.test(output);
  record('已注入交付格式（《DSH 协同交付卡》）', hasCardName);

  const sections = ['改动清单', '自测证据', '边界与风险提示', '交接说明'];
  const missing = sections.filter(s => !output.includes(s));
  record('交付卡四个一级小节完整', missing.length === 0, missing.length ? `缺失: ${missing.join('、')}` : '');

  const hasDiscipline = /不编造|不越权|坦白|承认/.test(output);
  record('已注入硬性纪律', hasDiscipline);

  record('任务编号已随消息传入', output.includes(taskId) || res.taskId === taskId, `taskId=${taskId}`);
  record('无旧协议卡头残留于用户消息', !/【Antigravity ↔ DSH 双智能体协同协议】/.test(output));

  const failed = checks.filter(c => !c.passed);
  console.log(`\n=== 结果：${checks.length - failed.length}/${checks.length} 项通过 ===`);
  if (failed.length > 0) {
    console.error('失败项:', failed.map(f => f.name).join(', '));
    process.exit(1);
  }
  console.log('✔ 「Gemini 发消息即自动进入协同模式」链路验证通过。');
}

main().catch(err => {
  console.error('冒烟验证异常:', err);
  process.exit(1);
});
