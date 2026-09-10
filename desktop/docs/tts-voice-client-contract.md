# dsh 0.1.1-rc.2 客户端插件契约（dsh-tts-voice 改造依据）

调查人：contracts（researcher）· 任务 t1 · 全程只读，未修改 dsh 本体与任何已装插件。
目标环境：`@deepseek-ai/dsh` **0.1.1-rc.2**（`C:\Users\35756\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\package.json` 第 3 行 `"version": "0.1.1-rc.2"`），web profile `C:\Users\35756\.dsh\profiles\web`。

凡标 **[实证]** 的结论都在本机跑过或抓到过运行时数据；标 **[推断]** 的是未经运行时验证的推理，落地前请复测。

---

## 0. 先回答最关键的问题

> **宿主侧没有任何 schema 的命名空间，客户端 `settingsScope` 能不能写入？**

### 结论：**不能。写入在宿主侧被判死，而且客户端不会报错——必须先在宿主侧注册该命名空间的 schema。**

完整证据链（5 环，全部实证）：

**① 宿主 `mutate/update/replace` 一律先在注册表里找命名空间，查不到直接抛。**
`...\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-settings\lib\index.js`（下称 `dsh-settings/lib/index.js`）`write()`：

```js
write(ns, input, mode, expectedRevision) {
    const verb = mode === "merge" ? "update" : mode === "replace" ? "replace" : "mutate";
    const registration = this.registrations.get(ns);
    if (registration === void 0) throw new Error(`settings namespace "${ns}" is not registered`);
```

**② RPC 层把这个抛错折成 `settings-rejected` 的失败结果（不抛给浏览器）。**
`...\@deepseek-ai\dsh-host-apiproxy\lib\index.js`，`settingsWrite` 的 catch 分支：

```js
return err(request, {
    code: "settings-rejected",
    message: error instanceof Error ? error.message : String(error),
    details: { ns }
});
```
同一文件里路由表把三者都接到该方法：
```js
update: (request) => settingsWrite(request, request.payload.ns, "update", ...),
replace: (request) => settingsWrite(request, request.payload.ns, "replace", ...),
mutate: (request) => settingsWrite(request, request.payload.ns, "mutate", ...)
```

**③ 客户端的 `set()` 把这个失败**吞掉**：`response.result.ok === false` 时只做一次 mirror 重读，然后正常 resolve。**
`...\@deepseek-ai\dsh-client-ui-settings\lib\client.js`（下称 `ui-settings/lib/client.js`）`SettingsScopeController.write(op)`：

```js
write(op) {
    const generation = ++this.writeGeneration;
    return this.enqueue(async () => {
        const revision = this.pendingRevision ?? this.getSnapshot().revision;
        let response;
        try {
            response = await this.api.settings.mutate({ ns: this.spec.namespace, ops: [op],
                ...revision === void 0 ? {} : { expectedRevision: revision } });
        } catch (_settingsWriteFailure) {
            await this.recover(generation);
            return;
        }
        if (!response.result.ok) {
            await this.recover(generation);
            return;
        }
        ...
```
→ `await scope.set('enabled', true)` **永远不 reject**。谁只 `await` 不看快照，谁就以为写成功了。

**④ 命名空间没在宿主注册时，客户端 scope 的状态恒为 `unavailable`，`value` 恒为 `undefined`。**
同文件 `SettingsScopeController.derive()`：

```js
derive() {
    if (this.disposed) return;
    const mirrored = this.mirror.getSnapshot();
    if (mirrored.view === void 0) return;
    const { writable } = mirrored.view;
    const view = mirrored.view.namespaces.find((candidate) => candidate.ns === this.spec.namespace);
    if (view === void 0) {
        this.store.update((draft) => {
            draft.status = "unavailable";
            draft.writable = writable;
        });
        return;
    }
```
而 `writable` 只反映“provider 是否可写”，与命名空间是否存在无关。

**⑤ 权威 UI 自己的做法就是看 `status` 判活。** 第三方 `@linxin666/dsh-client-ui-task-board` 的 `src\client\index.ts` 第 300-309 行：

```ts
const syncEnabled = (): void => {
    const snapshot = settingsScope.getSnapshot()
    const enabled = snapshot.status === 'ready'
      ? snapshot.value?.enabled ?? true
      : snapshot.status === 'unavailable'
    if (enabled) mountUi()
    else uiDisposer?.()
}
settingsScope.subscribe(syncEnabled)
syncEnabled()
```

### 因此正确做法（二选一）

**方案 A（推荐，走原生设置页）——宿主侧注册命名空间，客户端绑同一个 namespace：**

宿主侧（`lib/index.js`，本插件本来就是双面插件，不需要新包）：

```js
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

const NS = settingsNamespace('dsh-tts-voice')          // 命名空间必须是 kebab-case
const SettingsSchema = z.object({
  enabled: z.boolean().default(true),
  voice: z.string().default('yeshu'),
  volume: z.number().min(0).max(1).default(1),
  rate: z.number().default(1),
})

function apply(ctx) {
  // ... 现有 webServer 路由等 ...
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NS, SettingsSchema, { base: { /* 组成默认值，可选 */ } })
  })
}
```
这段不是照抄猜测，它是官方双面插件的**逐行同构写法**：`...\dsh-client-ui-theme\lib\index.js` 第 70-73 行
```js
function apply(ctx) {
    ctx.inject(["settings"], (settingsCtx) => {
        settingsCtx.settings.register(THEME_NAMESPACE, ThemeSettingsSchema);
    });
```
`dsh-client-locale\lib\index.js` 第 20-24 行同构；第三方 `@linxin666/dsh-client-ui-task-board\src\index.ts` 第 154-165 行是带 `{ base }` + `scope.watch()` 的同构写法。

客户端侧（bundle 内）绑同一命名空间：
```js
const scope = ctx.settingsScope.bind({ namespace: 'dsh-tts-voice' })
```
（`dsh-client-ui-theme\lib\client.js` 第 1313-1318 行 `new ThemeRuntime(ctx, ctx.settingsScope.bind({ namespace: THEME_SETTINGS_NAMESPACE }))`；`dsh-client-locale\lib\client.js` 第 1217 行同构。）

**客户端不再需要自己写 Schema**：宿主 `register` 时把 `schema.toJSON()` 随描述符下发，客户端可用 `ctx.settingsSchema.rehydrate(view.schema)` + `ctx.settingsSchema.validate(node, value)` 做本地校验（`ui-settings/lib/client.js` 里 `SettingsSchemaService` 的 `super(ctx, "settingsSchema")`，以及 `rehydrate(serialized) { return new Schema(serialized) }`）。若给 `bind()` 传了 `decode`，默认的“rehydrate+validate”路径会被跳过（`decode(view)` 首行 `if (this.spec.decode !== void 0) return this.spec.decode(view.value)`），此时 UI 必须自己保证值合法。

**方案 B（不改宿主 settings 面，设置页只做 UI）——设置走插件自己的 HTTP 路由。**
本插件已有 `/dsh-tts/*` 路由族；客户端从设置页直接 `fetch('/dsh-tts/config?...')`，宿主侧用现有 `cfg` 落盘（例如写 `$DSH_HOME` 下一个 JSON，或继续用环境变量做默认值）。代价：**不会出现在“设置 → 插件配置”里**，也没有 revision/冲突检测，一切并发与校验都自己负责。
参考同类实现：`@linxin666/dsh-client-ui-task-board` 的 `src\host-routes.ts` + `src\loopback.ts`（宿主路由 + 回环/同源护栏），客户端 `src\client\host-api.ts` 负责调用。

> 我的建议：**方案 A**。它才是“设置里长出一页原生 UI”的本意；方案 B 只是伪装成设置页的私有表单。两者可以共存（语音开关走 settings，运行时音频流继续走 `/dsh-tts/*`）。

---

## 1. 一个包怎么变成“真正的客户端插件”

**发现机制（宿主 `@deepseek-ai/dsh-client-modules/lib/index.js`，`ClientModuleRegistry.resolveMeta`）**，逐条对应到本插件要改的地方：

| 宿主的要求（源码出处） | dsh-tts-voice 现在 | 要改成 |
|---|---|---|
| loader tree 里有 `name: 'dsh-tts-voice'` 的 entry | ✅ `cordis.patch.yml` 第 11-13 行已有 `- insert: - id: dsh-tts-voice / name: dsh-tts-voice` | 不动 |
| `require.resolve('dsh-tts-voice/package.json')` 能解析 | ✅ 可解析到 `F:\AI\dsh-tts-voice\package.json`（lnk 已装） | 不动 |
| `package.json` 的 `dsh.client.platform === 'web'` | ❌ 只有 `dsh.bundle.patch` | 加 `dsh.client` |
| `exports["./client"]` 是字符串（或 `{default: string}`） | ❌ 没有 `exports` 字段 | 加 `exports` |
| 该文件真实存在，内容是 `window.__ModuleLoader__.load({id, factory})` | ❌ 不存在 | 新增 `lib/client.js` |

