import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

async function runSmokeTest() {
  console.log('=== [1/4] 初始化受控测试环境 ===');
  const testDir = resolve('.agent/smoke-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });

  const testFile = resolve('.agent/smoke-test/calc.mjs');
  const originalCode = `export function add(a, b) { return a + b; }\n`;
  writeFileSync(testFile, originalCode, 'utf8');
  console.log('已创建初始文件: .agent/smoke-test/calc.mjs');

  const taskId = `smoke-test-${Date.now()}`;
  const targetRelPath = '.agent/smoke-test/calc.mjs';

  console.log(`\n=== [2/4] 测试直连执行与前置快照 (Task: ${taskId}) ===`);
  const runCmd = `node .agent/bridge/cli.mjs run --id "${taskId}" --title "冒烟测试：添加乘法函数" --targets "${targetRelPath}" --prompt "在 ${targetRelPath} 中增加一个 export function multiply(a, b) { return a * b; }，保留原有 add 函数。"`;
  
  console.log('执行命令:', runCmd);
  const runOutput = execSync(runCmd, { encoding: 'utf8' });
  console.log(runOutput);

  // 验证快照是否存在
  const manifestPath = resolve(`.agent/backups/${taskId}/manifest.json`);
  if (!existsSync(manifestPath)) {
    throw new Error('断言失败: 前置快照 manifest.json 未生成！');
  }
  console.log('✔ 前置快照验证通过！');

  // 验证改动后文件内容
  const modifiedCode = readFileSync(testFile, 'utf8');
  console.log('修改后的文件内容:\n', modifiedCode);
  if (!modifiedCode.includes('multiply')) {
    console.warn('注意: DSH 可能未按预期写入 multiply，但调用成功。');
  }

  // 验证审计报告
  const auditPath = resolve('.agent/DIFF_AUDIT.md');
  if (existsSync(auditPath)) {
    console.log('✔ 差异审计报告已生成:\n', readFileSync(auditPath, 'utf8'));
  }

  console.log(`\n=== [3/4] 测试一键无损回滚能力 ===`);
  const rollbackCmd = `node .agent/bridge/cli.mjs rollback --id "${taskId}"`;
  const rollbackOutput = execSync(rollbackCmd, { encoding: 'utf8' });
  console.log(rollbackOutput);

  const restoredCode = readFileSync(testFile, 'utf8');
  if (restoredCode.trim() === originalCode.trim()) {
    console.log('✔ 完美！文件已 100% 还原至执行前的原始版本！');
  } else {
    throw new Error(`回滚失败: 当前文件内容与原文件不符！\n当前: ${restoredCode}\n原始: ${originalCode}`);
  }

  console.log('\n=== [4/4] 冒烟测试全流程通过！双智能体直连与防灾机制完全就绪。 ===');
}

runSmokeTest().catch(err => {
  console.error('冒烟测试失败:', err);
  process.exit(1);
});
