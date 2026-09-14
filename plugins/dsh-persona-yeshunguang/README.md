# dsh-persona-yeshunguang

DSH **System Prompt 人格插件**（多人设 · 按渠道分流）：给不同入口挂不同的角色人格，各自独立、互不污染。

当前部署的配置：

| 人设 | 生效范围 | 文件 |
| --- | --- | --- |
| 叶瞬光 | 部署级默认 —— 网页端 GUI、子代理、`standard` / `梁神模式` 等所有未被下面认领的会话 | `F:\AI\data\叶瞬光人设提示词-精简版.md` |
| 银狼（QQ 银狼） | 只对 `agentPreset = qq-yinlang` 的会话，也就是 QQ 机器人 | `F:\AI\data\银狼人设提示词-QQ精简版.md` |

## 分流原理

1. 给 QQ 单独做一个 agent preset（`~/.dsh/.agent-presets/qq-yinlang/`）。
2. 把它设成 **QQ 渠道的默认 preset**，这样新接入的 QQ 机器人自动就是银狼，拉进任何群都不用再配：

   ```yaml
   # ~/.dsh/profiles/web/cordis.patch.yml
   - id: xmanrui-dsh-im
     config:
       agentPreset: qq-yinlang
   ```

   dsh-im 在接入机器人时执行 `workspaces.ensure(botId, { defaultAgentPreset: <该值> })`，**只在机器人首次出现时**写入 `integrations/dsh-qq/workspaces.json` 的 `agentPresets[botId]`；已存在的机器人有 per-bot 覆盖值，不受影响。其它渠道不配这一项，继续跟随 Host 默认 `standard`。
3. DSH 会把每个会话用的 preset id **持久化在会话头**（`session.header.agentPreset`），插件能读到。
4. 插件在 `systemPrompt.assemble` 返回后，按 `agentPreset` 选人设：
   - 命中 preset 作用域的人设 → 写入它，并**清掉**部署级人格段（保证只有一个身份），再摘掉 `suppressSections`；
   - 未命中 → 写部署级人设（也就是原来的行为）；
   - 命中 preset 但没有对应人设条目 → 清掉部署级人格段，让该 preset 自己的人格生效。

判定只看 `agentPreset`，**不识别渠道、不依赖 dsh-im 内部结构**，所以 dsh-im 升级不会影响这套分流。

> **已有会话不会自动换。** preset 只在会话创建时读取：改了渠道默认或机器人设置后，要让聊天里发一次 `/new` 再发普通消息，新会话才会按银狼组装。改渠道默认本身还需要重启 `dsh web`。

## 实现要点