对应源码：
```js
const decl = parseDshClient(pkgName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
if (decl === void 0 || decl.platform !== "web") { this.pkgMeta.set(pkgName, null); return null; }
const clientRel = clientExportOf(pkgName, pkg.exports);
if (clientRel === void 0) throw new Error(`client-modules: ${pkgName} declares dsh.client but exports no "./client" bundle`);
const meta = { clientPath: join(dirname(pkgPath), clientRel), ..., external: decl.external ?? [], ... };
```
`parseDshClient` 的字段校验：`platform` 必填 string；`inject` / `external` 可选 string[]；`immediately` 可选 boolean。

**Bundle 不存在会怎样？** `initialBundleRevision` 抛 `MissingClientBundleError`，聚合为 `ClientPackageCompositionError` 并 **fail-loud**（该 fiber FAILED，启动审计报错）。所以 `lib/client.js` 必须在 `dsh web` 启动前就存在。

**我实测的发现链（只读探针，脚本留在 `docs/.probe-client-contract.mjs`）**：
```
dsh-tts-voice                    -> error: no dsh.client{platform:web} -> NOT a client package
@linxin666/dsh-client-ui-task-board -> clientPath=...\lib\client.js  bundleExists=true
dsh-any-background               -> clientPath=...\lib\client.js  bundleExists=true
loaderEntryResolvesTo: F:\AI\dsh-tts-voice\lib\index.js
```

**运行时实证：现在跑着的 GUI 的 boot 图里没有 tts 行。** `GET http://127.0.0.1:3080/` 返回的 `globalThis["__DSH_BOOT__"]` 共 54 行，`id` 形如：
```json
{"id":"dsh-any-background","url":"/plugins/dsh-any-background/client.js?rev=b476495d9213","rev":"b476495d9213","immediately":true,"inject":[...]}
```
`rev` = bundle 文件内容的 sha1 前 12 位，URL 就是 `/plugins/<id>/client.js?rev=<rev>`；`grep tts` 命中 0。

### package.json 目标形态（可直接抄）

```json
{
  "name": "dsh-tts-voice",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  }
}
```
`inject` 是**信息性**的（preflight 展示 / HMR diff），源码注释：
```
/** Package-name dependency edges, informational (preflight display / HMR diffing). */
inject?: string[];
```
`external` 才是模块图边（同步 `require` 能否成功）：
```
/** Non-baseline module specifiers this row requests; omitted when it requests none. */
external?: string[];
```
官方 37 个客户端插件与 3 个第三方插件的 `external` 全是空/缺省（实测该 profile 54 行里 `external` 全为空）。

### Bundle 头（照抄 `dsh-client-hmr\lib\client.js` 第 1-5 行）

```js
window.__ModuleLoader__.load({
  id: "dsh-tts-voice",              // ★ 必须等于包名，等于 boot 图的 id
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // ...包裹全部代码；副作用都写在这个闭包里（materialize 时才跑）...
    exports.name = "dsh-tts-voice";
    exports.inject = ["slots", "locale", "settingsScope"];   // cordis 客户端服务名
    exports.apply = (ctx) => { /* 挂 UI */ };
    return module.exports;
  }
});
```
`exports.name` 是 cordis 插件名（HMR 按 `entry.options.name` 反查 entry，见 `dsh-client-hmr` 的 `findEntry`）。

---

## 2. `require` 的解析顺序与「静态模块表」——决定哪些 import 能用

`@deepseek-ai/dsh-client-modules\lib\index.js` 模块注释给出的递归解析顺序：

```
Resolution branch order (import): seed word → shell instance; memoized record → exports;
graph row → register its dependency factories and own factory; registered factory → materialize;
anything else → throw (loud — the runtime mirror of the build-time bundle purity gate).
```

**静态种子表（shell 提供，`require` 免费可用）**——实测自 `dsh-web-frontend\dist\assets\index-ClqxG24t.js` 的朴素 JS（非 sourcemap）：
```js
function Jd(){return{react:e6,"react/jsx-runtime":i6,"react-dom":a6,"react-dom/client":d6,
  "@deepseek-ai/cordis":H5,
  "@deepseek-ai/dsh-client-ui-slots":g6,
  "@deepseek-ai/dsh-client-ui-primitives":Kd}}
```
我逐个字符串计数验证过：上述 7 个在 shell 里各出现 1 次；`@deepseek-ai/dsh-client-ui-settings` 与 `@deepseek-ai/dsh-client-store` 出现 **0** 次。

**另外两个“一定可用”的模块**（宿主 HTML 无条件 parser-preload，`bootInjections` 的 `PARSER_PRELOAD_IDS`）：
- `@deepseek-ai/dsh-client-modules`
- `@deepseek-ai/dsh-client-runtime`（所以 `require("@deepseek-ai/dsh-client-runtime/client")` 可用）

**已知可用 require 清单（实证：遍历已装 bundle 的 `require("...")` 取值）**：

| specifier | 可用？ | 证据 |
|---|---|---|
| `react` | ✅ 种子表 | shell 表 |
| `react/jsx-runtime` | ✅ 种子表 | shell 表 |
| `react-dom` | ✅ 种子表 | shell 表 |
| `react-dom/client` | ✅ 种子表 | shell 表 |
| `@deepseek-ai/cordis` | ✅ 种子表 | shell 表 |
| `@deepseek-ai/dsh-client-ui-slots` | ✅ 种子表（**注意：磁盘上根本没有这个包的目录**） | shell 表 |
| `@deepseek-ai/dsh-client-ui-primitives` | ✅ 种子表 | shell 表 |
| `@deepseek-ai/dsh-client-runtime/client` | ✅ parser-preload | dsh-client-ui-theme/lang 等 20+ 包都 require 它 |
| `@deepseek-ai/dsh-client-ui-settings/client` | ⚠️ 非种子（但它是 boot 图里的一行，建议在 `dsh.client.external` 里显式声明） | — |
| `@deepseek-ai/dsh-client-store` | ❌ **不要用** | 见下方警告 |
| `@deepseek-ai/dsh-client-locale/client` | 类型/服务面；运行时只应用服务名 | — |

> ⚠️ **`@deepseek-ai/dsh-client-store` 在 0.1.1-rc.2 不存在**：整个 dsh 安装里没有该包目录，profile `node_modules` 里也没有，`npm`/pnpm 都没装，shell 种子表里也没有。而 `dsh-any-background\lib\client.js` 里 `let ... = require("@deepseek-ai/dsh-client-store")`（1 处）。**[推断]** 这是新版核心（0.1.5+）的包，`dsh-any-background` 只是声明了 `dsh.client.inject`（信息性，不产生图边），所以它的 bundle 会在 materialize 时 require 失败；后果是否只波及它这一行我没在浏览器里验证。
> **结论：dsh-tts-voice 的 bundle 绝对不要 require 它**，改用种子表里的 `react` + `useSyncExternalStore` 自己订阅，或走 `ctx.settingsScope`。
>
> 纯种子表 / 只 require 到 parser-preload 的先例（最安全的模板）：`dsh-better-sidebar\lib\client.js` 只 require `react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/dsh-client-ui-primitives`；`@linxin666/dsh-client-ui-task-board\lib\client.js` 只 require `react, react/jsx-runtime, react-dom/client`。

**构建（bundle）注意事项**
- 产物形态 = `window.__ModuleLoader__.load({id, factory})` 的 classic script，**不能是 ESM**（宿主按 `<script src>` 加载 → 注册 factory，见 `dsh-client-hmr\lib\client.js` 的实际产物）。
- factory 里的 `require` 是**同步**的；没有动态 `import()`。
- `@deepseek-ai/dsh-client-ui-slots` 是**类型来源**（`import type` 会被擦除、不产生 require 请求）；具体值（如 `resolveSlotLabel`）由宿主注入到组件 props 里，不需要自己 require。
- 本仓库没有 dsh 源码树，所以 `pnpm run build` / `tsdown` 用不上；**手写 `lib/client.js` 或自备 esbuild 均可**，只要产物符合上面的 header 与闭包约定。第三方包（task-board）明确在 README 里写过这一点：out-of-tree 插件必须自行复现该 bundle 格式。
- 改 `lib/client.js` 后：`ClientModuleRegistry` 对包元数据有永久缓存（`pkgMeta` 不过期），`internal/plugin` 事件也只重扫 entry 名。**[推断]** 新增 `dsh.client` 声明需要**重启 `dsh web`** 才进 boot 图；`rev` 是每次启动重新 hash，所以之后单纯改内容 + 重启/刷新即可。改完声明后请重启一次再验证。

---

## 3. 宿主侧 settings 面：`ctx.settings.register`

服务定义在 `@deepseek-ai/dsh-settings`（`ctx.settings`）。签名与语义（`dsh-settings/lib/index.js`）：

