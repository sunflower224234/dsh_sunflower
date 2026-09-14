// dsh-tts-voice — read-policy 对抗回归测试
//
// 用法：node test/read-policy.test.mjs
// 目的：钉死「像日常沟通」的验收线——清洗后不得残留 Markdown/URL/路径/代码/emoji，
//       conclusion 模式必须只输出结论（不念过程话），maxSentences 不得超句数。

import { normalize, pickSentences, splitSentences, isProcessSentence } from '../lib/read-policy.js'

let failed = 0
let passed = 0

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}

const CASES = [
  {
    name: '普通中文答复（加粗 + 列表）',
    mode: 'all',
    text: '我看完了。**结论是：问题出在开关状态只存在浏览器里**，服务端每次重启就重置。\n- 前端从不读服务端的 muted\n- 服务端没有持久化\n建议改成宿主侧落盘。',
  },
  {
    name: 'Markdown 表格 + Windows 路径 + URL + 文件:行号',
    mode: 'conclusion',
    text: '对比结果如下：\n\n| 方案 | 代价 |\n|---|---|\n| A | 改动大 |\n| B | 风险低 |\n\n详情见 https://api-docs.deepseek.com/zh-cn/updates/ 与 F:\\AI\\dsh-tts-voice\\lib\\index.js:130 的 cfg.muted。',
  },
  {
    name: '含代码块',
    mode: 'all',
    text: '用法是这样：\n\n```js\nconst x = 1; // 这行不该被念出来。对吧？\nconsole.log(x)\n```\n\n以上是示例，注意别把代码念出来。',
  },
  {
    name: '过程话 + 结论（中文）',
    mode: 'conclusion',
    text: '让我先看一下这个文件。我先读一遍 index.js 的开头部分，确认事件钩子是怎么写的。接下来我需要检查 poll 循环里的字段。让我再核对一下 cursor 的更新时机。结论是：开关状态必须由宿主侧文件作为唯一真源。',
  },
  {
    name: '过程话 + 结论（英文）',
    mode: 'conclusion',
    text: "Let me start by reading the plugin entry point to see how the session events are wired. I'll check the poll loop next. The conclusion is that the toggle must be persisted host-side, otherwise a restart silently re-enables voice.",
  },
  {
    name: 'maxSentences 上限',
    mode: 'maxSentences',
    maxSentences: 2,
    text: '第一句话在这里，说了一件事。第二句话在这里，说了另一件事。第三句话在这里，说了第三件事。第四句话在这里，说了第四件事。',
  },
]

console.log('read-policy 对抗回归测试\n')

for (const c of CASES) {
  console.log('== ' + c.name + ' ==')
  const cleaned = normalize(c.text)
  const picked = pickSentences(cleaned, { mode: c.mode, maxSentences: c.maxSentences ?? 3 })
  console.log('  清洗后: ' + cleaned.slice(0, 160))
  console.log('  将朗读: ' + JSON.stringify(picked))

  check('清洗后不含 Markdown 记号', !/\*\*|`|\|/.test(cleaned), cleaned.slice(0, 80))
  check('清洗后不含 URL', !/https?:\/\//.test(cleaned), cleaned.slice(0, 80))
  check('清洗后不含 Windows 路径', !/[A-Za-z]:\\/.test(cleaned), cleaned.slice(0, 80))
  check('清洗后不含 emoji', !/[\u{1F300}-\u{1FAFF}]/u.test(cleaned))
  check('朗读内容非空', picked.length > 0)
  check('朗读内容无过程话', !picked.some((s) => isProcessSentence(s)), JSON.stringify(picked))

  if (c.name.includes('代码块')) {
    check('代码块内容未被念出', !/const x|console\.log/.test(picked.join(' ')))
  }
  if (c.name.includes('表格')) {
    check('表格行未被念出', !/方案|A\s*，?\s*改动大/.test(picked.join(' ')), JSON.stringify(picked))
  }
  if (c.mode === 'maxSentences') {
    check('不超过 maxSentences 句', picked.length <= c.maxSentences, '实际 ' + picked.length + ' 句')
  } else {
    check('conclusion 模式不超过 3 句', picked.length <= 3, '实际 ' + picked.length + ' 句')
  }
  console.log('')
}

console.log('splitSentences 基本行为：')
const sents = splitSentences('第一句。第二句！第三句？')
check('三段切分正确', sents.length === 3, JSON.stringify(sents))

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败')
process.exit(failed ? 1 : 0)
