'use strict';
// 注入到当前页面（loading 或 dsh UI）的两件桌面壳外观：
//   1) 自定义标题栏：浮在内容上方，半透明 + backdrop 模糊，让 dsh 的真实背景透上来并被模糊；
//   2) 随机壁纸层：在 dsh 主界面最底层垫一张本次启动随机选中的壁纸（启动界面自己加载背景）。
// 两者都只用内联样式，不走 <style> 标签（避开 CSP）。
const { contextBridge, ipcRenderer } = require('electron');

// 窗口控制桥接
contextBridge.exposeInMainWorld('titlebar', {
  minimize: () => ipcRenderer.send('titlebar:minimize'),
  maximize: () => ipcRenderer.send('titlebar:maximize'),
  close: () => ipcRenderer.send('titlebar:close'),
  onMaximized: (cb) => ipcRenderer.on('titlebar:maximized', (_event, maximized) => cb(maximized)),
});

const ICON_SVG =
  '<svg width="22" height="22" viewBox="0 0 24 24">' +
  '<defs><linearGradient id="tbG" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#5a8cff"/><stop offset="1" stop-color="#2f5bff"/></linearGradient></defs>' +
  '<rect x="1" y="1" width="22" height="22" rx="6" fill="url(#tbG)"/>' +
  '<path d="M7 12c0-3.3 2.2-5.5 5-5.5s5 2.2 5 5.5-2.2 5.5-5 5.5c-1 0-1.9-.2-2.6-.7L8 18.5l.7-3.1A5.4 5.4 0 0 1 7 12z" fill="#fff"/>' +
  '<circle cx="9.4" cy="11" r="1" fill="#2f5bff"/><circle cx="14.6" cy="11" r="1" fill="#2f5bff"/></svg>';

function setStyle(el, css) {
  // 逐条写入内联样式，避开 CSP 对 <style> 标签的拦截
  for (const [k, v] of Object.entries(css)) el.style.setProperty(k, v);
}

// 页面自己有没有铺背景图（含内联与样式表）：body 兜底时才需要判断
function bodyHasBackgroundImage() {
  try {
    return getComputedStyle(document.body).backgroundImage !== 'none';
  } catch {
    return false;
  }
}

// 启动界面（loading.html）自己按相对路径加载背景图，只有 dsh 主界面需要注入壁纸层
const IS_LOADING_PAGE = /loading\.html$/i.test(location.pathname);

/**
 * 在页面最底层垫一张随机壁纸（本次启动由主进程选定，与启动界面是同一张）。
 *
 * 为什么是 z-index:-1 的固定层：dsh 的主题表面（--dsw-alias-bg-base 等）在当前配置下近乎
 * 透明，垫在最底层就能像内置壁纸一样透上来，不必改页面结构。
 *
 * 为什么走 data URL：页面跑在 http://127.0.0.1:3080，CSP 拦掉了 file:// 图片
 * （实测该页面里 file:// 图片的 naturalWidth 恒为 0），所以由主进程读文件后编码下发。
 *
 * 为什么在 document-start 插入：要赶在 dsh 自己的脚本之前，让这一层成为 body 的第一个
 * 子元素、永远绘制在最后面。任何插件（如 dsh-any-background）自设的壁纸都会盖在它上面，
 * 用户显式选过的壁纸始终优先。
 */
function injectWallpaper() {
  if (document.getElementById('dsh-desktop-wallpaper')) return;
  const layer = document.createElement('div');
  layer.id = 'dsh-desktop-wallpaper';
  setStyle(layer, {
    'position': 'fixed', 'inset': '0', 'z-index': '-1',
    'pointer-events': 'none', 'background-position': 'center',
    'background-size': 'cover', 'background-repeat': 'no-repeat',
    'opacity': '0', 'transition': 'opacity 0.35s ease',
  });
  document.body.prepend(layer);

  // 压暗层：整屏只压很轻的一层，另在左侧加一道渐变（dsh 侧边栏是半透明的，亮色壁纸下
  // 文字会糊在背景上）。中心区域基本不压，人物主体依然清楚。
  // z-index:0 —— 仍在页面内容之下（壁纸在 -1 层），所以只压壁纸。
  const veil = document.createElement('div');
  veil.id = 'dsh-desktop-wallpaper-veil';
  setStyle(veil, {
    'position': 'fixed', 'inset': '0', 'z-index': '0', 'pointer-events': 'none',
    'background':
      'linear-gradient(90deg, rgba(6, 12, 26, 0.30) 0%, rgba(6, 12, 26, 0.16) 18%, rgba(6, 12, 26, 0.00) 42%),' +
      'rgba(6, 12, 26, 0.12)',
    'opacity': '0', 'transition': 'opacity 0.35s ease',
  });
  document.body.prepend(veil);

  ipcRenderer.invoke('titlebar:background').then((dataUrl) => {
    if (!dataUrl) { layer.remove(); veil.remove(); return; }
    layer.style.setProperty('background-image', `url("${dataUrl}")`);
    layer.style.setProperty('opacity', '1');
    veil.style.setProperty('opacity', '1');
  }).catch(() => { layer.remove(); veil.remove(); });
}

if (!IS_LOADING_PAGE) {
  if (document.body) injectWallpaper();
  else document.addEventListener('DOMContentLoaded', injectWallpaper, { once: true });
}