```js
register(ns, schema, options) {
    if (this.registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`);
    ...
    this.ctx.effect(() => { this.registrations.set(ns, registration); return () => this.registrations.delete(ns); }, ...);
    return { get: () => registration.resolved, watch: (cb) => {...}, update: (patch) => this.update(ns, patch), replace: (s) => this.replace(ns, s) };
}
```
- **命名空间必须 kebab-case**：`const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/`，`settingsNamespace(value)` 不匹配就 `throw new TypeError(...)`。`'dsh-tts-voice'` ✅ 合法。
- 描述符（`describe()`）暴露 `schema.toJSON()`、`value`、`revision`、`base`、`user`（**字段出现在 `user` 才表示“用户覆盖过”**）、`applies`。浏览器面走 `describe({ redactSecrets: true })`。
- 写到未注册命名空间：见第 0 节 ①②。
- 写入值必须是 JSON 形状；`expectedRevision` 不匹配抛 `SettingsConflictError`（`code: 'SETTINGS_CONFLICT'`）。
- 该 profile 已经挂了 provider：`@deepseek-ai/dsh-base\cordis.patch.yml` 里 `- id: settings / name: '@deepseek-ai/dsh-settings-file'`，文档落地 `$DSH_HOME/settings.yaml`（热重载）。所以 `ctx.settings` 一定存在，`ctx.inject(['settings'], ...)` 会立刻回调。**[推断]** 但保持 `ctx.inject` 的写法（而不是 `ctx.get('settings')` 硬读）更稳，官方三个包都这么做。

**读端（宿主自身要用这个值时）**，例如决定“默认是否开启朗读”：
```js
const settings = ctx.get('settings')
const section = settings?.get(NS)        // 未注册/无 provider 时为 undefined
const enabled = section?.enabled ?? true
```
（`dsh-client-ui-theme\lib\index.js` 第 57-63 行的 `readPreference` 就是这个形状。）

---

## 4. 客户端 settings 面：`ctx.settingsScope`

`@deepseek-ai/dsh-client-ui-settings` 提供：

- `ctx.settingsScope.bind({ namespace, decode? }) -> SettingsScope<T>`（同一个服务对象也提供 `describe()` 给跨命名空间场景）。
- `SettingsScope`：`getSnapshot()` / `subscribe(fn)` / `set(field, value)` / `unset(field)` / `dispose()`（`ui-settings/lib/client.js`）。
- **快照形状**（同文件 `store.set({ section: void 0, value: void 0, base: void 0, user: void 0, revision: void 0, writable: false, mode: persistence })` 起手，`derive()` 填 `status/value/base/user/revision/writable`）：
  - `status`: `'idle' | 'loading' | 'ready' | 'unavailable'`
  - `value`: 完整 section（**尚未加载完时可能是 `undefined`，不要 `value.enabled` 直接取值 → 用 `value?.enabled ?? 默认值`**）
  - `base` / `user`: 组成层与用户原始层
  - `revision`: 命名空间级单调计数，写时作为 `expectedRevision` 自动带上
  - `writable`: provider 是否可写
  - `mode`: `'host' | 'memory'`（非 loopback 远端浏览器只能是 memory）
- **`set`/`unset` 不抛错**（见第 0 节 ③）→ **判活/判失败只能看快照**：
  ```js
  const snap = scope.getSnapshot()
  if (snap.status === 'unavailable') { /* 命名空间没被宿主注册（或远端浏览器）：整页渲染成“不可用”，不要渲染表单 */ }
  else if (snap.status !== 'ready') { /* 加载中 */ }
  ```
- 远端浏览器（非 loopback）**永远写不进去**（settings RPC 仅回环），官方包 README 明说：`A scope bound in a non-loopback browser starts unavailable and never crosses the wire`。此时设置页只能是只读/隐藏。

---

## 5. 原生设置页：slot 注册（实证的三种写法）

### 5.1 页面级（推荐给“设置”里的一个独立 tab）
`settings.section` 是 **list** slot，`scope: 'root'`，由 `sidebar.settings` 的 children 表声明：

`dsh-client-ui-settings-general\lib\client.js`：
```js
ctx.slots.inject("sidebar.settings", () => ctx.slots.register({
    name: "sidebar.settings",
    children: {
        "settings.trigger": { kind: "single", scope: "root" },
        "settings.header":  { kind: "single", scope: "root" },
        "settings.action":  { kind: "list",   scope: "root" },
        "settings.close":   { kind: "single", scope: "root" },
        "settings.section": { kind: "list",   scope: "root" },
        "settings.onboarding": { kind: "list", scope: "root" }
    },
    inject: shellInjected
}, SettingsRoot));
```
同文件里它自己注册 General 一页：
```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section", id: "general", order: 0,
    label: () => t("general.nav"),
    locale: NS,
    children: { "settings.general.item": { kind: "list", scope: "root" } }
}, GeneralSection));
```
shell 侧渲染（同文件）：
```js
children: active !== void 0 && renderSlot("settings.section", { close: onClose }, { only: active })
```
导航行完全来自注册项：
```js
rows = ctx.slots.entries("settings.section").map((e) => ({
    id: e.options.id ?? "", order: e.options.order ?? 0,
    label: resolveSlotLabel(e.options.label) ?? ""
})).sort((a, b) => a.order - b.order);
```

**第三方同构写法（零依赖模板，直接照抄改名字）：**
`dsh-any-background\lib\client.js`：
```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "dsh-any-background",
    order: 35,
    label: () => ctx.locale.bind(NS)("nav"),
    locale: NS,
    store,
    inject: sectionInject
}, ThemeSection));
```
`dsh-better-sidebar\lib\client.js`（连 `locale` 都不传）：
```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "better-sidebar",
    order: 100,
    label: () => t("settingsNav"),
    inject: () => ({ store: sidebarStore, service })
}, SideCardSection));
```
`@linxin666/dsh-client-ui-task-board\src\client\index.ts` 第 171-187 行（带 try/catch 与卸载）：
```ts
ctx.slots.inject('web-ui.plugin.item', () => {
  try {
    const unregister = ctx.slots.register({
      name: 'web-ui.plugin.item', id: 'task-board', order: 110,
      locale: NS, inject: () => settingsCard.inject(),
    }, TaskBoardSettingsCard)
    return () => { settingsCard.dispose(); unregister() }
  } catch { return () => {} }
})
```

### 5.2 关键规则（都有出处）
1. **必须先 `ctx.slots.inject(key, cb)`，在 cb 里再 `register`。** 直接 `register` 一个由别的 entry 声明的子 slot 会撞上“未声明”校验。源码注释（`dsh-better-sidebar\lib\client.js`）：
   > `Registering it directly races the declaration —— the ui-slots core's load-time validation throws "not declared (a parent entry's children table must declare it)" when the parent entry is not on the ledger yet. slots.inject waits for the declaration: the callback runs synchronously when the slot is already declared, otherwise it runs inside the declaring register() call once the declaration commits;`
   类型定义（`@deepseek-ai/dsh-client-runtime\lib\types\client\slots.d.ts` 第 85-90 行）同义。
2. **`inject` 可以返回任意 props**，框架把它与 `t` 一起注入组件。实证：`AppearanceRow({ t, setTheme, useStore })` ← `inject: injected` 返回 `{ setTheme }`；`SectionCard` ← `inject: () => ({ store, service })`；`SettingsDocumentAction({ controller, useSnapshot, t })` ← `inject: () => ({ controller, hooks: { snapshot } })`。
3. **`t` 从哪来**：注册时可给 `locale: NS`（NS 字典由 `ctx.locale.register(NS, {zh, en})` 注册），组件里就有了 `t`。第三方常用的替代写法是自己在闭包里 `const t = ctx.locale.bind(NS)`，`label: () => t("nav")` 直接用它——**两种都可以**（`dsh-better-sidebar` 就没传 `locale`）。
4. **`store` + `useStore` 机制**：官方主题/语言页传 `store: <handle>`，组件里用 `props.useStore(selector)`。handle 由 `defineStore({ init, actions })` 产生（`dsh-client-runtime\lib\client.js` 的 `defineStore`），且 `store` 实例由 renderer 通过 `storeOf(entry, scopeKey)` 解析（`dsh-client-runtime\lib\client.js` 的 `hostFace()`）。**这条路要 require `dsh-client-runtime/client`，可用但没必要**；因为未知的正是「handle 名 → `use<Name>` props 名」的映射细节（我没能找到源码确认，`@deepseek-ai/dsh-client-ui-slots` 不在磁盘上）。
   **推荐做法（绕开该未知）**：不传 `store`，自己在 `inject()` 里把 scope 交给组件，组件内用 React 自带 `useSyncExternalStore` 订阅：
   ```js
   const snap = React.useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot)
   ```
   `scope.subscribe` 与 `scope.getSnapshot` 是稳定的 `SettingsScope` 方法（同一文件 `subscribe(listener) { return this.store.subscribe(listener) }` / `getSnapshot() { return this.store.getSnapshot() }`）。
5. **`order` 取值现状**（避免与现有页撞号）：`general=0`、`agent-presets=20`、`dsh-any-background=35`、`better-sidebar=100`。建议 dsh-tts-voice 用 `order: 50`（可自选）。
6. **声明顺序无关**：`slots.inject` 会等你依赖的声明出现，所以你比 `ui-settings-general` 早 apply 也没问题。
7. **apply 里抛异常会炸整个 GUI**。第三方明确写了这条纪律（`@linxin666/dsh-client-ui-task-board\src\client\index.ts` 第 7-9 行）：
   > `Failure policy: DOM mounting problems are logged, never thrown — the web shell fails the whole boot when a plugin apply throws, and an external plugin must not take the GUI down.`
   所有 `ctx.slots.*`、DOM 操作都套 try/catch。

