// dsh-tts-voice — 朗读策略（宿主与客户端共用的纯函数）
//
// 用户诉求是「像日常沟通」，而不是朗读版屏幕阅读器。这个模块负责三件事：
//   1) normalize(text)     —— 把 Markdown / URL / 路径 / 代码 / emoji 等「不该念出来的东西」清掉；
//   2) pickSentences(...)  —— 按模式选句：
//        conclusion   只读结论要点（跳过「让我先看一下」这类过程话）
//        maxSentences 清洗后只取前 N 句
//        all          清洗后逐句全读
//   3) 顺带提供 isProcessChunk()，让宿主侧在事件层面就过滤掉工具调用/中间状态。
//
// 设计约束：纯函数、无依赖、无副作用，方便单测与在浏览器侧复用。

/** 句子终止符（中英）。 */
const TERMINATORS = '。！？!?…';
/** 句内停顿符，用于把超长句切成可读片段。 */
const SOFT_SEPARATORS = '，、；：,;:';

/** 过程话「整句/整段」模式（不限于开头，用于兜住英文缩写被切句拆散的情况）。 */
const PROCESS_PATTERNS = [
  /^(?:i'?ll|i will|i'm going to|i am going to|i'?m|we'?re|we will)\b/i,
  /^(?:let me|let us|let's)\b/i,
  /^(?:first|next|then|now|to start|to begin)\b[,，]?/i,
  /\b(?:check|read|look at|inspect|verify|re-?run|update)\s+(?:the|this|that|it)\b/i,
];

/** 过程话 / 引导句：命中即整句丢弃（conclusion 模式的默认行为）。 */
const PROCESS_PREFIXES = [
  '让我', '我先', '我来先', '我来看', '我先看', '我们先', '我来', '我接下来',
  '首先我', '接下来我', '下面我', '现在让我', '这里让我',
  'let me', "i'll", 'i will', 'first,', 'first i', 'next,', 'now let me',
  'to start', "let's", 'let us',
];

/** 结论标记：命中即认为这句是「要点」，结论模式下优先保留。 */
const CONCLUSION_MARKERS = [
  '结论', '总之', '总的来说', '所以', '因此', '综合', '一句话', '要点',
  '建议', '推荐', '关键在于', '问题出在', '根因', '原因是', '需要注意',
  '应该', '可以', '需要', '必须', '最好',
  'in short', 'in summary', 'to sum up', 'conclusion', 'the key', 'the problem',
  'so the', 'therefore', 'overall', 'is that',
];

/**
 * 去掉不应朗读的内容。
 * @param {string} input
 * @returns {string}
 */
export function normalize(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  let s = input;

  // 代码块整体丢弃（含围栏内的一切）；未闭合的围栏也按块处理到结尾
  s = s.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  // 表格整行丢弃（写读出来只会是「竖线 A 竖线 改动大」这种噪音；要点通常在表外正文里）
  s = s.replace(/^\s*\|.*\|\s*$/gm, ' ');
  // 行内代码去掉反引号，保留内容（变量名之类念出来尚可接受）
  s = s.replace(/`([^`]*)`/g, '$1');
  // HTML 标签
  s = s.replace(/<[^>]{1,200}>/g, ' ');
  // 图片：只剩链接时丢弃，带 alt 时保留 alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ');
  // 链接：保留文字，去掉 URL
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, ' $1 ');
  // 裸 URL
  s = s.replace(/\b(?:https?|ftp):\/\/[^\s，。；）】>'"]+/gi, ' ');
  s = s.replace(/\bwww\.[^\s，。；）】>'"]+/gi, ' ');
  // Windows 路径（F:\a\b 或 \\server\share）
  s = s.replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n\s]+\\)*[^\\/:*?"<>|\r\n\s]*/g, ' ');
  s = s.replace(/\\\\[^\s]+/g, ' ');
  // Unix 绝对路径（/usr/..., ./src/...）
  s = s.replace(/(?:^|\s)(?:\.{0,2}\/)[\w.\-/]{3,}/g, ' ');
  // 「文件:行号」/ 文件名带扩展名
  s = s.replace(/[\w.\-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|md|txt|py|ps1|bat|vbs|log|toml|ini)\b:?\d*/gi, ' ');
  // 路径被删掉后残留的「:行号」/「#L行号」：Windows 路径规则会在 "F:\...\index.js" 处停下，
  // 把 ":130" 留在正文里，念出来就是「位置见 冒号一三零」。（只吃前面是空白/括号/标点的那个，
  // 避免误伤 "12:30" 这类时间写法。）
  s = s.replace(/([\s（(【[]|^)[:#]L?\d+(?::\d+)?/g, '$1');
  // 邮箱
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' ');
  // Markdown 标题 / 引用 / 分隔线
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' ');
  // 表格分隔行（|---|---|）
  s = s.replace(/^\s*\|?[\s:|-]{5,}\|?\s*$/gm, ' ');
  // 表格竖线 → 停顿，避免「竖线」被念出来
  s = s.replace(/\|/g, '，');
  // 列表符号 / 复选框
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '');
  s = s.replace(/^\s*\[[ xX]\]\s*/gm, '');
  // 强调记号
  s = s.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  s = s.replace(/_{1,3}([^_]+)_{1,3}/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  // emoji / 星号装饰 / 连续标点
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}]/gu, ' ');
  s = s.replace(/[*#~^]+/g, ' ');
  s = s.replace(/([，。！？；：、,.!?;:])\1+/g, '$1');
  // 空白收敛
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\s*\n\s*/g, ' ');
  return s.trim();
}

/**
 * 把文本切成句子（跳过代码块；保留句末标点，便于语气）。
 * @param {string} text 已 normalize 的文本
 * @returns {string[]}
 */
export function splitSentences(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  let buf = '';
  let fence = false;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('```', i)) { fence = !fence; i += 3; continue; }
    const ch = text[i];
    // 换行也是句子边界：Markdown 的列表项/短行大多不带句号，靠它断开才不会连读成一句。
    if (!fence && ch === '\n') {
      const s = buf.trim();
      if (s) out.push(s);
      buf = '';
      i++;
      continue;
    }
    if (!fence && TERMINATORS.includes(ch)) {
      let j = i;
      while (j < text.length && TERMINATORS.includes(text[j])) j++;
      buf += text.slice(i, j);
      const s = buf.trim();
      if (s) out.push(s);
      buf = '';
      i = j;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * 句子的「结论部分」：若句中带结论标记（中文「结论是/所以/建议…」、英文 the conclusion/in short…），
 * 只保留该标记之后的内容；没有标记则返回整句。
 */
const CONCLUSION_CUT = /(?:结论是|结论|所以说|所以|因此|总之|建议|要点是|in short|in summary|to sum up|the conclusion is|the conclusion|overall|therefore)/gi;

function conclusionPart(sentence) {
  const s = String(sentence).trim();
  let last = null;
  CONCLUSION_CUT.lastIndex = 0;
  let m;
  while ((m = CONCLUSION_CUT.exec(s)) !== null) last = m;
  if (!last || last.index <= 0) return s;
  const cut = s.slice(last.index).trim();
  // 结论后半截要有实际内容才用它，否则宁可保留原句
  return cut.length >= 8 ? cut : s;
}

/** 该句是否像「过程话 / 引导句」（而非给出结果）。 */
export function isProcessSentence(sentence) {
  if (typeof sentence !== 'string') return false;
  const s = sentence.trim();
  if (!s) return true;
  const probe = s.toLowerCase();
  if (PROCESS_PREFIXES.some((p) => probe.startsWith(p))) return true;
  return PROCESS_PATTERNS.some((re) => re.test(probe));
}

/** 该句是否带结论/要点标记。 */
export function hasConclusionMarker(sentence) {
  if (typeof sentence !== 'string') return false;
  const s = sentence.toLowerCase();
  return CONCLUSION_MARKERS.some((m) => s.includes(m));
}

/** 句子是否可念（有内容、不是纯符号/纯数字）。 */
export function isSpeakable(sentence) {
  if (typeof sentence !== 'string') return false;
  const s = sentence.trim();
  if (s.length < 2) return false;
  if (!/[\u4e00-\u9fff\u3400-\u4dbfA-Za-z]/.test(s)) return false;
  return true;
}

/**
 * 按模式挑出要朗读的句子。
 * @param {string} input 原始文本
 * @param {{ mode?: 'conclusion'|'maxSentences'|'all', maxSentences?: number }} [opts]
 * @returns {string[]} 朗读顺序的句子数组
 */
export function pickSentences(input, opts = {}) {
  const mode = opts.mode === 'maxSentences' || opts.mode === 'all' ? opts.mode : 'conclusion';
  const limit = Math.max(1, Math.min(10, Number(opts.maxSentences) || 3));

  // 先剥掉围栏代码块（块内一律不读），再「按原始换行切段 → 逐段 normalize → 用 \n 连回去」。
  // 不能先对整段 normalize 再切句：normalize 会把换行收敛成空格，于是列表项/短行会被粘成
  // 一句长话（实测「- 前端从不读服务端的 muted\n- 服务端也没有落盘\n1. 改成宿主侧落盘」会被
  // 念成一整句连读），这正是用户抱怨的「不太像日常沟通」。
  const stripped = String(input ?? '').replace(/```[\s\S]*?(?:```|$)/g, '\n');
  const cleaned = stripped
    .split(/\n+/)
    .map((line) => normalize(line))
    .filter(Boolean)
    .join('\n');
  if (!cleaned) return [];
  let sentences = splitSentences(cleaned).filter(isSpeakable);
  if (sentences.length === 0) return [];

  if (mode === 'all') return sentences;

  if (mode === 'maxSentences') return sentences.slice(0, limit);

  // conclusion：先剔过程话；被剔的句子里如果带转折后的结论，则只留结论那半截
  const content = [];
  for (const s of sentences) {
    if (!isProcessSentence(s)) { content.push(s); continue; }
    const part = conclusionPart(s);
    if (part !== s && part.length > 6) content.push(part);
  }
  const pool = content.length > 0 ? content : sentences;

  // 优先带结论标记的那些句子（保持原顺序），最多 limit 句
  const marked = pool.filter(hasConclusionMarker);
  const picked = (marked.length > 0 ? marked : pool.slice(-Math.min(limit, pool.length)));
  return picked.slice(-limit);
}

/**
 * 该 chunk 是否是「要朗读的最终正文」。
 *
 * 依据 dsh 真实的 StreamChunk 枚举（dsh-llm/lib/types/types.d.ts）：
 *   block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage
 * 正文以 text-delta 流式到达；而 block-end 的 text block 会再次承载**整段最终文本**
 * （dsh-client-ui-conversation/lib/client.js 的 chunkHasText）。
 * 因此两种都接受（否则在回放/catch-up 路径上会丢文本），同一段的重复由宿主侧去重。
 */
export function isTextChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return false;
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.length > 0;
  if (chunk.type === 'block-end') return typeof chunk.text === 'string' && chunk.text.length > 0;
  return false;
}

/**
 * 过程话 / 中间状态过滤：宿主侧事件层用它决定「这条 event 值不值得读」。
 *
 * 兼容两种形状：宿主侧拿到裸事件，dsh 客户端 UI 拿到的是信封 { event, seq }
 * （见 dsh-client-ui-conversation/lib/client.js 的 match.event.type）。若把信封直接
 * 传进来，`event.type` 会是 undefined 而被判成「过程事件」——表现为整机静默且无报错，
 * 所以这里统一拆信封。
 */
export function isProcessChunk(event) {
  const e = event && typeof event === 'object' && event.event && typeof event.event === 'object'
    ? event.event
    : event;
  if (!e || typeof e !== 'object') return true;
  if (e.type !== 'assistant/chunk') return true;
  const chunk = e.data && e.data.chunk;
  return !isTextChunk(chunk);
}
