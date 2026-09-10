# DeepSeek Harness 桌面端

用 Electron 原生窗口加载 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI，界面与网页版完全一致。双击即可启动，应用会自动拉起（或复用）`dsh web` 本地服务，关闭窗口时自动结束它。

启动界面使用随机壁纸，与桌面图标同一套美术资源。

![主界面](screenshots/01-主界面.png)

<sub>主界面：随机壁纸（`bg-seaside.png`）+ 注入式毛玻璃标题栏 + 左下角语音悬浮按钮</sub>

![启动界面](screenshots/02-启动界面-海边.png)

<sub>启动界面：随机壁纸 + 左下角品牌托盘（每次启动换一张）</sub>

## 环境要求

- **Node.js 20+**（`node -v` 可查看）
- **DSH 命令行**：`npm install -g @deepseek-ai/dsh`（应用需要它来启动后端）

## 快速开始

1. 双击 `start.bat`
2. 首次运行会自动安装 Electron（约 150MB，稍等片刻）
3. 之后每次双击即启动

## 它是怎么工作的

```
start.bat
  └─ npm start  →  electron .  →  main.js
        ├─ 探测 http://127.0.0.1:3080
        │    ├─ 已运行 DSH  → 直接复用（退出时不杀它）
        │    └─ 未运行      → 启动 `node …/dsh/lib/bin.js web --port 3080`
        ├─ 等待服务就绪（HTTP 200）
        └─ 打开原生窗口加载该地址
```

- 后端进程是应用自己的子进程，关闭窗口时用 `taskkill /T /F` 连同子进程树一并结束
- 单实例：重复双击只会聚焦已打开的窗口
- 外部链接、新窗口一律交给系统浏览器，站内导航在窗口内完成
- **窗口状态会记住**：尺寸、位置、是否最大化存在 `%APPDATA%\dsh-desktop\window-state.json`，下次启动按记忆恢复（改尺寸/位置后防抖 400ms 写入，关闭时立即写入）。最大化时记的是**还原尺寸**（`getNormalBounds()`），所以「最大化→关闭→再开」不会把窗口永久顶满屏；若记忆的位置已不在任何显示器上（拔了外接屏、改过分辨率），会自动只丢位置保留尺寸，避免窗口跑到看不见的地方；记忆文件损坏或不存在时回退默认 1320×860。

自测：`node_modules\electron\dist\electron.exe --user-data-dir=%TEMP%\x .\test-window-state.js`（17 项断言，用独立 userData 目录，不动你的真实记忆文件）。

## 外观资源（assets/）

```
assets/
├─ icon-src.png              应用图标原图（1254×1254，圆角方图）
└─ backgrounds/              壁纸，每次启动随机挑一张（启动界面 + 主界面同一张）
   ├─ bg-day.png  bg-day-1.png  bg-day-2.png      白天
   ├─ bg-night-1.png  bg-night-2.png              夜晚（启动界面自动用更轻的压暗）
   └─ bg-seaside.png                              海边
```

- `icon.ico`（Windows 任务栏 / 资源管理器）与 `splash.png`（标题栏 24px 品牌标 + 启动界面 Logo）都由 `assets/icon-src.png` 生成：

  ```powershell
  powershell -ExecutionPolicy Bypass -File .\make-icon.ps1
  ```

  换图标 = 替换 `assets/icon-src.png` 后重跑上面这条命令；`splash.png` 取的是画面中上部的头部裁切，并套圆角，24px 下也看得清。
- 换壁纸 = 往 `assets/backgrounds/` 里增删图片（`png/jpg/webp`）即可，每次启动随机选一张，无需改代码；启动界面与进入应用后的主界面用的是同一次随机结果。
- 壁纸如何进到主界面：dsh 页面跑在 `http://127.0.0.1:3080`，CSP 会拦掉 `file://` 图片（实测该页面里 `file://` 图片的 `naturalWidth` 恒为 0），所以由主进程读文件编码成 data URL，经 IPC 交给注入的壁纸层（`titlebar-preload.js` 里 `#dsh-desktop-wallpaper`，`z-index:-1` 垫在页面最底层，另加一层 18% 压暗保证文字可读）。
- 该层只是垫底：任何插件（例如 `dsh-any-background`）自己设置的壁纸都会盖在它上面 —— 你显式选过的壁纸始终优先。
- 桌面图标缓存没刷新时，把桌面快捷方式重新建一个，或在资源管理器里刷新一次。

## 配置（环境变量）

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_PORT` | 首选后端端口 | `3080` |
| `DSH_BIN` | 手动指定 dsh 的 `lib/bin.js` 路径 | 自动查找 |
| `DSH_NODE` | 手动指定 node 可执行文件 | 自动查找 |

例（改端口为 8090）：在 `start.bat` 里加一行 `set DSH_PORT=8090`，或：

```bat
set DSH_PORT=8090
call npm start
```

## 调试

- `F12`：开发者工具
- `Ctrl+R`：刷新页面

## 常见问题

- **Electron 运行时下载慢/失败**：`start.bat` 会先尝试默认源（GitHub），失败后自动改用国内镜像 npmmirror。也可手动强制：
  ```
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  node node_modules\electron\install.js
  ```
- **提示「未找到 dsh 安装」**：执行 `npm install -g @deepseek-ai/dsh`，或设置 `DSH_BIN`。
- **3080 被别的程序占用**：应用会自动改用系统分配的随机端口（无需处理）；若想固定端口，设置 `DSH_PORT`。