async function buildTitleBar() {
  // 从主进程取鲸鱼娘图标（沙箱渲染进程里 preload 无法直接读文件）
  const iconData = await ipcRenderer.invoke('titlebar:icon').catch(() => null);
  // preload 处于沙箱，不能 require 本地文件；标题栏高度由主进程经 IPC 下发（单一来源 titlebar-common.js）
  const TB_H = await ipcRenderer.invoke('titlebar:height').catch(() => 44);
  // 兜底：只有 dsh 界面自己完全没铺背景、且壁纸层也没能注入时，才把同一张壁纸写到 body 上
  // （壁纸层已经生效时跳过，省掉一次几 MB 的 data URL 传输）
  if (!IS_LOADING_PAGE && !document.getElementById('dsh-desktop-wallpaper') && !bodyHasBackgroundImage()) {
    const bgUrl = await ipcRenderer.invoke('titlebar:background').catch(() => null);
    if (bgUrl) {
      setStyle(document.body, {
        'background-image': `url("${bgUrl}")`,
        'background-size': 'cover',
        'background-position': 'center',
        'background-attachment': 'fixed',
        'background-repeat': 'no-repeat',
      });
    }
  }

  const tb = document.createElement('div');
  setStyle(tb, {
    'position': 'fixed', 'top': '0', 'left': '0', 'right': '0', 'height': `${TB_H}px`,
    'z-index': '2147483647', 'display': 'flex', 'align-items': 'center',
    '-webkit-app-region': 'drag', 'user-select': 'none', 'box-sizing': 'border-box',
    'background': 'rgba(12,18,36,0.30)',
    '-webkit-backdrop-filter': 'blur(16px) saturate(1.15)',
    'backdrop-filter': 'blur(16px) saturate(1.15)',
    'border-bottom': '1px solid rgba(255,255,255,0.10)',
    'box-shadow': '0 2px 14px rgba(0,0,0,0.25)',
  });
  tb.id = 'dsh-custom-titlebar';

  const brand = document.createElement('div');
  setStyle(brand, { 'display': 'flex', 'align-items': 'center', 'gap': '9px', 'padding-left': '12px' });
  if (iconData) {
    const img = document.createElement('img');
    img.src = iconData;
    setStyle(img, { 'width': '24px', 'height': '24px', 'border-radius': '6px', 'box-shadow': '0 1px 4px rgba(0,0,0,0.4)' });
    brand.appendChild(img);
  } else {
    brand.innerHTML = ICON_SVG;
  }
  const name = document.createElement('span');
  setStyle(name, { 'color': '#fff', 'font': '600 13px "Segoe UI",system-ui', 'letter-spacing': '1px', 'text-shadow': '0 1px 4px rgba(0,0,0,0.55)' });
  name.textContent = 'DeepSeek Harness';
  brand.appendChild(name);

  const spacer = document.createElement('div');
  setStyle(spacer, { 'flex': '1' });

  const ctl = document.createElement('div');
  setStyle(ctl, { 'display': 'flex', 'height': `${TB_H}px`, '-webkit-app-region': 'no-drag' });
  const mkBtn = (title, hide, innerHTML, cls) => {
    const b = document.createElement('button');
    setStyle(b, {
      'width': '46px', 'height': `${TB_H}px`, 'border': 'none', 'background': 'transparent',
      'color': '#fff', 'display': 'flex', 'align-items': 'center', 'justify-content': 'center',
      'cursor': 'default',
    });
    if (hide) b.style.display = 'none';
    b.title = title;
    b.innerHTML = innerHTML;
    if (cls === 'close') {
      b.addEventListener('mouseenter', () => { b.style.background = '#e81123'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    } else {
      b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,0.14)'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    }
    ctl.appendChild(b);
    return b;
  };
  const sv = (p) => `<svg width="12" height="12" viewBox="0 0 12 12" style="pointer-events:none">${p}</svg>`;
  const min = mkBtn('最小化', false, sv('<rect x="1" y="9" width="10" height="1.6" fill="currentColor"/>'));
  const max = mkBtn('最大化', false, sv('<rect x="1.2" y="1.2" width="9.6" height="9.6" fill="none" stroke="currentColor" stroke-width="1.3"/>'));
  const restore = mkBtn('还原', true, sv('<rect x="1.2" y="3" width="7.8" height="7.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.4 3 V1.2 H10.8 V8.6 H9" fill="none" stroke="currentColor" stroke-width="1.3"/>'));
  const close = mkBtn('关闭', false, sv('<path d="M1 1 L11 11 M11 1 L1 11" stroke="currentColor" stroke-width="1.4"/>'), 'close');

  tb.appendChild(brand);
  tb.appendChild(spacer);
  tb.appendChild(ctl);
  document.body.appendChild(tb);

  min.addEventListener('click', () => ipcRenderer.send('titlebar:minimize'));
  close.addEventListener('click', () => ipcRenderer.send('titlebar:close'));
  const toggleMax = () => ipcRenderer.send('titlebar:maximize');
  max.addEventListener('click', toggleMax);
  restore.addEventListener('click', toggleMax);
  ipcRenderer.on('titlebar:maximized', (_event, m) => {
    max.style.display = m ? 'none' : 'flex';
    restore.style.display = m ? 'flex' : 'none';
  });

  // 把内容下移，露出标题栏（背景保持充满，标题栏即可透出真实背景）
  setStyle(document.body, { 'padding-top': `${TB_H}px` });
  // 若 dsh 用 html 承载，也一并处理
  if (document.documentElement) {
    document.documentElement.style.setProperty('--dsh-tb-h', `${TB_H}px`);
  }
}

function inject() {
  if (document.getElementById('dsh-custom-titlebar')) return;
  if (document.body) {
    buildTitleBar();
  } else {
    document.addEventListener('DOMContentLoaded', buildTitleBar);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', inject);
} else {
  inject();
}
