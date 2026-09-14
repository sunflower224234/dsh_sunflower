# dsh-tts-voice

DSH 语音朗读插件：宿主侧用本地 **GPT-SoVITS V2（预训练基座 + 参考克隆）** 合成语音，客户端在 **设置 → 语音** 里提供原生配置页，并保留一个可点击的悬浮开关。

## 形式（v0.2）

- **设置 → 语音**（原生设置页）：总开关、音量、音色、朗读策略（只读结论 / 最多 N 句 / 全文逐句）、句数上限、语速。
- **左下角悬浮按钮**：单击即开/关；旁边的 ⚙ 单击展开说明（**不再需要 hover**）。
- 设置的真源是宿主侧文件 `F:/AI/GPT-SoVITS/dsh-tts-voice.json`（可用 `DSH_TTS_STATE` 覆盖），
  原子写入。浏览器不再用 localStorage 当权威，因此 **重启 dsh 后开关状态不会丢**。

## 为什么改成客户端插件

旧版只做宿主侧 `webServer.tapIndex` 注入，无法注册进 dsh 的设置区。现在 `package.json` 声明了：

```json
"exports": { "./client": { "default": "./lib/client.js" } },
"dsh": { "client": { "platform": "web" } }
```

`lib/client.js` 是 dsh 的客户端 bundle 形态（`window.__ModuleLoader__.load({ id, factory })`）。
它**只 require shell 播种的 `react` / `react/jsx-runtime`**，不依赖 `@deepseek-ai/dsh-client-store`
（该包在 dsh 0.1.1-rc.2 上并不存在），设置读写走本插件自己的 HTTP 接口 —— 刻意避开
「宿主未注册命名空间时 settingsScope 静默不可写」这个坑。

## 朗读策略（默认「像日常沟通」）

| 档次 | 行为 |
| --- | --- |
| `conclusion`（默认） | 清洗后剔掉过程话（「让我先看一下…」「I'll check…」），只读出结论要点；句子里带「结论是/所以/建议/the conclusion is」时只读那半截 |
| `maxSentences` | 清洗后只读前 N 句（1–10） |
| `all` | 清洗后逐句全读 |

清洗（`lib/read-policy.js`）：代码块、表格整行、Markdown 记号、URL、Windows/Unix 路径、
`文件:行号`、HTML、emoji、装饰线全部去掉；**工具调用、reasoning、中间状态在事件层就被过滤，
结构上不会被朗读**。

## 原理

- 宿主监听 `session/event`，只认 `assistant/chunk` 里的正文 chunk（`text-delta`，以及承载整段
  最终文本的 `block-end`，重复内容去重）；**整轮结束后**才用 `lib/read-policy.js` 选句。
- 每个要读的句子调本地 `http://127.0.0.1:9880/tts`（GPT-SoVITS），WAV 暂存内存。
- 前端轮询 `/dsh-tts/state`，按 id 顺序拉 `/dsh-tts/audio` 播放，播完回调 `/dsh-tts/consumed`。
- **反压**：未被消费的音频达到 12 段或 24MB 就暂停合成（页面没在听时不空烧 GPU），
  未消费音频超过 120 秒直接丢弃。