### 5.3 “插件配置”那一页（可选，另一种落点）
`settings.plugins.tab` 是 Plugins 设置区里的 tab slot；`settings.plugin.item` 是**按命名空间分发的卡片**（`dsh-client-ui-settings-plugins` 的 README：卡片按 Host 实际注册的命名空间派发，所以 out-of-tree 插件“注册命名空间 + 注册卡片”就能出现）。代价：卡片 chrome 属于该包，bundle 纯度门禁止把它当值导入 → 得自己实现表单；本仓库也不需要。**结论：走 5.1 的 `settings.section`。**

### 5.4 悬浮按钮：`shell.overlay`
`dsh-client-ui-layout\lib\client.js` 注册 `root` 时声明：
```js
children: {
    "sidebar": { kind: "single", scope: "root" },
    "conversation": { kind: "single", scope: "session-maybe" },
    "details": { kind: "single", scope: "session" },
    "shell.overlay": { kind: "list", scope: "root" }
}
```
所以现有的右下角悬浮胶囊应当改成 `ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-tts-voice', inject: () => ({...}) }, Pill))`，**不要再 tapIndex 注入 DOM**。注意 `dsh-client-runtime\lib\types\client\slots.d.ts` 第 21-31 行对 `root` 的警告（`shell.overlay` 是它推荐的“全屏浮层”落点，且默认 click-through，需要自己的 entry 主动开 pointer-events）。

---

## 6. 现有代码里要动的地方（映射表）

| 现状（文件:行） | 契约下应该变成 |
|---|---|
| `lib/index.js:36` `const inject = ['webServer']` | `['webServer', 'settings']`（settings 用 `ctx.inject` 更稳，保持 `inject=['webServer']` + `ctx.inject(['settings'], ...)` 也行） |
| `lib/index.js:450-455` `ctx.webServer.tapIndex(...)` 注入 `/dsh-tts/tts.js` | **删除**；客户端改由 boot 图加载 `lib/client.js` |
| `lib/index.js:438-448` 路由 `/dsh-tts/tts.js` | **删除**（不再需要服务脚本） |
| `lib/index.js:129-145` `cfg`（mute/ref/prompt/speed/voice 全来自 env） | 保留 env 作为组成默认值，另加 `ctx.settings.register(NS, Schema, { base: {...} })`；运行时配置读 `scope.watch()`（task-board 第 161-165 行的 `scope?.watch?.(() => sync())` 同构） |
| `lib/tts.js`（253 行 classic 注入脚本 + localStorage） | 重写为 `lib/client.js`：slot 注册 + React 渲染；mute/volume/voice 改由 settings scope 承载（localStorage 可留作 UI 偏好缓存，但**权威值在宿主**，否则远端浏览器会不一致） |
| 6 个 `/dsh-tts/*` 路由（state/audio/consumed/mute/voice） | 音频流继续用它们（同源 fetch 即可）；`mute`/`voice` 两个“写”路由**建议删掉**，改由 settings 承载，避免两套真相 |
| `package.json` | 加 `exports` + `dsh.client`（第 1 节模板） |

`webServer` 路由 API（`dsh-host-webserver\lib\types\index.d.ts` 第 32-40、79-85 行）：
```ts
export interface WebRoute { kind: 'exact' | 'prefix'; path: string; handler: (req, res) => void | Promise<void> }
register(route: WebRoute): () => void
```
现有代码用的就是它（`lib/index.js:359-448`），无需改。

---

## 7. 朗读文本从哪来（客户端侧待定项）

- 现状：**宿主**监听 `session/event` 的 `assistant/chunk` → `text-delta`（`lib/index.js:339-349`、`353-355`）。这套不依赖客户端插件，**可以原样保留**：宿主合成好音频，客户端只负责拉取播放。
- 客户端若想自己拿助手文本，本任务范围内**没有查实到**一个公开的“订阅 session 文本增量”的客户端 API：
  - `ctx.sessions` / `ctx.slots` / `ctx.conversationEvents` 等都经 `dsh-client-runtime/client` 暴露（`dsh-client-runtime\lib\types\client\index.d.ts` 第 108-118 行声明了 `slots` / `conversationEvents` / `conversationViews` / `sessions` / `workspaces`，`SessionStandardProps.useSession` 提供会话快照），`@deepseek-ai/dsh-client-connection` 承载 wire；
  - 但我没有找到 `session/event` 在浏览器侧的等价订阅口（30 秒内没有定位到）。**建议保持“宿主切句 + 客户端播放”的分工**，把客户端权限限制在 UI 与设置上。

---

## 8. 结论速查（给工程师的 checklist）

1. `package.json` 加 `exports["./client"]` + `dsh.client{platform:'web'}`；`lib/client.js` 必须是 `window.__ModuleLoader__.load({id:'dsh-tts-voice', factory})` 的 classic script。
2. bundle 内只 require 种子表里的东西（`react` / `react/jsx-runtime` / `react-dom/client` / `@deepseek-ai/dsh-client-ui-primitives`），或再加 `@deepseek-ai/dsh-client-runtime/client`（parser-preload）。**绝不要 require `@deepseek-ai/dsh-client-store`。**
3. `exports.apply(ctx)` 里：`ctx.locale.register(NS, {zh,en})` → `ctx.settingsScope.bind({namespace:'dsh-tts-voice'})` → `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'dsh-tts-voice', order:50, label:()=>t('nav') }, VoiceSection))`；悬浮胶囊改挂 `shell.overlay`。
4. **宿主侧必须** `ctx.inject(['settings'], (c) => c.settings.register(settingsNamespace('dsh-tts-voice'), Schema, { base }))`，否则设置页永远是 `unavailable`，且 `set()` 静默失败。
5. UI 判活只看 `scope.getSnapshot().status`：`ready` 渲染表单 / `unavailable` 渲染“不可用” / 其它渲染加载态；绝不假设 `set()` 抛错。
6. `apply` 全程 try/catch，任何 UI 失败只 `console.error`，不要冒泡（否则整个 GUI 起不来）。
7. 全部 `ctx.slots` 注册都用 `inject` 包裹，卸载时 dispose（HMR 安全）。
8. 改完声明**重启 `dsh web`**，刷新浏览器；用 `GET http://127.0.0.1:3080/` 搜 `dsh-tts-voice` 确认它进了 `__DSH_BOOT__`，并 `GET /plugins/dsh-tts-voice/client.js?rev=...` 确认 200。

---

## 9. 明确「没查到」的部分（不要在这上面瞎试）

| 悬而未决 | 说明与替代路径 |
|---|---|
| `@deepseek-ai/dsh-client-ui-slots` 的完整类型面（`SlotCore.register` 全部选项、`PropsStore` 的 handle→`use<Name>` 映射、`InjectFace`/`PropsLocale` 精确形状） | **磁盘上没有这个包**，只有 shell 内嵌的 `g6` 变量与散落在各 bundle 的 type-only 引用。替代：本笔记用 4 个真实注册样例（官方 theme/locale/general + 第三方 any-background/better-sidebar/task-board）反推，**不要传 `store`**，改用 `useSyncExternalStore` 自订阅。 |
| 浏览器侧 `session/event` 等价订阅口 | 见第 7 节：保持宿主切句。 |
| `dsh-any-background` 的 require 失败是否被 contained | 未在浏览器里验证；不影响我们的方案（我们不依赖它）。 |
| `settings.section` 页在远端（非 loopback）浏览器里的表现 | 已知 settings RPC 仅回环 → scope `unavailable`；UI 需自己降级。 |

---

## 附：本机实测原始数据（可复现）

- boot 图：`GET http://127.0.0.1:3080/` → `<script>globalThis["__DSH_BOOT__"] = {"rev":"c7321a4c31b5","entries":[…54 项…]}</script>`，无 tts 行。
- 发现链探针：`node F:\MyCode\dsh-desktop\docs\.probe-client-contract.mjs`（只读脚本，复刻 `resolveMeta`；dsh-tts-voice 目前返回 `no dsh.client{platform:web}`）。
- 静态种子表：`dsh-web-frontend\dist\assets\index-ClqxG24t.js` 中 `function Jd(){return{react:…,"@deepseek-ai/dsh-client-ui-primitives":Kd}}`。
- 关键 5 环源码行：`dsh-settings\lib\index.js`（`is not registered` / `NAMESPACE_PATTERN` / `register(` / `describe(`）、`dsh-host-apiproxy\lib\index.js`（`settings-rejected` + 三条路由）、`ui-settings\lib\client.js`（`write(op)` / `derive()` / `SettingsSchemaService`）、`@deepseek-ai\dsh-client-modules\lib\index.js`（`resolveMeta` / `MissingClientBundleError` / `bootInjections`）。

---
---

# 附录 A（第二轮补挖）：三项优先事项的完整证据

> 本节是第二轮调研的新增内容，与正文不重复，可直接照抄。所有引用均为本机实测源码；推断单列。

## A1. 宿主侧设置命名空间的注册契约

### A1.1 完整签名

`@deepseek-ai/dsh-settings` 的 `ctx.settings.register(ns, schema, options?)`（`dsh-settings\lib\index.js`）：