- 启动时**读取一次**每个人设文件（提取第一个 ` ```text ` 代码块；没有代码块就用整篇），之后每轮请求直接用内存缓存，**不反复访问磁盘**；文件 mtime 变化时自动重读（见「热重载」）。
- **后置注入**（`deepseek-harness-zh_pro` 同款手法）：包一层 `systemPrompt.assemble`，在它返回之后改写 `assembly.sections`。这样即使会话用了 `complete: true` 的 agent preset（官方组装会把其它全局 section 丢弃），人格也**不会被丢弃**。
- 写入的是**标准人格槽** `deployment:persona-prefix`（order 0，排在 harness identity 之后）。同时会把 DSH 0.1.5 之前的历史段名（`deployment:persona`、`persona`）从 assembly 里剔除 —— 否则模型会同时收到两份人格。
- **不改变**模型参数、工具权限、聊天记录逻辑。

## ⚠ 与 deepseek-harness-zh_pro 的包装链契约

两个插件都包装 `systemPrompt.assemble`，这是本插件**最脆弱的一处耦合**，务必了解：

zh_pro 的 `ensureAssemblePatch` 在重入时会把实例属性**复位到原型方法**，用来甩掉它自己无法解开的
历史包装。它有两个前提假设，本插件都会打破：

1. 「本插件是部署中唯一赋值 `systemPrompt.assemble` 的插件」—— 不成立时，复位会**绕掉**本插件的层，
   人格注入静默失效；
2. 它沿标记链走**整条链**并把链尾当 original —— 当链尾恰好是原型方法时，**中间层会被跳过**。

**实测事故（2026-09-11）**：QQ 机器人在被追问「你是区吗」时突然自称
「DeepSeek Harness 上跑的 AI agent，住在这个 Web GUI 里（127.0.0.1:3080）」——
`app:web-surface` 明明已被 `suppressSections` 摘掉，说明注入层已被绕过。

**修复**落在 `~/.dsh/profiles/web/node_modules/deepseek-harness-zh_pro/lib/assemble-patch.js`
（原文件已备份为 `assemble-patch.js.bak-before-persona-chain-fix`）：

- 本插件用**自己的**标记名 `__dshPersonaAssembleWrapped` / `__dshPersonaAssembleInner`；
  **绝不可**借用 zh_pro 的 `__dshZhAssembleWrapped`，否则会被它的链行走当成自己的层跳过。
- zh_pro 侧：`original` 取「本插件最外层包装的 inner」（保留整条链）；原型复位只在
  `candidate.assemble === Object.getPrototypeOf(candidate).assemble`（即链上确实没有
  任何包装层）时才允许。

**升级 zh_pro 会覆盖这个修复**（它是 npm 包）。升级后请重跑回归测试：

```powershell
node F:\AI\dsh-persona-yeshunguang\test\zh-pro-chain.mjs
```

期望输出：QQ 会话 `人设=true 占位符=false identity=false webSurface=false`，
网页会话 `叶瞬光=true identity=true webSurface=true`，最后一行 `全部通过`、退出码 0。
**这个测试用真实的 zh_pro 实现**，一旦耦合再次断裂会立刻失败。

## 配置

在 `~/.dsh/profiles/web/cordis.patch.yml`（或本插件的 `cordis.patch.yml`）里：

```yaml
- id: dsh-persona-yeshunguang
  config:
    personas:
      - id: default                     # 部署级默认人设
        file: F:/AI/data/叶瞬光人设提示词-精简版.md
      - id: qq                          # 只对下面列出的 agentPreset 生效
        role: qq                        # 仅用于挑选默认文件（DSH_PERSONA_QQ_FILE）与日志
        file: F:/AI/data/银狼人设提示词-QQ精简版.md
        presetIds: [qq-yinlang]
        since: ">=0.1.5"                # 可选：harness 版本闸门
```

| 字段 | 说明 |
| --- | --- |
| `id` | 仅用于日志和去重 |
| `file` | 人设文件；省略时按 `role` 取 `DSH_PERSONA_FILE`（默认人设）/ `DSH_PERSONA_QQ_FILE`（`role: qq`） |
| `presetIds` | 空数组 = **部署级默认**；非空 = 只对该 `agentPreset` 生效 |
| `role` | 目前只认 `qq`，用于自动挑默认文件 |
| `since` | 形如 `>=0.1.5` / `<0.2.0` / `0.1.5`；只作用于 preset 作用域的人设，**不匹配时回退到默认人设**（绝不会变成没人设） |
| `suppressSections` | 要整段摘掉的 prompt 段落名（见下） |
| `reload` | 默认 `true`：按文件 mtime 热重载；`false` = 冻结在启动时的内容 |

`since` 在无法解析、或 harness 版本未知时一律视为**匹配**（保守，宁可生效也不静默失效）。

## 让角色不出戏：`suppressSections`

这是「沉浸式人设」的关键。部署自己会往 system prompt 里写三句关于运行时的事实：

| 段落名 | 内容 | 症状 |
| --- | --- | --- |
| `harness:identity` | `You are an AI agent powered by DeepSeek Harness.` | 机器人自称「DeepSeek Harness 上跑的 AI agent」 |
| `harness:source` | harness 源码 checkout 路径 | 机器人提到源码位置 |
| `app:web-surface` | `…through the DeepSeek Harness Web GUI at http://127.0.0.1:3080` | 机器人说「我住在这个 Web GUI 里」 |

