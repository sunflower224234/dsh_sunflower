'use strict';
/**
 * 注入式自定义标题栏的共享常量（DPI 无关，逻辑像素）。
 *
 * 注意：本模块只在【主进程（main.js）】里 require。Electron 的渲染进程默认为
 * 沙箱（sandbox: true），沙箱化 preload 不能 require 本地文件，所以
 * titlebar-preload.js【不能】直接 require 本模块 —— 它通过 IPC
 * `ipcRenderer.invoke('titlebar:height')` 从主进程取该值（见 main.js 的
 * `ipcMain.handle('titlebar:height', () => TITLEBAR_HEIGHT)`）。
 *
 * 因此高度只在这里定义一次：main.js 用它写 `dsh-desktop-titlebar-inset`
 * 契约参数，也经 IPC 下发给 preload 做实际标题栏高度，两侧天然一致。
 * 要改高度只改这一处即可。
 */
const TITLEBAR_HEIGHT = 44;

module.exports = { TITLEBAR_HEIGHT };