```js
register(ns, schema, options) {
    if (this.registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`);
    const registration = {
        ns, schema,
        base: options?.base,
        applies: options?.applies ?? "live",
        ...options?.validate === void 0 ? {} : { validate: options.validate },
        resolved: deepFreeze(this.resolve(schema, options?.base, this.section(ns), options?.validate)),
        revision: 0,
        watchers: new Set()
    };
    this.ctx.effect(() => {
        this.registrations.set(ns, registration);
        return () => this.registrations.delete(ns);
    }, `settings.register(${JSON.stringify(String(ns))})`);
    return {
        get: () => registration.resolved,
        watch: (callback) => { /* → 返回 unwatch 函数 */ },
        update: (patch) => this.update(ns, patch),
        replace: (section) => this.replace(ns, section)
    };
}
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ns` | `string`（须匹配命名空间模式） | ✅ | 重复注册**直接抛** `already registered` |
| `schema` | **schemastery schema**（见 A1.2） | ✅ | 随描述符 `schema.toJSON()` 下发浏览器，客户端用它 rehydrate + 校验 |
| `options.base` | 纯对象 | ❌ | 组成层默认值（在 schema 默认值之上、用户文档之下） |
| `options.applies` | `string`，默认 `'live'` | ❌ | 随描述符透出 |
| `options.validate` | `(value) => string \| undefined` | ❌ | schema 表达不了的自定义校验；返回文本 = 失败 |

返回值（宿主侧 `SettingsScope`）只有 4 个成员：`get()` / `watch(cb)` / `update(patch)` / `replace(section)`。**没有 `set/unset`**——那是浏览器侧才有的。

**命名空间模式**有两代写法，都要注意：

```js
// 0.1.1-rc.2（本机版本）：导出 settingsNamespace() 帮你校验并打品牌
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
function settingsNamespace(value) {
    if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
    return value;
}
```
```js
// 新版（0.1.2-alpha.2+）上游删掉了 settingsNamespace 与 installSettingsSection 导出；
// 第三方 dshmarket\lib\settings.js:54-65 的做法是就地校验，别 import：
const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MARKET_SETTINGS_NS = 'dsh-market';
if (!NAMESPACE_PATTERN.test(MARKET_SETTINGS_NS)) throw new TypeError(...);
```
`'dsh-tts-voice'` 在两代模式下都合法。**兼容建议**：像 `dshmarket` 那样**就地校验 + 不 import `settingsNamespace`**，同时不要使用 `installSection`——见 A1.4 的踩坑记录。

### A1.2 schema 是 **schemastery**，不是 zod。字段怎么声明

包：`@deepseek-ai/schemastery`（v3.18.2，`lib/index.mjs` / `lib/index.cjs`，`exports` 同时提供 `import` 与 `require`）。默认导出就是工厂对象 `Schema`（`lib\types\index.d.ts:198` `declare const Schema: Schemastery.Static; export default Schema;`）。

**静态工厂**（`lib\types\index.d.ts:40-86`）：
```
any() never() const(v) string() number() natural() percent() boolean() date() regExp() arrayBuffer() bitset() function()
is(ctor) array(inner) dict(inner, sKey?) tuple(list) object(dict) union(list) intersect(list) transform(inner, cb) lazy(cb)
```

**实例方法**（同文件 147-189，含 UI 元数据，表单渲染器会读）：
```
required(v?) hidden(v?) loose(v?) role(text, extra?) link(url) default(v) comment(t) description(t)
disabled(v?) collapse(v?) deprecated() experimental() pattern(re) max(n) min(n) step(n)
set(k, s) push(s) simplify(v?) i18n(msgs) extra(k, v) toJSON() toString(inline?)
```

`Meta` 里可用的元数据字段（同文件 98-121）：`default, required, disabled, collapse, badges, hidden, loose, role, extra, link, description, comment, pattern, max, min, step`。

**对 dsh-tts-voice 直接可抄的 schema**（布尔开关 + 枚举 + 0..1 范围 + 字符串）：
```js
import z from '@deepseek-ai/schemastery'

export const VOICE_IDS = ['yeshu', 'yinlang']
export const TTS_SETTINGS_NS = 'dsh-tts-voice'

export const TtsSettings = z.object({
  enabled: z.boolean().default(true),
  voiceId: z.union(VOICE_IDS).default(VOICE_IDS[0]),      // 枚举用 z.union([...]) —— 官方 theme/locale 就是这么写
  volume:  z.number().min(0).max(1).step(0.05).default(1), // 或 z.percent()（注释写明“mark it as a slider”）
  speed:   z.number().min(0.5).max(2).step(0.05).default(1),
  mode:    z.union(['conclusion', 'maxSentences', 'all']).default('conclusion'),
  maxSentences: z.natural().min(1).max(10).default(3),
})
  .description('语音朗读：开关、音色、音量、语速与朗读范围')
```
> 语义提醒（来自 `z.object` 的类型定义 `ObjectS<X> = { [K in keyof X]?: … }`）：**每个字段都是可选的**，缺省时由 `.default()` 补。而这正是“未在 `user` 层出现 = 用户没覆盖”这个判定的基础。

**最小证据（本机真实调用）**：

1. `@linxin666/dsh-client-ui-task-board\src\index.ts:40,66-73,154-169`（带 `{ base }` + `watch` + 版本兼容双分支）：
```ts
export const TASK_BOARD_SETTINGS_NAMESPACE = 'task-board' as SettingsNamespace
export const Config: z<Config> = z.object({
  announceToAgent: z.boolean().default(false),
  enabled: z.boolean().default(true),
  preventIdleSleep: z.boolean().default(false),
  trustedProxyHosts: z.array(z.string()).default([]),
  proxyTokenEnv: z.string().min(1).default(DEFAULT_PROXY_TOKEN_ENV),
  sessionDefaultPermission: z.union(TASK_PERMISSIONS).default(DEFAULT_SESSION_PERMISSION),
})
// ...
ctx.inject(['settings'], (settingsCtx) => {
  try {
    if (typeof settingsCtx.settings?.installSection === 'function') {
      settingsCtx.settings.installSection(ctx, TASK_BOARD_SETTINGS_NAMESPACE, Config, config ?? {}, {
        setSource: (source) => { current = source }, onChange: sync,
      })
    } else if (typeof settingsCtx.settings?.register === 'function') {
      const scope = settingsCtx.settings.register(TASK_BOARD_SETTINGS_NAMESPACE, Config, { base: config ?? {} })
      current = () => scope?.get?.() ?? (config ?? {})
      scope?.watch?.(() => { sync() })
    }
  } catch { /* 版本差异兜底 */ }
})
```

2. `dshmarket\lib\settings.js:54-68,81-108`（**最贴近我们需求的样板**：一个布尔开关 + `inject` 优雅降级 + in-place 生效）：
```js
import z from '@deepseek-ai/schemastery'
export const MarketSettings = z.object({ allowRestart: z.boolean().default(true) })

export function installMarketSettings(ctx, resolved) {
    const entry = { allowRestart: restartAllowed(resolved) }
    let source = () => entry
    const apply = () => { resolved.allowRestart = source().allowRestart }
    // `inject` is the graceful-degradation boundary: on a host with no
    // settings service the callback never runs and the composed entry stands.
    ctx.inject(['settings'], (scopedCtx) => {
        const scope = scopedCtx.settings.register(MARKET_SETTINGS_NS, MarketSettings, { base: entry })
        source = () => scope.get()
        scopedCtx.effect(() => () => { source = () => entry; apply() })   // unload 还原
        apply()
        scope.watch(apply)                                                // 改动即时生效
    })
}
```
同文件第 43-52 行还记着一条上游破坏性变更，务必避开：
```
 *   SyntaxError: The requested module '@deepseek-ai/dsh-settings' does not
 *   provide an export named 'installSettingsSection'
 * ... `sctx.settings.register(ns, schema, { base })` is identical in 0.1.0-rc.7 and 0.1.2-alpha.2.
 * Only the two wrappers went away.