**人设文本再强硬也压不过这第一方的身份声明** —— 它们是平级的 prompt 段落，模型会以官方那句为准。所以要靠 `suppressSections` 把整段删掉，而不是在人格里写「别提自己是 AI」。

```yaml
      - id: qq
        presetIds: [qq-yinlang]
        suppressSections:
          - harness:identity
          - harness:source
          - app:web-surface
```

其余功能段落（工具说明、`agent-instructions`、工作目录 suffix 等）都会保留，能力不受影响。

## 热重载

人设文件默认按 **mtime 自动重读**（每次组装一次 `statSync`，相对一次模型请求可忽略）：改完 `.md` **保存即生效，不用重启**。每次重载和每次屏蔽段落都会在主机日志里打印一行，方便确认：

```
[dsh-persona-yeshunguang] qq: persona file reloaded (1263 chars)
[dsh-persona-yeshunguang] qq: hid 3 section(s) [harness:identity, harness:source, app:web-surface]
```

要冻结点启动时的内容，加 `reload: false`。

## 向后兼容

完全没有 `personas` 配置时，插件退化为旧行为：只读一个 `DSH_PERSONA_FILE`（默认叶瞬光精简版），对所有会话生效。

## 安装

```powershell
dsh plugin --profile web add link:F:\AI\dsh-persona-yeshunguang
```

**插件代码或 `personas` 配置改动需要重启 `dsh web`**（或重启 dsh-desktop 应用）；只改人设 `.md` 内容不需要重启。
卸载：

```powershell
dsh plugin --profile web remove dsh-persona-yeshunguang
```

## 开关

| 方式 | 写法 | 说明 |
| --- | --- | --- |
| 配置项 | 在 `~/.dsh/profiles/web/cordis.patch.yml` 加 `- id: dsh-persona-yeshunguang\n  config:\n    enabled: false` | 最直观 |
| 环境变量 | `set DSH_PERSONA_ENABLED=0`（在 dsh-desktop 的 `start.bat` 里加一行） | 整机/启动作用域 |

默认**启用**。关闭时人格不注入，回退到原始 System Prompt。

## 回退前提

- 开关关闭；
- 人设文件不存在 / 读不到 / 只有空白。

单个文件失效只停用它自己：默认人设坏了，QQ 人设照常工作，反之亦然。**全部**人设都没加载成功时，插件什么都不改写，系统提示词保持原样。

## 改人设内容

直接改 `file:` 指向的 `.md` —— 第一次 ` ```text ` 代码块里的内容就是人设正文。**保存即生效**（热重载），不用重启。

- 网页端：`F:\AI\data\叶瞬光人设提示词-精简版.md`
- QQ 端：`F:\AI\data\银狼人设提示词-QQ精简版.md`（原始完整档案见 `F:\AI\data\银狼_狼尊小姨_聊天机器人人设.md`）

## 文件位置速查

| 东西 | 路径 |
| --- | --- |
| 插件本体 | `F:\AI\dsh-persona-yeshunguang\`（`lib/index.js`、`cordis.patch.yml`） |
| QQ 的 agent preset | `C:\Users\35756\.dsh\.agent-presets\qq-yinlang\`（`preset.yml` + `agent.cordis.yml`） |
| 生效中的插件配置 | `C:\Users\35756\.dsh\profiles\web\cordis.patch.yml` 或插件自带 patch（`dsh --profile web --dump-config` 可查） |

## 排查

```powershell
# 看合成后的配置树，确认 personas 已生效
dsh --profile web --dump-config
```

启动日志里插件会打印一行 `[dsh-persona-yeshunguang] personas: ...`，写明各人设的角色、preset 归属、`since` 和 harness 版本。若显示 `none loaded`，说明人设文件路径不对。
