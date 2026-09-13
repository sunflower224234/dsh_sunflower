import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const BACKUP_ROOT = resolve('.agent/backups');
const MANIFEST_FILE = 'manifest.json';

function getLocalTime() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 在 DSH 开始修改前，对目标文件创建精确快照
 * @param {string} taskId
 * @param {string[]} targetFiles - 允许修改的文件路径数组（相对路径或绝对路径）
 */
export function createSnapshot(taskId, targetFiles = []) {
  const taskBackupDir = join(BACKUP_ROOT, taskId);
  if (!existsSync(taskBackupDir)) {
    mkdirSync(taskBackupDir, { recursive: true });
  }

  const manifest = {
    taskId,
    createdAt: getLocalTime(),
    files: []
  };

  for (const rawPath of targetFiles) {
    const absPath = resolve(rawPath);
    const relPath = rawPath.replace(/\\/g, '/');

    if (existsSync(absPath)) {
      const backupPath = join(taskBackupDir, relPath.replace(/:/g, ''));
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(absPath, backupPath);
      manifest.files.push({
        relPath,
        absPath,
        existedBefore: true,
        backupPath
      });
    } else {
      manifest.files.push({
        relPath,
        absPath,
        existedBefore: false,
        backupPath: null
      });
    }
  }

  writeFileSync(join(taskBackupDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/**
 * 审计任务执行前后的文件改动，生成 Diff 报告
 * @param {string} taskId
 */
export function generateAudit(taskId) {
  const taskBackupDir = join(BACKUP_ROOT, taskId);
  const manifestPath = join(taskBackupDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(`未找到任务 ${taskId} 的快照元数据！`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const changes = [];

  for (const item of manifest.files) {
    const currentExists = existsSync(item.absPath);

    if (!item.existedBefore && currentExists) {
      changes.push({
        file: item.relPath,
        type: 'CREATED',
        diff: `+ 新增文件 (${readFileSync(item.absPath, 'utf8').length} 字节)`
      });
    } else if (item.existedBefore && !currentExists) {
      changes.push({
        file: item.relPath,
        type: 'DELETED',
        diff: `- 已删除原始文件`
      });
    } else if (item.existedBefore && currentExists) {
      const beforeContent = readFileSync(item.backupPath, 'utf8');
      const afterContent = readFileSync(item.absPath, 'utf8');

      if (beforeContent !== afterContent) {
        changes.push({
          file: item.relPath,
          type: 'MODIFIED',
          diff: `M 文件被修改 (大小变化: ${beforeContent.length} -> ${afterContent.length})`
        });
      } else {
        changes.push({
          file: item.relPath,
          type: 'UNCHANGED',
          diff: `未发生变化`
        });
      }
    }
  }

  const auditReport = {
    taskId,
    auditedAt: getLocalTime(),
    totalTargetFiles: manifest.files.length,
    modifiedCount: changes.filter(c => c.type === 'MODIFIED').length,
    createdCount: changes.filter(c => c.type === 'CREATED').length,
    deletedCount: changes.filter(c => c.type === 'DELETED').length,
    changes
  };

  if (!existsSync('.agent')) {
    mkdirSync('.agent', { recursive: true });
  }

  let md = `# 差异审计报告 (任务: ${taskId})\n\n`;
  md += `**审计时间**: ${auditReport.auditedAt}\n`;
  md += `**改动汇总**: 修改 ${auditReport.modifiedCount} 个，新增 ${auditReport.createdCount} 个，删除 ${auditReport.deletedCount} 个\n\n`;
  md += `| 文件 | 改动类型 | 详情 |\n| :--- | :--- | :--- |\n`;
  for (const c of changes) {
    md += `| \`${c.file}\` | **${c.type}** | ${c.diff} |\n`;
  }

  writeFileSync('.agent/DIFF_AUDIT.md', md, 'utf8');
  return auditReport;
}

/**
 * 一键还原快照，将所有涉及的文件恢复到 DSH 运行前的状态
 * @param {string} taskId
 */
export function rollback(taskId) {
  const taskBackupDir = join(BACKUP_ROOT, taskId);
  const manifestPath = join(taskBackupDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(`未找到任务 ${taskId} 的快照，无法执行回滚！`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const restored = [];

  for (const item of manifest.files) {
    if (item.existedBefore) {
      copyFileSync(item.backupPath, item.absPath);
      restored.push({ file: item.relPath, action: 'RESTORED' });
    } else {
      if (existsSync(item.absPath)) {
        unlinkSync(item.absPath);
        restored.push({ file: item.relPath, action: 'REMOVED_NEW' });
      }
    }
  }

  return {
    taskId,
    rollbackAt: getLocalTime(),
    restored
  };
}