```

3. `deepseek-harness-zh_pro\lib\chinese-prompt.js:36-56,66-75`（**7 个字段 + `{ applies: 'live' }` + schemastery 懒加载**）：
```js
const z = loadSchemastery()
const scope = settings.register(ZH_SETTINGS_NS, z.object({
    zhPrompt: z.boolean().default(false),
    zhPromptText: z.string().default(ZH_PROMPT_TEXT),
    zhPromptTarget: z.string().default(ZH_PROMPT_TARGET_SYSTEM),
    zhAutoArchiveDays: z.number().default(ZH_AUTO_ARCHIVE_DAYS_DEFAULT),
    zhAgentPrompt: z.boolean().default(false),
    zhToolDesc: z.boolean().default(false),
    zhContextInject: z.boolean().default(false),
}), { applies: 'live' });
const current = scope.get();
const unwatchSettings = scope.watch(function (next) { /* 同步进本包状态 */ });
ctx.effect(function () { return unwatchSettings; }, 'dsh-zh: prompt settings watch');
```
它的 schemastery 加载方式（`lib\schemastery.js:11-27`）值得抄，因为它**不显式依赖** schemastery：
```js
const requireFromProfile = createRequire(join(localProfileDir(), 'package.json'));
const mod = requireFromProfile('@deepseek-ai/schemastery');
schemasteryCache = mod?.default !== undefined ? mod.default : mod;
```
实测：从 profile 的 require 上下文可解析到 `@deepseek-ai/schemastery` → `...\@deepseek-ai\dsh\node_modules\@deepseek-ai\schemastery\lib\index.cjs`；也可以直接用 profile 里的 `schemastery`（`C:\Users\35756\.dsh\profiles\web\node_modules\schemastery`，v3.18.1）。**两者都可 import；推荐 `@deepseek-ai/schemastery` 并 try/catch 降级。**

### A1.3 客户端 `ctx.settingsScope.bind({ namespace })` 的全部形状

初始化（`ui-settings\lib\client.js` `SettingsScopeController` 构造函数）：
```js
this.store = createSnapshotStore({
    status: persistence === "host" ? "loading" : "unavailable",
    value: void 0, base: void 0, user: void 0, revision: void 0,
    writable: false, mode: persistence
});
if (persistence === "host") { this.unsubscribe = mirror.subscribe(() => this.derive()); this.derive(); }
```
`persistence` 来自 `connection.isLoopback ? 'host' : 'memory'`（`ui-settings\lib\client.js` 的 `apply`：`new SettingsDescribeMirror(connection.api, connection.isLoopback ? "host" : "memory")`）。

**`getSnapshot()` 返回**（`derive()` 逐字段赋值）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `status` | `'loading' \| 'ready' \| 'unavailable'` | 初始 `'loading'`（host）或 `'unavailable'`（memory）。`ready` = 宿主已注册且值通过本地校验；**`unavailable` = 宿主没注册这个命名空间** |
| `value` | `T \| undefined` | 解析后的 section；`status` 不 `ready` 时恒 `undefined` |
| `base` | 对象 \| `undefined` | 组成层（`register` 的 `options.base`） |
| `user` | 对象 \| `undefined` | 原始用户层 —— **字段出现在这里才表示“用户覆盖过”**（官方 README 原文） |
| `revision` | `number \| undefined` | 命名空间级单调计数（对**原始** section 计数） |
| `writable` | `boolean` | provider 是否可写（与命名空间是否存在无关） |
| `mode` | `'host' \| 'memory'` | 远端浏览器恒 `'memory'` |

`derive()` 关键分支（正文已引，此处补全）：
```js
if (view === void 0) { this.store.update((draft) => { draft.status = "unavailable"; draft.writable = writable; }); return; }
const decoded = this.decode(view);
this.store.update((draft) => {
    draft.revision = view.revision; draft.base = view.base; draft.user = view.user; draft.writable = writable;
    if (decoded === void 0) return;                       // ← 校验失败：status 保持原值，value 不更新
    draft.status = "ready"; draft.value = decoded;
});
decode(view) {
    if (this.spec.decode !== void 0) return this.spec.decode(view.value);
    if (typeof view.value !== "object" || view.value === null || Array.isArray(view.value)) return void 0;
    let failure;
    try { failure = this.schema.validate(this.schema.rehydrate(view.schema), view.value); }
    catch (_malformedSchemaEnvelope) { return; }
    return failure === void 0 ? view.value : void 0;
}
```

**写入方法（名字与签名）**：

| 方法 | 签名 | 说明 |
|---|---|---|
| `scope.set` | `set(field: string, value: unknown): Promise<void>` | 内部发 `{op:'set', path:[field], value}`。**只能写顶层标量字段**（`path: [field]`） |
| `scope.unset` | `unset(field: string): Promise<void>` | 内部发 `{op:'unset', path:[field]}` —— 清除用户覆盖、回落到 `base`/默认值（表单的「重置」就是它） |
| `scope.subscribe` | `subscribe(listener: () => void): () => void` | 直接转发内部 store 的订阅 |
| `scope.getSnapshot` | `getSnapshot(): SettingsScopeSnapshot<T>` | 变更之间引用稳定（可安全喂给 `useSyncExternalStore`） |
| `scope.dispose` | `dispose(): Promise<void>` | 之后的写入变成 no-op |

**乐观锁**：`expectedRevision` **不经过调用方**，客户端自动带上：
```js
write(op) {
    const generation = ++this.writeGeneration;
    return this.enqueue(async () => {
        const revision = this.pendingRevision ?? this.getSnapshot().revision;
        let response;
        try {
            response = await this.api.settings.mutate({
                ns: this.spec.namespace, ops: [op],
                ...revision === void 0 ? {} : { expectedRevision: revision }
            });
        } catch (_settingsWriteFailure) { await this.recover(generation); return; }
        if (!response.result.ok) { await this.recover(generation); return; }
        if (this.disposed) return;
        if (generation === this.writeGeneration) { this.pendingRevision = void 0; this.mirror.acceptView(response.result.value); }
        else this.pendingRevision = response.result.value.revision;
    });
}
```
宿主侧冲突时抛 `SettingsConflictError`（`code: 'SETTINGS_CONFLICT'`，两侧 revision 都带上），被 RPC 折成失败结果 → 客户端同样只是 `recover()` 重读，**不抛**。

### A1.4 ★ 明确回答：客户端对宿主未注册 schema 的命名空间能否写入？

**不能。而且有 4 条静默失败路径 —— 全部 `await` 都不会 reject。**

`enqueue` 的前两行就是第 4 条：
```js
enqueue(operation) {
    if (this.persistence === "memory" || this.disposed) return Promise.resolve();   // ← 直接 resolve，什么都不做
    const task = this.tail.then(async () => { if (this.disposed) return; await operation(); });
    this.tail = task.catch(() => {});
    return task;
}
```

| # | 触发条件 | 宿主发生什么 | 浏览器 `await scope.set()` 的表现 |
|---|---|---|---|
| 1 | 命名空间未注册 | `dsh-settings` `write()` 抛 `settings namespace "X" is not registered` → apiproxy 折成 `code:'settings-rejected'` | **resolve**（`!response.result.ok` → `recover()` → return） |
| 2 | `expectedRevision` 过期 | 抛 `SettingsConflictError` | **resolve**，同上 |
| 3 | scope 已 `dispose()` | 请求根本不发 | **resolve** |
| 4 | `mode === 'memory'`（非 loopback 浏览器） | 请求根本不发 | **resolve** |

**因此唯一可靠的判活信号是 `getSnapshot().status`**：
- `'ready'` → 渲染表单
- `'unavailable'` → **宿主没注册该命名空间**（或远端浏览器）→ 渲染“不可用 / 未启用”，**不要渲染可编辑控件**
- `'loading'` → 加载中

### A1.5 对 dsh-tts-voice 的建议（已核对 engineer 当前实现）

engineer 现在选的是**方案 B（插件自己的 HTTP）**，实现是自洽的：
- `lib\settings.js` 是唯一真源（`F:/AI/GPT-SoVITS/dsh-tts-voice.json`，原子写 + 损坏文件改名保留）
- 客户端 `localStorage`/`dshttss` 残留**计数为 0**（旧的双真相已清除）
- 客户端只调 `/dsh-tts/settings`（POST patch）与 `/dsh-tts/state`（轮询），`ctx.settingsScope` **0 次调用**

**这个选择在契约上完全合法**（`enqueue` 的 memory 分支说明：不 bind 就没有任何跨端假设）。唯一代价是：设置不会出现在「设置 → 插件配置」的按命名空间卡片里（那一页由 `dsh-client-ui-settings-plugins` 按宿主实际注册的命名空间派发）。

若之后想升级为方案 A（进插件配置页 / 拿到 revision 与 `user` 覆盖语义），**必须先在宿主侧 `register`**，宿主注册后现有的 HTTP 路由可以保留作为音频流通道，但配置值应改为以 settings 为唯一真源，避免两套真相。另外要注意：宿主 `register` 的 `base` 建议来自现在的 `sanitize(DEFAULTS)`，并把 `enabledAt` 这类内部字段用 `.hidden(true)` 从表单里藏掉。

## A2. `settings.section` 的组件契约

### A2.1 `SlotCore.register` 的完整校验与选项规范化（**实测源码**）

`SlotCore` 在浏览器里由 shell 播种（`const g6=Object.freeze({__proto__:null,SlotCore:m6,SlotOwnershipError:p6,StaleAuthorizationError:h6,resolveSlotLabel:C6})`），其 `register` 的校验逻辑（`dsh-web-frontend\dist\assets\index-ClqxG24t.js`，`SlotCore.register(n,i)`，`i` = Component）：

```js
register(n, i) {
  const l = this.records.get(n.name);
  if (!(l != null && l.spec))
    throw new Error(`slot "${n.name}" is not declared (a parent entry's children table must declare it)`);
  const u = l.spec, c = n.priority ?? 0;
  const d = (m) => `at priority ${c}${m.registrant !== void 0 ? ` (registered by ${m.registrant})` : ""} — register at a different priority to shadow it (lowest renders)`;
  switch (u.kind) {
    case "single": {
      const m = l.entries.find((g) => (g.options.priority ?? 0) === c);
      if (m) throw new Error(`single slot "${n.name}" already has a registration ${d(m)}`);
      break;
    }
    case "keyed": {
      if (n.key === void 0) throw new Error(`keyed slot "${n.name}" requires options.key`);
      const m = l.entries.find((g) => g.options.key === n.key && (g.options.priority ?? 0) === c);
      if (m) throw new Error(`keyed slot "${n.name}" already has an entry for key "${n.key}" ${d(m)}`);
      break;
    }
    case "list": {
      if (n.id === void 0) throw new Error(`list slot "${n.name}" requires options.id`);      // ← settings.section 是 list
      const m = l.entries.find((g) => g.options.id === n.id && (g.options.priority ?? 0) === c);
      if (m) throw new Error(`list slot "${n.name}" already has an entry with id "${n.id}" ${d(m)}`);
      break;
    }
    case "chain":
      if (n.select === void 0) throw new Error(`chain slot "${n.name}" requires options.select`);
      break;
  }
  if (n.children) for (const m of Object.keys(n.children)) {
    const g = this.records.get(m);
    if (g != null && g.spec) throw new Error(`slot "${m}" is already declared (by ${g.declaredBy ?? "an unknown entry"})`);
  }
  if (n.store !== void 0 && typeof n.store != "function") {
    const m = this.handleScopes.get(n.store);
    if (m && m.scope !== u.scope) throw new Error(`store handle mounted under "${n.name}" (scope "${u.scope}") is already mounted under scope "${m.scope}" — one handle, one scope`);
    m ? m.count += 1 : this.handleScopes.set(n.store, { scope: u.scope, count: 1 });
  }
  const h = { component: i, options: { ...n.key!==void 0?{key:n.key}:{}, ...n.id!==void 0?{id:n.id}:{}, ...n.order!==void 0?{order:n.order}:{},
    ...n.label!==void 0?{label:n.label}:{}, ...n.priority!==void 0?{priority:n.priority}:{} }, ...n.select!==void 0?{select:n.select}:{},
    ...n.inject!==void 0?{inject:n.inject}:{}, ...n.children!==void 0?{children:n.children}:{}, ...n.store!==void 0?{store:n.store}:{}, ...n.locale!==void 0? …
```
由它可直接读出的事实：
- `settings.section` 是 **list** → **`id` 必填**，否则抛 `list slot "settings.section" requires options.id`；同一 `id` + 同一 `priority` 再注册会抛 “already has an entry with id”。
- 只有 `key / id / order / label / priority` 进 `options`（`entries("settings.section")` 读 `e.options.label/order/id` 与源码一致）。
- `inject` / `children` / `store` / `select` / `locale` / `registrant` 单独挂载（不是 `options` 的子字段）。
- `resolveSlotLabel(n)` 的实现就一行：**`function C6(n){return typeof n=="function"?n():n}`** —— 所以 `label` 可以是字符串或**惰性函数**；写成函数的意义是「locale 变了要重算」，这正是 shell 把 `locale` 的 revision 也纳入快照版本判断的原因（`version !== rowsVersion || revision !== rowsRevision` 才重算导航行）。

### A2.2 Component 收到的 props 到底有哪些

三块合成（每一块都有实证样例）：

1. **框架标准 props**：`renderSlot(key, ownerProps, opts?)` 把 **owner props** 传给条目。settings 页的 owner 就是 `SettingsSectionOwnerProps = { close: () => void }`（`dsh-client-ui-settings\lib\types\client\contract\slots.d.ts:148-151`），shell 调用处：
   ```js
   children: active !== void 0 && renderSlot("settings.section", { close: onClose }, { only: active })
   ```
   → **`close` 是唯一由 shell 供应的 owner prop**，用来“离开设置面板”（例如从设置页启动一个会话后关闭）。
2. **`inject` 的返回值**：`inject` 是**函数**，其返回对象被并入 props。实测三例：
   - `AppearanceRow({ t, setTheme, useStore })` ← `inject: injected`，`injected = (actions) => { bound = actions; …; return { setTheme: (id) => … } }`（`dsh-client-ui-theme\lib\client.js`）
   - `SideCardSection` ← `inject: () => ({ store: sidebarStore, service })`（`dsh-better-sidebar\lib\client.js`）
   - `SettingsDocumentAction({ controller, useSnapshot, t })` ← `inject: documentInjected`（`dsh-client-ui-settings-general\lib\client.js`）
   
   ⚠️ **必须是对象**。写成 `inject: () => () => {}`（返回函数）等于没注入任何 props（本仓库 `lib\client.js:376` 就是这个形状，当前无害因为组件不接 props）。若注入的对象里有 `store`，是按名展开成 props 的。
3. **`t` 本地化函数**：`locale: NS` + 该 NS 已 `ctx.locale.register(NS, {zh, en})` → 组件拿到 `t`。`label` 与 `t` 配合的两种官方写法：
   ```js
   // 写法一（官方 theme/locale/general）：注册时给 locale，label 用该 NS 的绑定
   const t = ctx.locale.bind(NS)                       // dsh-client-ui-settings-general
   label: () => t("general.nav")
   // 写法二（第三方 any-background）：label 里现场 bind
   label: () => ctx.locale.bind(NS)("nav")
   ```
   `t` 的字典来自 `ctx.locale.register(NS, { zh: {...}, en: {...} })`；⚠️ 从 `dsh-tts-voice\lib\client.js:359-362` 的字典看，**值必须是字符串或嵌套字典**，写成 `{ zh: { nav: '语音' } }` 只有一个 key 时 `t('nav')` 才能命中（本仓库当前写法正确）。

### A2.3 `store` 字段：**不必传**（推荐不传）

- 形状：`defineStore({ init, actions })` 的产物 handle（`dsh-client-runtime\lib\client.js` 的 `defineStore` 返回 `{ spec, create(scopeKey) }`；`create` 返回 `{ actions, getSnapshot, subscribe, store, clearPersisted }`）。
- 框架侧：`SlotRegistry._register` 里 `const store = typeof options.store === "function" ? options.store() : options.store;` —— 所以它**接受 handle 或返回 handle 的函数**，随后交给 renderer：`hostFace()` 暴露 `storeOf: (entry, scopeKey) => entry.store === void 0 ? void 0 : this.resolveStore(entry.store, scopeKey)`。
- `resolveStore` 约束：`if (record === void 0) throw new Error("store handle is not registered (entry unloaded, or the handle never went through register)")`；scope 与 slot 不匹配会抛 `one handle, one scope`。
- **props 里的 `useStore` 不在 runtime 里**（`dsh-client-runtime\lib\client.js` 里 `useStore` 出现 0 次）——它在 `@deepseek-ai/dsh-client-ui-primitives`（shell 播种）里实现，是渲染器把 handle 变成 `use*` hook。**该 hook 名由 handle 怎么决定，我没有找到源码，故不写死。**
- **结论**：`store` 是可选项。**不需要 store 语义就别传**，把 `inject` 返回的 `scope` 交给组件、组件内用 React 自带 `useSyncExternalStore` 订阅（`scope.subscribe` 稳定、`getSnapshot` 引用稳定）。这样零未验证依赖。

### A2.4 可直接粘贴的最小 React 骨架（约 55 行；开关 + 滑杆）

> 依赖：`require('react')` 与 `require('react/jsx-runtime')` —— 两者都在 shell 播种表里，**无需 `dsh.client.external`**。
> 该骨架**同时兼容方案 A / 方案 B**：它只依赖一个 `{ scope }` props（settings）或 `{ state, patch }`（HTTP），下面用 settings 版演示，HTTP 版改 `inject` 与两处取值即可。

```js
const react = require('react')
const { jsx, jsxs } = require('react/jsx-runtime')

const NS = 'dsh-tts-voice'

/** 只读订阅一个 SettingsScope；getSnapshot 引用稳定，可直接喂 useSyncExternalStore。 */
function useScope(scope) {
  return react.useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot)
}

/** 设置页一页：开关 + 音量滑杆。 */
function VoiceSection(props) {
  const { t, scope, close } = props
  const snap = useScope(scope)
  const [busy, setBusy] = react.useState(false)

  if (snap.status === 'unavailable') {
    // 宿主没注册这个命名空间（或远端浏览器）：渲染只读降级，不渲染可编辑控件
    return jsx('p', { className: 'tts-muted', children: t('unavailable') })
  }
  if (snap.status !== 'ready') {
    return jsx('p', { className: 'tts-muted', children: t('loading') })
  }

  const value = snap.value ?? {}
  const overridden = (field) => snap.user !== undefined && field in snap.user   // 出现在 user 才叫「用户覆盖过」
  const write = (field, v) => { setBusy(true); scope.set(field, v).finally(() => setBusy(false)) }
  const reset = (field) => { setBusy(true); scope.unset(field).finally(() => setBusy(false)) }

  return jsxs('div', {
    className: 'tts-settings',
    children: [
      jsx('label', { className: 'tts-row', children: [
        jsx('input', {
          type: 'checkbox', checked: value.enabled !== false, disabled: busy || !snap.writable,
          onChange: (e) => write('enabled', e.target.checked),
        }),
        jsx('span', { children: t('enabled') }),
        overridden('enabled') && jsx('button', { type: 'button', onClick: () => reset('enabled'), children: t('reset') }),
      ] }),
      jsx('label', { className: 'tts-row', children: [
        jsx('span', { children: t('volume') }),
        jsx('input', {
          type: 'range', min: 0, max: 1, step: 0.05,
          value: typeof value.volume === 'number' ? value.volume : 1,
          disabled: busy || !snap.writable,
          onChange: (e) => write('volume', Number(e.target.value)),
        }),
        jsx('span', { children: Math.round((value.volume ?? 1) * 100) + '%' }),
      ] }),
      jsx('button', { type: 'button', onClick: close, children: t('close') }),
    ],
  })
}

/** 注册进「设置」导航。 */
function registerSection(ctx, scope) {
  const t = ctx.locale.bind(NS)
  return ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NS,                       // list slot：必填
    order: 50,                    // general=0 / agent-presets=20 / any-background=35 / better-sidebar=100
    label: () => t('nav'),        // 函数：locale 切换时 shell 会重算
    locale: NS,                   // 让组件拿到 t
    inject: () => ({ scope }),    // ★ 必须是对象；这里把 scope 注入组件
  }, VoiceSection))
}
```
要点复述（每条都有 A2.1-A2.3 的出典）：`id` 必填；`label` 可为函数；`inject` 必须返回对象；`locale` 让组件拿到 `t`；`close` 来自 owner props；**不传 `store`**；`status !== 'ready'` 时不要渲染可编辑控件。

## A3. `dsh.client.external` 与 `dsh.client.inject` 的确切差别

### A3.1 两者在源码里的定义（`dsh-client-modules\lib\types\client\manifest.d.ts:47-60`）

```ts
export interface WebBootEntry {
    id: string;              // Entry name == package name。
    url: string;             // Bundle endpoint, '/plugins/<id>/client.js?rev=<rev>'。
    rev: string;             // Bundle content hash
    /** Package-name dependency edges, informational (preflight display / HMR diffing). */
    inject?: string[];
    /** Stage-one prefetch mark */
    immediately?: boolean;
    /** Non-baseline module specifiers this row requests; omitted when it requests none. */
    external?: string[];
}
```

| | `dsh.client.inject` | `dsh.client.external` |
|---|---|---|
| 语义 | **包名**依赖边，**仅信息性**（preflight 展示 / HMR diff） | **模块说明符**边；因为 `require` 是同步的，它**约束代码到达顺序** |
| 影响运行时？ | **否** | **是**：写进图的行会让宿主把被请求的包行排在前面（`orderByModuleGraph`） |
| 需要包含什么 | 你依赖的**其它客户端插件包名**（`@deepseek-ai/dsh-client-ui-settings` 这种），以及 `dsh.client.inject` 里你也可以写 cordis 服务名，仅用于展示 | **超出「平台种子表 + parser-preload」的 specifier**，即你的 `require(...)` 用到的、不在种子表里、但由另一个 `dsh.client` 包与你的行**同时加入图**的那种 |
| 漏写后果 | 无运行时后果（只是诊断信息少一行） | 同步 `require` 抛错（见 A3.2） |

**平台种子表**（无需 external、无需 inject，`require` 直接命中）：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`。
**parser-preload**（HTML 无条件先加载，所以在首次 import 前 factory 已注册）：`@deepseek-ai/dsh-client-modules`、`@deepseek-ai/dsh-client-runtime` —— 因此 `require('@deepseek-ai/dsh-client-runtime/client')` 也**不必**写 external。