- **语音关着就不占资源**：关闭状态下**启动不预热模型**（几 GB 的模型不再常驻显存/内存）；
  在设置里关掉语音会**立刻停掉本插件拉起的 TTS 进程**（只停自己起的；用户手动起的服务、
  以及 `DSH_TTS_AUTOSTOP=0` 一律不碰）。重新打开语音时现拉模型，首次需等加载完成
  （悬浮按钮/设置页会显示「模型加载中…」）。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-tts/state` | `{ muted, starting, items[], settings, voices[], backpressured }` |
| GET | `/dsh-tts/settings` | `{ settings, voices, modes, file }` |
| POST | `/dsh-tts/settings` | 局部更新（JSON）；非法值 400 + `{ ok:false, error }` |
| GET | `/dsh-tts/audio?id=` | WAV |
| GET | `/dsh-tts/consumed?id=` | 标记已播放（同时是反压的消费信号） |
| GET | `/dsh-tts/mute?on=1\|0` | 兼容旧入口，内部写同一份设置 |
| GET | `/dsh-tts/voice?set=<id>` | 兼容旧入口 |

注意：**没有 `/dsh-tts/client.js` 路由，也不注入页内脚本** —— 客户端 bundle 由 dsh 的 boot 图
（`/plugins/dsh-tts-voice/client.js`）加载。同源再注入一份会让同一 id 注册两次，dsh-client-modules
在 boot 的 `create()` 里会抛 duplicate factory registration，**整个 GUI 打不开**。
`test/host-integration.test.mjs` 第 8 节就是这条的回归测试。

## 音色切换（方案 A：预训练基座 + 参考克隆）

- 服务端用**预训练基座**（`tts_infer.yaml` 的 `custom` 段），每个音色 = 一段参考音频 + 转录文本，
  切换音色只改 `ref_audio_path` / `prompt_text`，**不重训**。
- 内置音色（参考文件在 `F:/AI/GPT-SoVITS`）：

  | 音色 | id | 参考音频 | 转录文本 |
  | --- | --- | --- | --- |
  | 叶瞬光 | `yeshu` | `reference-叶瞬光-生动.wav` | 哎，干嘛用这么担心的眼神看我？ |
  | 银狼 | `yinlang` | `reference-银狼.wav` | 这么快就上钩了？好像有点棘手。 |

- 加新音色：在 `lib/index.js` 的 `VOICES` 加 `{ id, label, ref, prompt, lang }`。

## 安装

```powershell
dsh plugin --profile web add link:F:\AI\dsh-tts-voice
```

**改了 `dsh.client` 声明或 bundle 后必须重启 `dsh web`**（客户端包元数据在启动时缓存），
之后刷新浏览器。设置里的「语音」页出现即生效。

## 测试

```powershell
node test\read-policy.test.mjs        # 朗读策略对抗样例（45 断言）
node test\host-integration.test.mjs   # 宿主模块隔离集成（33 断言，不需要 dsh 运行）
node test\client-behavior.test.mjs    # 客户端 bundle 行为（33 断言，假 DOM/slots，不需要 dsh 运行）
```

- `host-integration`：stub 掉 cordis ctx 与 HTTP，直接调路由与事件处理器，验证设置读写/校验/落盘、
  开关能关能开且读回一致、旧入口写同一份设置、过程事件不产出音频、反压与清空，以及
  **第 8 节 P0 回归**（宿主绝不能注入页内客户端脚本）。
- `client-behavior`：假 DOM 里把 bundle 挂起来，验证 `settings.section` 注册参数、
  设置页真的渲染出总开关/音量/音色/朗读策略/句数上限、点击总开关会 POST `/dsh-tts/settings`
  且只带变更字段、悬浮按钮单击即切换（非 hover-only），以及缺 slots/缺 document 时只降级不抛错。

## 回滚

- 宿主侧改动前原文件：`lib/index.js.bak-<时间戳>`。
- 旧客户端脚本仍保留在 `lib/tts.js`，并通过 `/dsh-tts/tts.js` 提供服务（未注入），
  必要时把 `tapIndex` 的那一行改回 `/dsh-tts/tts.js` 即可回到旧行为。


## 形式

- 右下角、鲸鱼上方有一个可点击的**悬浮按钮**（已撤回到这里，不再整合进设置面板）。
- 点按钮 = **静音 / 取消静音**（立即停播并清空队列，同时让宿主停止继续合成省 GPU）。
- 鼠标**悬浮到按钮**上弹出菜单：**音量条**（0–100%，作用于正在播放的音频，记忆设置）+ **音色下拉**（叶瞬光 / 银狼，选中即切换）。

## 原理

- 宿主侧监听会话流事件 `session/event`，拦截 `assistant/chunk` 的 `text-delta` 增量。
- 切句（。！？…）、跳代码块与纯标点碎片。
- 每个完整句子调本地 `http://127.0.0.1:9880/tts`（GPT-SoVITS），拿 WAV 暂存内存。
- `webServer.tapIndex` 注入客户端脚本：轮询 `/dsh-tts/state`、按顺序拉取并播放音频。

