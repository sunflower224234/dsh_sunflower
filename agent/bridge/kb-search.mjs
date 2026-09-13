import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, '../knowledge/knowledge.db');

export function searchKnowledge(query, domain = 'hsr', limit = 1) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return '【查询错误】请输入要检索的关键词或角色名。';
  }

  const cleanQuery = query.trim();
  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch (err) {
    return `【知识库错误】无法连接本地知识库数据库: ${err.message}`;
  }

  try {
    // 1. 优先尝试实体名或别名直接匹配 (极速索引命中)
    const exactQuery = cleanQuery.replace(/[\'\"%;]/g, '');
    const tokens = exactQuery.split(/\s+/).filter(Boolean);

    let matchRow = null;

    // 针对每个 token 检查是否直接命中 entity 或 aliases
    for (const token of tokens) {
      const stmt = db.prepare(`
        SELECT * FROM knowledge
        WHERE domain = ? AND (entity = ? OR aliases LIKE ?)
        LIMIT 1
      `);
      const row = stmt.get(domain, token, `%${token}%`);
      if (row) {
        matchRow = row;
        break;
      }
    }

    // 2. 若无直接别名命中，尝试 FTS 全文搜索或模糊匹配
    if (!matchRow) {
      // 提取检索词
      const ftsToken = tokens[0];
      const stmt = db.prepare(`
        SELECT * FROM knowledge
        WHERE domain = ? AND (
          entity LIKE ? OR
          aliases LIKE ? OR
          tags LIKE ? OR
          facts LIKE ? OR
          memes LIKE ?
        )
        LIMIT ?
      `);
      const likePattern = `%${ftsToken}%`;
      const rows = stmt.all(domain, likePattern, likePattern, likePattern, likePattern, likePattern, limit);
      if (rows && rows.length > 0) {
        matchRow = rows[0];
      }
    }

    if (!matchRow) {
      return `【星铁情报】未在本地知识库找到关于“${cleanQuery}”的情报。`;
    }

    // 3. 格式化为高密度极简卡片 (<120字)
    const aliasesList = matchRow.aliases ? matchRow.aliases.split(',').slice(0, 3).join('/') : '';
    const aliasInfo = aliasesList ? `（别名/外号：${aliasesList}）` : '';

    const lines = [
      `【星铁情报】${matchRow.entity}${aliasInfo}`,
      `· 阵营：${matchRow.faction || '未知'}`,
      `· 核心背景：${matchRow.facts}`,
      `· 角色名梗：${matchRow.memes}`,
      `· 关系人际：${matchRow.relations}`
    ];

    return lines.join('\n');
  } catch (err) {
    return `【查询异常】${err.message}`;
  } finally {
    try {
      db.close();
    } catch (_) {}
  }
}

// CLI 执行入口
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const query = process.argv[2];
  const domain = process.argv[3] || 'hsr';

  if (!query) {
    console.log('用法: node kb-search.mjs "<查询内容或角色名>" [domain]');
    console.log('示例: node kb-search.mjs "星期日 平A" hsr');
    process.exit(1);
  }

  const result = searchKnowledge(query, domain);
  console.log(result);
}
