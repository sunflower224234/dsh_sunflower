import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function getArg(key, defaultValue = null) {
  const idx = args.indexOf(key);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultValue;
}

const videoPath = getArg('--video');
const prompt = getArg('--prompt', '请详细分析该视频的内容、操作步骤与关键时间戳');
const taskId = getArg('--id', `handoff-${Date.now()}`);

if (!videoPath) {
  console.error('错误: 请通过 --video 指定视频文件路径');
  process.exit(1);
}

const inboxDir = path.resolve('.agent/inbox');
if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });

const payload = {
  id: taskId,
  videoPath: path.resolve(videoPath),
  prompt,
  createdAt: new Date().toISOString(),
  status: 'pending'
};

const taskFile = path.join(inboxDir, `${taskId}.json`);
fs.writeFileSync(taskFile, JSON.stringify(payload, null, 2), 'utf8');

console.log(`[Handoff Bus] 多模态视频任务已提交至 Gemini 信箱: ${taskId}`);
console.log(`[Handoff Bus] 目标文件: ${videoPath}`);
console.log(`[Handoff Bus] 协同总线已通知 Gemini 架构师自动接单阅片...`);