## 音色切换（方案 A：预训练基座 + 参考克隆）

- 服务端用**预训练基座**（`tts_infer.yaml` 的 `custom` 段 = `gsv-v2final-pretrained`），每个音色 = 一段参考音频 + 转录文本。切换音色 = 改 `ref_audio_path` / `prompt_text`，**不重训、很快**。
- 悬浮菜单里的「音色」下拉，选中即切换。
- 内置音色（参考文件在 `F:/AI/GPT-SoVITS`）：
  | 音色 | id | 参考音频 | 转录文本 |
  | --- | --- | --- | --- |
  | 叶瞬光 | `yeshu` | `reference-叶瞬光-生动.wav` | 哎，干嘛用这么担心的眼神看我？ |
  | 银狼 | `yinlang` | `reference-银狼.wav` | 这么快就上钩了？好像有点棘手。 |
- 加新音色：在 `lib/index.js` 的 `VOICES` 加 `{ id, label, ref, prompt, lang }` 即可。
- **注意**：TTS 服务要换成预训练基座克隆才干净；之前手动跑的微调服务先停掉（正常关闭 dsh 时 `DSH_TTS_AUTOSTOP=1` 自动停）。

## 安装

```powershell
dsh plugin --profile web add link:F:\AI\dsh-tts-voice
```

然后**重启 `dsh web` / dsh-desktop**，刷新浏览器。右下角出现「🔊 语音 开」按钮即生效。
卸载：

```powershell
dsh plugin --profile web remove dsh-tts-voice
```

## 配置（环境变量，可省略）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_TTS_URL` | `http://127.0.0.1:9880/tts` | GPT-SoVITS 接口地址 |
| `DSH_TTS_DIR` | `F:/AI/GPT-SoVITS` | 部署目录 |
| `DSH_TTS_PY` | `<dir>/.venv/Scripts/python.exe` | 启动 python |
| `DSH_TTS_ENTRY` | `api_v2.py` | 入口脚本 |
| `DSH_TTS_CONFIG` | `GPT_SoVITS/configs/tts_infer.yaml` | 配置文件（方案 A 用预训练基座） |
| `DSH_TTS_HOST` / `DSH_TTS_PORT` | `127.0.0.1` / `9880` | 服务地址 |
| `DSH_TTS_SPEED` | `1.0` | 语速 |
| `DSH_TTS_AUTOSTART` | `1` | 未运行则自动启动 |
| `DSH_TTS_AUTOSTOP` | `1` | 关 dsh 停掉插件启动的进程 |
| `DSH_TTS_PRELOAD` | `1` | dsh 启动即后台预热模型，说话即读 |
| `DSH_TTS_VOICE` | `yeshu` | 初始默认音色 id |
| `DSH_TTS_REF` / `DSH_TTS_PROMPT` | 叶瞬光·生动 | 覆盖默认音色的参考音频/转录 |

## 生命周期

- **预热**（默认开）：dsh 启动后台拉起模型（`DSH_TTS_PRELOAD=1`），加载完就绪，说话即读。
- **自动启动/关闭**：`DSH_TTS_AUTOSTART=1` / `DSH_TTS_AUTOSTOP=1`；插件只管理它自己拉起的进程，手动起的用 `stop-tts.bat` 停。
- 日志：`<dir>/dsh-tts-voice-spawn.log`。

## 行为

- 只读页面加载后新生成的 assistant 正文；工具调用、代码块、reasoning 不读。
- 音频按句顺序播放；静音即停止并清空队列。
- 浏览器自动播放限制：页面任一交互后即可出声。

## 验证

```powershell
dsh --profile web --dump-config | Select-String tts
curl "http://127.0.0.1:56063/dsh-tts/state"
curl "http://127.0.0.1:56063/dsh-tts/voice"
```
