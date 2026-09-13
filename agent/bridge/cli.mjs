#!/usr/bin/env node
import { createSnapshot, generateAudit, rollback } from './safety-guard.mjs';
import { executeDshTask } from './dsh-runner.mjs';

const args = process.argv.slice(2);
const command = args[0];

function getArg(key, defaultValue = null) {
  const idx = args.indexOf(key);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return defaultValue;
}

async function main() {
  if (command === 'run') {
    const taskId = getArg('--id', `task-${Date.now()}`);
    const taskTitle = getArg('--title', '未命名协同任务');
    const prompt = getArg('--prompt', '');
    const targetsStr = getArg('--targets', '');
    const targets = targetsStr ? targetsStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    if (!prompt) {
      console.error('错误: 请提供 --prompt 任务说明');
      process.exit(1);
    }

    console.log(`[Collab Bridge] === 步骤 1/4: 创建文件安全快照 ===`);
    if (targets.length > 0) {
      createSnapshot(taskId, targets);
      console.log(`已为 ${targets.length} 个目标文件创建前置备份。`);
    } else {
      console.log(`未指定受限目标文件，跳过前置快照。`);
    }

    console.log(`[Collab Bridge] === 步骤 2/4: 发起 DSH 直连执行 ===`);
    const execRes = await executeDshTask({
      taskId,
      taskTitle,
      prompt
    });

    console.log(`DSH 执行完成，耗时: ${(execRes.durationMs / 1000).toFixed(1)}s，退出码: ${execRes.exitCode}`);

    if (targets.length > 0) {
      console.log(`[Collab Bridge] === 步骤 3/4: 审计文件改动 ===`);
      const audit = generateAudit(taskId);
      console.log(`审计完成：新增 ${audit.createdCount} 个，修改 ${audit.modifiedCount} 个，删除 ${audit.deletedCount} 个文件。`);
      console.log(`详细报告已保存至: .agent/DIFF_AUDIT.md`);
    }

    console.log(`[Collab Bridge] === 步骤 4/4: 执行交付 ===`);
    console.log(JSON.stringify(execRes, null, 2));

  } else if (command === 'rollback') {
    const taskId = getArg('--id');
    if (!taskId) {
      console.error('错误: 请提供 --id 任务编号');
      process.exit(1);
    }
    const res = rollback(taskId);
    console.log(`已成功执行任务 ${taskId} 的一键回滚！`);
    console.log(JSON.stringify(res, null, 2));

  } else if (command === 'audit') {
    const taskId = getArg('--id');
    if (!taskId) {
      console.error('错误: 请提供 --id 任务编号');
      process.exit(1);
    }
    const res = generateAudit(taskId);
    console.log(JSON.stringify(res, null, 2));

  } else {
    console.log(`
Antigravity <-> DSH 协同桥接命令行用法:
  node .agent/bridge/cli.mjs run --id <ID> --title <标题> --prompt <需求> [--targets <文件1,文件2>]
  node .agent/bridge/cli.mjs rollback --id <ID>
  node .agent/bridge/cli.mjs audit --id <ID>
    `);
  }
}

main().catch(err => {
  console.error('[Collab Bridge Error]', err);
  process.exit(1);
});
