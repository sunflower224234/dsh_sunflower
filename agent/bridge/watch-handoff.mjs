import fs from 'node:fs';
import path from 'node:path';

const inboxDir = path.resolve('.agent/inbox');
if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });

const timeoutSeconds = parseInt(process.argv[2] || '300', 10);
const startTime = Date.now();

function checkForTasks() {
  if (!fs.existsSync(inboxDir)) return null;
  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  if (files.length > 0) {
    const target = path.join(inboxDir, files[0]);
    try {
      const content = fs.readFileSync(target, 'utf8');
      const data = JSON.parse(content);
      // 读完后将其移入已接收状态，防止重复处理
      const processingDir = path.join(inboxDir, 'processing');
      if (!fs.existsSync(processingDir)) fs.mkdirSync(processingDir, { recursive: true });
      fs.renameSync(target, path.join(processingDir, files[0]));
      return data;
    } catch {
      return null;
    }
  }
  return null;
}

// 先查一次现有任务
const immediate = checkForTasks();
if (immediate) {
  console.log('__GEMINI_HANDOFF_TASK__');
  console.log(JSON.stringify(immediate));
  process.exit(0);
}

// 轮询守候
const interval = setInterval(() => {
  const task = checkForTasks();
  if (task) {
    clearInterval(interval);
    console.log('__GEMINI_HANDOFF_TASK__');
    console.log(JSON.stringify(task));
    process.exit(0);
  }

  if (Date.now() - startTime > timeoutSeconds * 1000) {
    clearInterval(interval);
    console.log('__GEMINI_HANDOFF_TIMEOUT__');
    process.exit(0);
  }
}, 500);
