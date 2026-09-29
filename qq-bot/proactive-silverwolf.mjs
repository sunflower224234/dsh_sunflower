import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run every 30 minutes. The state file makes a successful send occur at most once per day.
const here = dirname(fileURLToPath(import.meta.url));
const stateFile = join(here, 'proactive-silverwolf-state.json');
const workspaceFile = join(process.env.USERPROFILE || 'C:/Users/35756', '.dsh/integrations/dsh-qq/workspaces.json');
const lines = [
  '刚打完一把，队友把大招交给空气了。你们最近都在玩什么？',
  '今天手感怪好，差点以为键盘偷偷升级了。你们今天运气怎么样？',
  '挂机刷东西刷到怀疑人生。谁有好玩的游戏，丢一个来。',
  '刚看到一个离谱配队，居然还真打过了。你们有过这种歪打正着的时候吗？',
  '我的气泡水都喝完了，这破关还没过。你们今晚在忙什么？',
  '刚才排到个嘴硬的队友，最后输出还没我一半。你们遇过更离谱的吗？',
  '今天想换个游戏打，结果在库里挑了半天。你们最近上头的是哪个？',
  '刚把一局打顺，下一局就被机制教育了。行吧，今晚继续。',
  '你们抽卡前真的会搞仪式吗？我看有人连站位都要讲究。',
  '刚修好一个小毛病，键盘敲起来终于顺耳了。嗯，心情加一分。',
  '今晚本来只想打一把，结果又停不下来了。你们也这样？',
  '群里这么安静，是都在偷偷刷本，还是又集体被 Boss 打自闭了？',
  '刚刷到一段游戏配乐，脑子里循环半小时了。你们最近有什么单曲循环？',
  '今天不想卷排行榜，想找个能随便逛逛的游戏。谁有推荐？',
];

function localDay(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function dayHash(day) {
  let hash = 2166136261;
  for (const char of day) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash;
}

function loadTarget() {
  const data = JSON.parse(readFileSync(workspaceFile, 'utf8'));
  const targets = Object.entries(data.deliveryTargets || {}).flatMap(([botId, entries]) =>
    Object.entries(entries).filter(([, entry]) => entry.kind === 'group').map(([targetId]) => ({ botId, targetId })));
  if (targets.length !== 1) throw new Error(`Expected exactly one QQ group delivery target, found ${targets.length}`);
  return targets[0];
}

async function main() {
  const now = new Date();
  const day = localDay(now);
  const hash = dayHash(day);
  const text = lines[hash % lines.length];
  const scheduledMinutes = 18 * 60 + (hash >>> 8) % 180;
  const preview = process.argv.includes('--preview');
  if (preview) { console.log(JSON.stringify({ day, text, afterLocalTime: `${String(Math.floor(scheduledMinutes / 60)).padStart(2, '0')}:${String(scheduledMinutes % 60).padStart(2, '0')}`, target: loadTarget() }, null, 2)); return; }
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  if (minuteOfDay < scheduledMinutes || minuteOfDay >= 22 * 60) return;
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  if (state.lastSentDay === day) return;
  const { botId, targetId } = loadTarget();
  const origin = process.env.DSH_IM_ORIGIN || 'http://127.0.0.1:3080';
  const response = await fetch(`${origin}/api/dsh-im/delivery/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botId, targetId, text }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.sent !== true) throw new Error(`Delivery failed: ${response.status} ${result.error?.code || ''}`);
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ lastSentDay: day, lastText: text, sentAt: now.toISOString() }, null, 2));
  console.log(`Sent proactive group message for ${day}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
