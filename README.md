# dsh-ui-polish

DSH（DeepSeek Harness）桌面端的 UI 打磨插件：**宿主界面哪里粗糙，这里补哪里**。
浏览器侧纯注入，不改宿主结构、不碰会话数据，卸载即恢复原样。

![推理强度滑杆](assets/slider-demo.png)

## 它做什么

### 1. 浮层毛玻璃

宿主的菜单、选择器等浮层本该是毛玻璃，但材质层被父级的 `isolation: isolate`
截断了 backdrop，实际看起来是"半透明发虚"。本插件把材质画到浮层自己身上，
底色跟随宿主主题变量，浅色/深色自动适配。

### 2. 推理强度滑杆

把「模型选单 → 推理等级 → 4 个单选项」换成一条可拖动的滑杆：

- 拖动实时跟手，松手吸附到最近档位；
- 提交直接调用宿主的 `select()`，菜单全程不关、不闪；
- 档位名从 DOM 读取，换模型、换界面语言都跟着变，不写死；
- 支持键盘（`←/→` 换档、`Home/End` 到两端）与读屏。

### 3. 更顺的模型选择流程

- 点输入框上的模型控件，一次点击直达档位页（滑杆）；
- 点顶部模型行，直达模型列表；
- 在列表里选了带推理档位的模型，自然过渡回滑杆页；没有档位的模型直接完成选择；
- Esc 一次关闭整个菜单，不会退回中间层；
- 触发器上的「模型 · 档位」名称实时更新。

## 安装

```powershell
# dsh CLI 在你本机 DSH 安装目录下的 bin\dsh.cmd，按实际路径改
$dsh = '<DSH_INSTALL_DIR>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add "file:."
```

装完刷新窗口（Ctrl+R）。改过源码后需要 `remove` 再 `add`（pnpm 对 `file:` 依赖是拷贝）。

卸载：

```powershell
& $dsh plugin --profile desktop remove dsh-ui-polish
```

## 配置

`cordis.patch.yml` 的 `config` 段：

| key | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` = 整层停用 |
| `glass` | `true` | 浮层毛玻璃开关 |
| `tintAlpha` | `0.76` | 底色不透明度，越小越透 |
| `blurPx` | `40` | 背景模糊半径 |
| `slider` | `true` | 推理强度滑杆开关 |

运行时开关（DevTools 控制台，立即生效不用刷新）：

```js
dshUiPolish.setTint(0.6)       // 调浓淡
dshUiPolish.off()              // 整层关闭，界面回到宿主原样
dshUiPolish.on()               // 恢复
dshUiPolish.setSlider(false)   // 只要毛玻璃、不要滑杆
```

## 开发与测试

```powershell
npm install
npm test    # 5 套 Playwright 回归：freeze / glass / nav / selftest / slider
```

测试用系统 Chrome（可用 `DSHP_CHROME` 指定路径），无需下载浏览器。
`test/live-verify.mjs` 可在真机 DSH 实例里验证毛玻璃与滑杆，用法见脚本头注释。

开发过程中的排查记录、宿主 DOM 契约和踩坑笔记（白屏根因、滑杆几何、Esc 行为、
异步提交窗口等）整理在 [docs/development-notes.md](docs/development-notes.md)，
改 `lib/client.js` 之前建议先读它。

## 注意事项

- 只认宿主的契约属性（`data-*`、`role`），不依赖哈希类名，宿主升级不易误伤；
- 系统开启「减少透明」或浏览器不支持 `backdrop-filter` 时自动加厚底色；
  `forced-colors` 下交还系统配色；
- 外来菜单（权限选单等非模型菜单）不会被插件接管。