### A3.2 漏写 `external` 会发生什么（报错原文）

`dsh-client-modules\lib\client.js` 共两处：

```js
// 同步 require（交给 factory 的那个 require 函数）
throw new Error(`client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)`);

// 异步 import（顶层解析入口）
throw new Error(`client-modules: cannot resolve "${specifier}" — not a seed word, not a materialized module, and not a row in the boot graph (the runtime mirror of the bundle purity gate)`);
```
同文件还有几条相关的：
```js
throw new Error(`client-modules: no registered factory for "${id}"`);
throw new Error(`client-modules: require cycle through "${id}" (factory-form CJS cannot deliver partial exports)`);
throw new Error(`client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`);
```

**同步 require 抛错的后果**：它发生在 factory **materialize** 期间 → 该 entry 的 import 失败（`entry.fiber` 起不来）。**[推断]** 失败是否被 shell 的 boot 失败卡片 contain（而不是整页崩溃）取决于 loader 的 entry 级容错；第 3 节记录的重复注册是**明确整页崩**（抛在 `create()` 里），二者不是一回事。
**对 specifier 形状的处理**：`stripClientSuffix` 让 `<pkg>/client` 与 `<pkg>` 等价（`function stripClientSuffix(spec){ return spec.endsWith("/client") ? spec.slice(0,-7) : spec }`），所以 external 里写 `@foo/bar/client` 也能匹配到 `@foo/bar` 那行。
**另有一条硬约束**：`orderByModuleGraph` 里
```js
if (dependency === entry) throw new Error(`client-modules: "${entry.id}" requests module "${name}" that it answers itself — a row must not declare its own package in dsh.client.external`);
```
→ **不要把自己的包名写进自己的 `external`**。官方 README 也写明：只接受「尾随 `/client` 别名到包行」的形式，没有 provider-alias 声明，且拒绝缺失供应者/自请求/同步环。

