#!/usr/bin/env node
/**
 * 验证 dsh-collab 技能在两处技能库中的固化结果。
 * 复刻 @deepseek-ai/dsh-skill-filesystem 的解析规则做断言：
 *   - 文件落在 DSH 真实扫描的根目录下（目录包形态 <name>/SKILL.md）
 *   - frontmatter 含 name + description，且 name 匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/
 * 用法: node verify-skill-fixation.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join as pjoin } from 'node:path';
import { pathToFileURL } from 'node:url';

// 复用 DSH 自己那份 yaml 解析器，保证"我这里能过" == "DSH 那边能过"
const DSH_MODULES = pjoin(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules');
const requireFromDsh = createRequire(pathToFileURL(pjoin(DSH_MODULES, 'noop.js')).href);
const parseYaml = requireFromDsh('yaml').parse;

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const targets = [
  { label: '全局用户技能库 (user-dsh)', root: join(homedir(), '.dsh', 'skills') },
  { label: '项目技能库 (project-dsh)', root: 'F:\\MyCode\\.dsh\\skills' }
];

const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `\n    ${detail}` : ''}`);
};

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  return { data: parseYaml(m[1]), body: raw.slice(m[0].length) };
}

for (const t of targets) {
  console.log(`\n=== ${t.label} ===`);
  const dir = join(t.root, 'dsh-collab');
  const file = join(dir, 'SKILL.md');

  record(`目录包存在: ${dir}`, existsSync(dir));
  if (!existsSync(file)) {
    record(`SKILL.md 存在: ${file}`, false, '文件缺失');
    continue;
  }
  record(`SKILL.md 存在: ${file}`, true, `${statSync(file).size} 字节`);

  const raw = readFileSync(file, 'utf8');
  const fm = parseFrontmatter(raw);
  record('YAML frontmatter 可解析', fm !== null);
  if (!fm) continue;

  const name = fm.data?.name;
  const desc = fm.data?.description;
  record(`frontmatter.name = "${name}"`, name === 'dsh-collab');
  record('frontmatter.name 符合 DSH 命名规则', typeof name === 'string' && SKILL_NAME.test(name));
  record('frontmatter.description 非空', typeof desc === 'string' && desc.length > 20,
    typeof desc === 'string' ? `${desc.length} 字符` : '缺失');
  record('frontmatter.whenToUse 存在', typeof fm.data?.whenToUse === 'string');

  // 正文关键断言：协同职责必须真的写在技能里，而不是只留个空壳
  const body = fm.body;
  const required = [
    '核心编码实现员', '架构与验收总监',
    '## DSH 协同交付卡',
    '### 1. 改动清单', '### 2. 自测证据', '### 3. 边界与风险提示', '### 4. 交接说明',
    '不编造证据', '不越权', '失败要坦白'
  ];
  const missing = required.filter(s => !body.includes(s));
  record('正文包含职责/格式/纪律全部关键段', missing.length === 0,
    missing.length ? `缺失: ${missing.join('、')}` : `${required.length} 项关键段全部命中`);
}

const failed = checks.filter(c => !c.ok);
console.log(`\n=== 结果：${checks.length - failed.length}/${checks.length} 项通过 ===`);
if (failed.length) {
  console.error('失败项:', failed.map(f => f.name).join(' | '));
  process.exit(1);
}
console.log('✔ dsh-collab 技能已在两处技能库完成固化。');
