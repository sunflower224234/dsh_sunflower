// 单测：字幕抽样与时长格式化。不触网，纯函数级验证。
// 运行：node <<<协作桥目录>>>\bridge\test-bili-summary.mjs
import assert from 'node:assert/strict';
import { summarizeSubtitles, formatDuration } from './bili-summary.mjs';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  OK   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

// 造一条 600 行、每句可区分的假字幕（第 N 句）
const lines = [];
for (let i = 0; i < 600; i += 1) {
  const t = i * 3;
  const mm = String(Math.floor(t / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  lines.push(`[${mm}:${ss}] 第${i}句`);
}
const transcript = lines.join('\n');

console.log('summarizeSubtitles:');
check('空输入 -> 空结果', () => {
  const r = summarizeSubtitles('');
  assert.equal(r.summary, '');
  assert.deepEqual(r.keyTimestamps, []);
});

check('短字幕原样返回（不截断）', () => {
  const r = summarizeSubtitles('[00:00] 只有一句');
  assert.equal(r.summary, '只有一句');
});

check('长字幕不超预算', () => {
  const r = summarizeSubtitles(transcript, 260);
  assert.ok(r.summary.length <= 261, `实际长度 ${r.summary.length}`);
});

check('长字幕覆盖全片（样本句号横跨开头到结尾）', () => {
  const r = summarizeSubtitles(transcript, 260);
  const nums = [...r.summary.matchAll(/第(\d+)句/g)].map(m => Number(m[1]));
  assert.ok(nums.length >= 3, `样本句数仅 ${nums.length}`);
  assert.ok(Math.min(...nums) < 60, `最小句号 ${Math.min(...nums)}，应接近开头`);
  assert.ok(Math.max(...nums) > 540, `最大句号 ${Math.max(...nums)}，应接近结尾`);
});

check('时序抽样 5 条且首尾覆盖', () => {
  const r = summarizeSubtitles(transcript);
  assert.equal(r.keyTimestamps.length, 5);
  assert.ok(r.keyTimestamps[0].includes('第0句'), `首条=${r.keyTimestamps[0]}`);
  assert.ok(r.keyTimestamps[4].includes('第599句'), `末条=${r.keyTimestamps[4]}`);
});

console.log('formatDuration:');
check('0 秒', () => assert.equal(formatDuration(0), '0分00秒'));
check('65 秒', () => assert.equal(formatDuration(65), '1分05秒'));
check('2055 秒 = 34分15秒', () => assert.equal(formatDuration(2055), '34分15秒'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