### A3.3 实测：本机 54 行 boot 图的 `external` 全为空

上一轮抓到的 `__DSH_BOOT__`（54 项）里没有任何一行带 `external`；官方 37 个 `dsh.client` 包与 3 个第三方包（`dsh-any-background`、`@linxin666/dsh-client-ui-task-board`、`dsh-better-sidebar`）的 `package.json` 里也都没有 `external` 字段。原因就是 A3.1 的种子表足以覆盖它们的 require。

**对 dsh-tts-voice 的结论**：只要按正文第 2 节的清单 require（`react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-primitives` / `@deepseek-ai/dsh-client-runtime/client`），**`external` 可以完全不写**；如果将来真的 require 了 `@deepseek-ai/dsh-client-ui-settings/client`，再把它写进 `external`（`inject` 里那份包名清单保持不变，仅作诊断）。

### A3.4 ★ `@deepseek-ai/dsh-client-ui-slots` 是否真的只由 shell 播种？

**是。三重实证：**

1. **磁盘上不存在该包目录**（三个候选路径全部 `exists=False`）：
   - `...\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-slots` → False
   - `C:\Users\35756\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-slots` → False
   - `C:\Users\35756\.dsh\profiles\web\.dsh-module-fallback\node_modules\@deepseek-ai\dsh-client-ui-slots` → False
2. **Node 解析失败**：用 profile 的 require 上下文 `require.resolve('@deepseek-ai/dsh-client-ui-slots')` → `MODULE_NOT_FOUND`（同一探针下 `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-store` 也都是 `MODULE_NOT_FOUND`，而 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings` 可以解析 —— 这佐证了「播种表里的包只存在于浏览器侧」）。
3. **浏览器侧由 shell 播种**：`dsh-web-frontend\dist\assets\index-ClqxG24t.js` 里
   ```js
   const g6 = Object.freeze(Object.defineProperty({ __proto__: null, SlotCore: m6, SlotOwnershipError: p6, StaleAuthorizationError: h6, resolveSlotLabel: C6 }, Symbol.toStringTag, { value: "Module" }))
   ```
   而种子表把它接在键上：`function Jd(){return{ … "@deepseek-ai/dsh-client-ui-slots": g6, "@deepseek-ai/dsh-client-ui-primitives": Kd }}`。

**实践含义**：① `import type { … } from '@deepseek-ai/dsh-client-ui-slots'` 是**类型专用**（编译期擦除，不产生 require 请求）——第三方 `task-board` 就是这么用的（其产物只 require `react` / `react/jsx-runtime` / `react-dom/client`）；② 若想在 bundle 里**取值**（例如 `SlotCore` / `resolveSlotLabel`），可以 `require('@deepseek-ai/dsh-client-ui-slots')`，它命中种子表；但**不要把它写进 `external`**，也不要指望磁盘上有它的 `.d.ts` 供你的编辑器使用；③ 本仓库没有该包的完整 `.d.ts`，所以 `SlotMap` 的类型扩展（如把自定义 slot 键声明进 `SlotMap`）只能写 `declare module '@deepseek-ai/dsh-client-ui-slots'` 的纯类型声明，运行时零影响。

## A4. 本节新增结论速查（5 条）

1. **宿主注册契约**：`ctx.settings.register(ns, schema, { base?, applies?, validate? })`，schema 是 **schemastery**（`@deepseek-ai/schemastery`，`z.object({...})` + `.default()/.min()/.max()/.step()/.role()/.description()`；枚举用 `z.union([...])`；`z.percent()` 自带 slider 语义）；返回 `{get, watch, update, replace}`；**不要用 `installSection`/`settingsNamespace` 这两个已删的导出**（就近校验命名空间）。
2. **未注册命名空间写不进，且 4 条路径全部静默 resolve**（未注册 / revision 冲突 / disposed / memory 模式）；唯一判活信号是 `getSnapshot().status === 'ready'`。
3. **`settings.section` 是 list slot（`id` 必填）**；组件 props = owner `{ close }` + `inject()` 的返回对象（**必须是对象**）+ `locale` 带来的 `t`；`label` 可为函数（`resolveSlotLabel` = `typeof n=="function" ? n() : n`）；**`store` 可不传**，用 `useSyncExternalStore` 订阅 `scope`。
4. **`inject` 只影响图序与诊断，`external` 才决定同步 `require` 能否命中**；种子表 + parser-preload 之外的 specifier 才需要 external，漏写抛 `require("X") missed the module table …`；不能把自己的包名写进自己的 external。
5. **`@deepseek-ai/dsh-client-ui-slots` 只由 shell 播种**：磁盘 0 处、Node 解析 `MODULE_NOT_FOUND`、浏览器侧 `g6` 导出 `SlotCore`/`resolveSlotLabel` 等——类型可 import（会被擦除），值可 `require`，但**不要**写进 `external`。
