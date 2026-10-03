# dsh-ui-polish

DSH 的界面细节打磨层：**宿主哪里漏画了，这里补上**。纯 CSS，不改结构、不碰数据、不接管席位。
和 `dsh-motion-layer`（动效）分开装 —— 想要零动效但留着毛玻璃，关掉那一个就行。

![推理强度滑杆：在模型选单里把 4 个单选项换成可拖动的档位滑杆](assets/slider-demo.png)

## 这一版修了什么

### 弹层菜单是"透明"的 → 补成毛玻璃

权限选择、模型选择、工作区选择、右键菜单……这些浮层背后的文字直接透上来（截图里能看到
工作区名和输入框文案穿过去）。**不是配色问题，是材质根本没画出来。**

顺着真机 DOM 查到的链条：

```
宿主 ui-primitives 的 MenuSurface
  <div role="menu" data-menu-material="translucent" class="_surface_..">
    <div aria-hidden="true" class="_material_.."></div>   ← 材质层
    <div class="_viewport_.." role="presentation">…</div>
  </div>

材质层本身是对的：
  background: rgba(248,249,250,.58);
  backdrop-filter: blur(40px) saturate(1.5);
  z-index: -1;

但父层 _surface_ 上有：
  isolation: isolate;        ← 就是它
```

`isolation: isolate` 会把这一层变成 **backdrop root**，子层的 `backdrop-filter` 于是只能采到
自己组内的东西——组内除了透明什么都没有，模糊直接失效；剩下的只有 58% 的淡色，
看起来就是"半透明菜单"。宿主的源码注释写着那套 `backing` 是
「给 macOS 让 Chromium 能模糊透明窗口」用的，Windows/Linux 上没有这层 backing，
问题就直接暴露出来了。

**修法**：把材质画在**浮层自己**身上（它挂在 `body` 下，backdrop 能正常采到页面），
再把那个失效的子材质层关掉，免得叠两层。底色用宿主自己的主题变量
`--dsw-alias-bg-layer-1`，所以浅色/深色自动跟随。

```css
[data-menu-material='translucent']{
  background-color: color-mix(in srgb, var(--dsw-alias-bg-layer-1,#fff) 76%, transparent);
  backdrop-filter: blur(40px) saturate(1.5);
  -webkit-backdrop-filter: blur(40px) saturate(1.5);
}
[data-menu-material='translucent'] > [aria-hidden='true']{
  background: none; backdrop-filter: none; -webkit-backdrop-filter: none;
}
```

只认 `data-menu-material="translucent"` 这一个契约属性：宿主哪天真修好了，整个文件删掉即可，
不会牵动别的样式。

### 顺带排查过、确认没问题的

| 表面 | 结论 |
| --- | --- |
| `role="dialog"[aria-modal]`（设置面板等） | 宿主自己画了实底 `rgb(255,255,255)`，**不动它**（乱加半透明会是回归） |
| `role="tooltip"`（如「收起侧边栏」） | 实底 `rgb(44,44,46)`，没问题 |
| 菜单项 hover | 宿主有 `rgba(38,49,72,.06)` + 圆角 + 过渡，没问题 |

## 模型选单：一次点击就看到滑杆，模型行进模型列表

宿主原本是两级菜单：`模型选单 → 推理等级 → Off / Low / High / Max`，选一次要点两下。
现在改成：

```
点输入框上的模型控件
   ↓（自动进等级页，一次点击）
┌───────────────────────────────┐
│            Max                │ ← 当前档位（居中、强调色）
│   DeepSeek-V41-Flash       ›  │ ← 模型名居中 + 箭头；点这行进模型列表
│ ●───────────────○            │ ← 推理等级滑杆（拖动/点击/键盘）
│ Off   Low   High   Max        │ ← 原来的选项行仍然在，可点可读屏
└───────────────────────────────┘
```

对照参考图逐项核对过（`outputs/ui-polish/04-*`）：
当前档位那行是**克隆宿主单元格**后改造的——藏掉「模型」二字、居中、箭头调淡；
档位标题用强调色 15px/600；刻点数 = 档数（DSH 是 4 档，所以 4 个点）。
**有意保留的差异**：滑杆下面那四行没有去掉（它们是文案与读屏路径，参考实现只有裸刻点）；
滑钮两端内缩一个半径（不探出轨道，几何上更稳）。

怎么做到的（都是真机上量出来的，改之前先看这几条）：

- **自动进等级页**：菜单打开时是 `[模型][推理等级]` 两行（按**位置**认，不认文字——
  界面语言会变）。检测到就点第二行进等级页，并用 `html.dshp-advancing` 把那一两帧压住，不闪。
- **每次打开只自动进一次**（`WeakSet`）：否则用户按 Esc 退回来会被立刻再推进去，
  永远看不到上一层，模型列表就进不去。
- **顶部那行模型是"克隆"出来的**：宿主单元格的类名是哈希的，克隆能 1:1 继承外观与 chevron；
  点它 = 往菜单派发一次 `Escape`（宿主在等级页把 Esc 当"返回上一层"，不是关闭）→
  下一帧点真正的模型行 → 打开模型列表。
- **Esc 必须派发到菜单元素**：派发到 `document` / `activeElement` 宿主都收不到（逐个试过）。
- **模型列表本身也是 `menuitemradio`**：所以"这是不是等级页"不能按"有几个单选"判断，
  要按**从哪一行进来的**判断（`reasoningPage` Map），否则会给模型列表也装上滑杆。
- React 不认识我们插的节点：离开等级页时滑杆与模型行都要自己收掉，否则会留在上一层的菜单里。

真机上量出来的关键约束：**宿主的 `menuitemradio` 一被点就关菜单**。所以滑杆是
**拖动只改视觉、松手才提交**——边拖边点不可能。

| 交互 | 行为 |
| --- | --- |
| 拖动 | 只更新填充/滑钮/刻点，并把「将要生效」的那一行点亮（`data-dshp-target`）；菜单不关 |
| 松手 | 位置变了才 `click()` 对应那一行 —— 状态仍由宿主管理，它自己应用并关菜单 |
| 原地松手 | 不提交、不关菜单（避免误触把菜单关掉） |
| 点击轨道 | 等同拖动（按下+抬起 = 选最接近的档） |
| 键盘 | 滑杆可 Tab 聚焦，`←/→/↑/↓` 换档、`Home/End` 到两端 |

几个刻意的设计：

- **档位名字从 DOM 里读**（`menuitemradio` 的文本），不写死 Off/Low/High/Max——换模型、换语言都跟着变。
- **不复制标签**：列表就在滑杆下面，滑杆只画刻度（点的个数 = 档数）；拖动时点亮对应行，两者说的是同一件事。
- **几何**：滑钮行程 = 轨道宽减一个滑钮直径，两端都留在轨道里；只写一个 `--dshp-t: 0~1`，算式交给 CSS，拖动时关过渡（跟手），松手回弹才用 160ms。
- **轨道颜色用「文字色的低透明度」**，不用 `bg-layer-2`：浅色主题里 `bg-layer-2` 就是白色，压在毛玻璃上等于没有轨道；用文字色深浅主题自动反相。
- React 重建菜单会冲掉滑杆，所以有个 `MutationObserver` 盯着补回去（幂等）。

## 配置（`cordis.patch.yml` 的 config）

| key | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` = 整层不注入 |
| `glass` | `true` | 浮层毛玻璃开关 |
| `tintAlpha` | `0.76` | 底色不透明度。**想更透就调小**（0.6 很透、0.9 接近实底） |
| `blurPx` | `40` | 背景模糊半径，宿主自己用的也是 40 |
| `slider` | `true` | 推理等级滑杆开关 |

运行时（DevTools，立即生效，不用刷新）：

```js
dshUiPolish.setTint(0.6)    // 调浓淡
dshUiPolish.off()           // 关掉，界面立刻回到宿主原样
dshUiPolish.on()            // 回来
dshUiPolish.setSlider(false) // 只要毛玻璃、不要滑杆
```

无障碍：系统开「减少透明」（`prefers-reduced-transparency`）或浏览器不支持
`backdrop-filter` 时，自动把底加厚到 96%（不至于只剩半透明看不清）；
`forced-colors: active` 下交给系统配色，不自己画材质。

## 装 / 卸

```powershell
# dsh CLI 在你本机安装位置下的 bin\dsh.cmd，按实际路径改
$dsh = '<DSH_INSTALL_DIR>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add "file:."
# 卸
& $dsh plugin --profile desktop remove dsh-ui-polish
```

装完刷新一次窗口（Ctrl+R）。**改过源码之后**：pnpm 对 `file:` 依赖是**拷贝**进 profile 的，
要先 `remove` 再 `add`，然后刷新。

## 验证

```powershell
node test/glass.browser.test.mjs       # 真 Chromium，16 条断言
node test/slider.browser.test.mjs      # 真 Chromium，滑杆 21 条断言
node test/live-verify.mjs "<带 token 的 dsh web URL>"   # 真机
```

真机脚本怎么起隔离实例写在它自己的头注释里（拷一份 sessions/storages/index 到临时
`DSH_HOME`，装 base + web-app + 本插件，`--port 19899 --no-open`）。

## 继续加东西之前

1. **先量，再改。** 这类"看起来是配色问题"的现象，八成是布局/层叠/材质没生效。
   在真机 `getComputedStyle` 里把 `background-color` / `backdrop-filter` /
   `isolation` / `z-index` 打出来，比猜快得多。
2. **只认契约属性**（`data-*`、`role`），别认哈希类名（`_surface_ri079_1` 里的哈希会变）。
3. **不要碰已经画好的表面**：对话框有实底就别再叠半透明，那是回归。
4. 新规则都挂在 `html.dshp-css` 下；卸载 = 摘掉样式表，界面回到原样。

## 踩坑 #1（最贵的一条）：白屏的真正根因是 focusin 自动武装

**现象**：装上本插件后 App 白屏，`documentElement` 为 null，控制台报
`Minified React error #200` + `slot entry crashed in settings.onboarding`。

**真正的链条**（真机时间轴量出来的）：

    0.5s  页面正常，355 个节点
    0.6s  启动引导页(settings.onboarding)自动聚焦某个元素
          -> focusin 触发 -> arm() 立刻跑 scan()
          -> 我们在 React 渲染到一半时改它的 DOM
          -> React 抛 #200（挂载容器丢失）
          -> document 被换掉 -> 整页全白

**为什么难查**：apply() 外面裹多少层 try/catch 都没用——这不是抛异常，
是「监听器抢跑」。try/catch 只能拦前者，拦不住后者。

**修法**：arm() 只由 pointerdown / keydown 武装（真人操作才会来，
那时 React 早已挂载完毕）。**绝不**用 focusin——它会被自动聚焦误触发。

**附带的两个真 bug**（同一轮定位出来的）：

- 等级页判断 `reasoningPage.get(menu) === true` 只在插件自己点过菜单时才为
  true，宿主自动切页时从没写过，导致滑杆永远装不上。改成按档位名认
  （`looksLikeLevelPage`）。
- `documentElement.classList.add("dshp-slider")` 躲在
  `else if (!stopMenus)` 里，stopMenus 一非空整段被跳过，类名和监听器
  一起没了。改成无条件加。

**改完 client.js 记得手动同步副本**：`pnpm add` 不会更新已安装的文件链接
内容，必须 Copy-Item 到
`~/.dsh/profiles/desktop/node_modules/dsh-ui-polish/lib/client.js`。
## 踩坑 #2：`<html>` 上的类名和滑杆元素撞了

**现象**：启动正常（640 节点），但**第一次点击就白屏**。
控制台只报 `Cannot read properties of null (reading 'hasAttribute')`。

**根因**：滑杆启用时代码做了
`document.documentElement.classList.add("dshp-slider")`，
而样式表里有一条 `.dshp-slider{ width:100%; padding:10px 12px 6px;
cursor:pointer; touch-action:none; user-select:none; box-sizing:border-box }`
——那是给滑杆**元素**写的，却同时命中了 `<html>`。

`touch-action:none` 挂在根元素上会禁用整页的默认指针行为，
`user-select:none`、`cursor:pointer` 同理。宿主 React 随后在重建
DOM 时炸掉（`SidebarFragment` 读到 `documentElement` 为 null），整页变白。

**修法**：根元素上的标记类改名成 `dshp-sliderOn`，与滑杆元素类
`.dshp-slider` 彻底分开。**教训：给 `<html>` 加类名时，先确认它不会命中
已有规则。**

**顺带修掉的**：`enhanceModelMenu` 里
`if (!modelRow) { var head = buildModelRow(menu); ... }`
——`var head` 覆盖了灰框容器变量，还把行插到菜单顶部，
真机上表现为"灰框外多浮一条重复模型名"。已改为只往 head 里补。

## 排查方法（留给下一次）

- **别靠猜，做单一变量对照**。每改一处就重跑同一个探针，记录数字。
- **注意硬链接**：`profiles/<name>/node_modules/<pkg>` 里的文件可能是
  源码的硬链接。往里写"实验版"会直接改到源码——我因此污染过一次源码，
  还差点把"重复插桩日志"误读成"插件被加载两次"。
  验证方法：`Copy-Item` 报 "cannot overwrite with itself" 就是同一个文件。
- **时间轴采样**比读代码快：每 300ms 记一次
  `document.documentElement` 是否存在 + 节点数，一眼看出崩在哪一刻。
- **抓第一条错误**：`addInitScript` 里挂 `window.onerror` +
  包装 `console.error`，比事后看宿主日志准。
## 踩坑 #3：菜单比该在的位置高出一截

**现象**：滑杆页弹出后浮在上方，和触发器之间空一大块（实测间隙 45px，
宿主自己的间距是 8px）。

**根因**：宿主是拿「增强**之前**」的高度算的 `top`，而它的 `ResizeObserver`
对这个浮层不生效——实测把面板撑高 60px，`style.top` 纹丝不动。
我们随后把 4 行档位藏掉、换成滑杆，菜单矮了，于是底部多出一块空洞。

**修法**：`realignMenu()` —— 增强完成后派发一次 `window` 的 `resize`，
宿主自己会用新高度重算（实测间隙立刻回到 8px）。**不猜任何间距数字**。
离开等级页时清掉标记，下次重开重新对齐。

## 踩坑 #4：鼠标划过轨道就改档位

用户要求「要滑钮到那一档才变」。两处联动都补上 `ev.buttons & 1` 判断——
只有真的按住才联动，划过不动。

## 踩坑 #5：点灰框不进模型列表

**根因**：宿主在 **pointerdown** 那一刻就把菜单关掉了（实测：只按下不松，
菜单已经没了），元素随即被移除 → `click` 永远不会派发。
另外宿主的 Esc 是「**关菜单**」而不是「退回上一层」，菜单 DOM 里根本没有返回按钮，
所以旧版「派发 Esc 再等两行」永远等不到。

**修法**：灰框改挂 `pointerdown`（捕获阶段，赶在菜单被关之前）＋ `click` 兜底，
内部去重；`openModelList` 改成「关掉菜单 → 重新打开 → 点第一行（模型）」。
`wantModelsUntil` 让「自动进等级页」在这期间让路。
## 踩坑 #6：悬停就改标签 —— 别用布尔量记"是否在拖"

**现象**（用户原话）：滑钮没动，但鼠标一移动，上面的档位名就跟着变。

**根因**：判断"是否正在拖"用了模块级布尔量 `trackPointerDown`，
它在 `pointerdown` 置 true、`pointerup/cancel` 置 false。
只要**漏掉一次 up**（指针移出窗口、宿主 pointer capture、组件被重建），
它就永久卡在 `true`，之后鼠标**只是划过**轨道也会改标签。

顺带一提，之前试过用 `ev.buttons & 1`，同样不行：宿主 pointer capture 之后
`buttons` 会报 0，反过来导致**拖动时标签不更新**。

**修法**：按 `pointerId` 精确跟踪 —— 按下时记住 `pointerId` 和轨道元素，
只有同一个 id 的 `pointermove` 才联动，`up`/`cancel` 立刻清空。
两处联动（`healSlider` 的 `syncLabel`、`installPointerBridge` 的 `onPointer`）
都改成这套。真机验证：纯悬停扫过整条轨道，标签变化次数 **0**。

## 踩坑 #7：Esc 露出旧版菜单

宿主的 Esc 是「**退回上一层**」而不是「关闭菜单」。在滑杆页按一次 Esc，
会退回宿主的原生两行菜单（模型 / 推理等级）——用户看到的就是
"旧版模型选择器又冒出来了"。
修法：滑杆自己接管 Esc，先 `preventDefault`，再补发一次 Esc 确保整个菜单关掉。

## 踩坑 #8：模型列表页顶着档位名

模型列表页不该显示推理档位。除了不装 head，还要把宿主可能残留的
`.dshp-levelLabel` 一并收掉。

## 踩坑 #9：松手提交会闪一下

提交后宿主会关菜单，而旧代码又用 `reopenAfterCommit()` 把它重开，
中间有约 65ms 的空窗（真机逐帧量到：菜单消失 → 重开 → 补齐），肉眼可见。
修法：**提交后不再重开**，菜单自然收起；要再调就再点一次触发器。
`reopenAfterCommit` 已成死代码，一并删除。
## 踩坑 #10：选完一档菜单就收起 / 连续换档会坏

**用户要求**：滑动选完之后菜单要留在原地，不要收起、也不要闪。

**第一次尝试失败**：提交后等菜单关闭再点触发器重开。第一次换档没问题，
但**第二次换档时菜单整个消失了**——因为提交后菜单还没关完，
这时候点触发器会被宿主当成 toggle，直接把菜单关掉。

**正确做法**：`reopenAndSettle()` 里先确认"菜单确实已经关掉了"（`sawClosed`），
再点触发器重开，并且两次点击之间留 120ms 间隔。重开之后等滑杆被增强器装回来
（菜单是分帧长出来的），再调 `applyPicked()` 把档位停回用户选的那一档。

**另一个坑**：曾经用一个 `keepOpenUntil` 同时表达"保持菜单打开"和"别自动推进"，
结果重开的菜单停在宿主的原生两行页，滑杆永远不出现——因为自动推进正是把它
带到等级页的那一步。后来拆成两个独立的标记：`pickedUntil`（优先显示用户选的档）
和自动推进互不干涉。

## 踩坑 #11：刻点渐变不生效

`transition` 写在 `.dshp-sliderDot` 上、渐变靠 `::after` 的 `opacity` 做，
但基类声明的是 `background-color` 过渡，实际变化的是伪元素的透明度。
把 `transition: opacity 260ms ...` 写到 `::after` 上即可，两个刻点之间就是平滑过渡。
## 踩坑 #12：模型列表顶部的档位清不掉

**现象**：进模型列表页，顶部还挂着蓝色的档位名（"Low"/"High"）。

**为什么之前的清理代码没生效**：`enhanceModelMenu` 里明明有清理分支，
但 `MutationObserver` 只监听 `addedNodes`——它检查新增节点里有没有 `[role='menu']`。
宿主从滑杆页切到模型列表页时**复用同一个菜单节点**，只替换内部内容，
所以 addedNodes 里全是列表项、没有菜单元素，`maybe` 永远是 false，
扫描根本不触发，清理代码自然没机会跑。

**修法**：观察器同时监听"变动是否发生在某个菜单内部"
（`record.target.closest("[role='menu']")`）。这样切页也能触发扫描。

**另外加了一道兜底**：`scan()` 扫完之后，任何**不在等级页**的菜单
（没有 `dshp-levelPage` 类）都要把滑杆、head、档位标记、模型行全部清掉。
两道保险，任一条路径漏掉都能自愈。

**验证**：连续三轮"打开→进列表→关闭"，列表页的 label / 档位文字 / 滑杆 / head 全部为 0。
## 踩坑 #13：选完会闪 —— 别再"关掉再重开"，直接调宿主的 select()

**用户要求**：选完强度后菜单要留在原地，不要闪。

**之前为什么一定闪**：宿主的 `chooseEffort` 内部是这样的（从 ModelSelect 组件源码挖出来的）：

```js
const close = () => { setOpen(false); setPane("root"); ... };
const closeAfterSelection = () => { setSelectionFocus(true); close(true); };
const chooseEffort = (effort) => {
  if (effectiveEffort === effort) { closeAfterSelection(); return; }  // 同一档 → 关
  submit({ ..., reasoningEffort: effort });                           // 不同档 → 提交
};
```

**点宿主的 radio 必然走 closeAfterSelection → 菜单关闭**，
我们再去重开就是"关→开"，那一瞬间的闪烁无法消除。

**正解**：根本不点它。ModelSelect 的 props 上有 `select`（组件自己的提交函数），
直接调用它只应用档位、不碰 open 状态。实测菜单全程不关。

```js
// 从菜单节点的 React fiber 往上找 ModelSelect，调它的 props.select()
const f = findModelSelectFiber(menu);
const cur = readHostSelection(f);          // { provider, model }
f.memoizedProps.select({ provider: cur.provider, model: cur.model, reasoningEffort: id });
```

**两个容易踩的细节**：

1. **当前选择藏在 `hook.memoizedState.current` 里**（useSyncExternalStore 的 snapshot），
   不是 `memoizedState` 本身。直接读 `memoizedState.provider` 会拿到 undefined，
   于是 submitEffort 失败、退回点 radio、菜单就被关掉。
2. **档位 id 要从宿主的 `state.groups` 里读**（`model.reasoning.efforts[].id`），
   不要按标签文字猜——标签会被本地化，id 不会。
   兜底才用标签小写。

**提交后宿主会重渲染，把档位名冲掉**（真机现象：滑杆位置对了、刻点对了、
顶部还显示上一档）。所以 commit 之后用 setInterval 盯 2.5 秒，
发现标签/位置不是用户选的那一档就写回去。

## 滑杆手感：从"跳格子"改成连续跟手

之前拖动时每帧都做整数吸附（`Math.round`），4 个档位只有 4 个位置，
看起来一格一格跳，很硬。现在拆成两条：

- **拖动中**：用连续比例 `fracAt()` 直接写 `--dshp-t`，滑钮跟手平滑移动；
  只有跨到新档位时才更新文字与刻点。
- **松手时**：`Math.round` 吸附到最近档位，用 CSS 过渡平滑回弹
  （`260ms cubic-bezier(.22,.61,.36,1)`，比原来的 180ms 更柔）。
## 踩坑 #14：连续换档会漏提交 —— index 从不更新

**现象**：连续拖动换档时，偶尔"拖了但没生效"，或拖回原档反而提交了。

**根因**：滑杆里有个 `var index = checkedIndex(radios)` 表示"当前生效的档位"，
但**它初始化之后就再也没更新过**。而 `endDrag` 是靠
`if (target !== index)` 来决定要不要提交的——拿第一次的档位一直比，
于是：

- 拖到新档 → 提交，但 index 还是旧值
- 再拖回旧档 → `target === index` 成立 → 不提交，宿主状态没变，界面和实际不一致

**修法**：提交后立刻 `index = target`（键盘换档同理），
另外给滑杆暴露 `__dshpSyncIndex(i)`，让增强器每次重新装上滑杆时
把 index 对齐到宿主的真实 checked 状态。两处一起保证 index 永远是真的。
## 踩坑 #15：拖动卡顿/跳动（三个独立原因）

**① 坐标系不一致（最主要）**

`fracAt()` 用整条轨道宽归一化 `(clientX - left) / width`，
而 CSS 里滑钮的位移是 `travel * t`（travel = 轨道宽 − 22）。
两套坐标系不一样，越靠两端偏差越大——实测偏差曲线是
起点 +22px、中点 0、终点 −43px，看起来就是"滑钮跟不上手指"。

改成按**滑钮可用区间**归一化：`(clientX - left - 11) / (width - 22)`，
与 CSS 的 travel 对齐。

**② 滑钮位移多加了半径**

CSS 里写 `translate: calc(11px + travel * t)`，
但滑钮本身 `left:0`、宽 22px，它的中心天然就在 +11px 处，
再加 11px 就整体偏右半个直径。实测偏差**恒定 11px**（正是半径），
改成 `translate: calc(travel * t)` 后归零。

**③ 每帧读布局（性能）**

拖动时 `fracAt()` 每次调 `getBoundingClientRect()`，
加上 `syncLabelsTo` 里的 `void label.offsetWidth`（强制重排），
实测 21 次 pointermove 触发 159 次布局读取（7.57 次/移动），
帧间隔 p95 到 33ms、54 帧里 19 帧掉帧。

修法：
- 轨道几何**按下时量一次**存进 `geo`，整个拖动过程复用（`ResizeObserver` 变化时作废）
- 去掉 `void label.offsetWidth`，改用 WAAPI（`element.animate`）重启动画
- 滑钮/填充的位移改用 `transform` / `translate`（合成层），不再用 `left` / `width`

**验证**：拖动全程与手指偏差 **0px**、回跳 **0 次**；
按下瞬间不再吸附跳动（原来跳 63px，现在 0px）。
## 踩坑 #16：滑钮跟不上手指（scale 与 transform 的叠加）

**现象**：拖动时滑钮总是"慢半拍"，越往两端偏差越大（实测线性到 23px）。

**根因**：滑钮同时用了两个属性：

```css
.dshp-sliderKnob{
  scale: 1;                              /* 独立属性 */
  transform: translateX(var(--dshp-x));  /* 位移 */
}
```

**独立的 `scale` 属性以元素中心为基准缩放，会把 `translateX` 的位移一起放大。**
拖动时 `--dshp-k:1.12`，于是 194px 的位移被放大成 217px —— 多走的正是偏差。

最小复现（位移 100px、元素宽 22）：

| 写法 | 元素中心 |
|---|---|
| `transform:translateX(100px); scale:1.12` | **123**（多 12px） |
| `transform:translateX(100px) scale(1.12)` | **111** ✓ |

**修法**：把缩放并进 `transform`，用变量控制倍数：

```css
.dshp-sliderKnob{ --dshp-k:1; transform:translateX(var(--dshp-x,0px)) scale(var(--dshp-k)); }
.dshp-sliderActive .dshp-sliderKnob{ --dshp-k:1.12; }
```

刻点的 `scale:1.25` 同理，也改成 `--dshp-dk` 变量 + `transform:scale()`。

**另一个坑**：量滑钮宽度必须用 `offsetWidth`，不能用 `getBoundingClientRect().width`——
拖动时它有 scale，后者会返回放大后的 24.6px，导致 travel 算错。

## 踩坑 #17：未松开时文字闪一下 / 不动

**现象**：滑到对应档位、还没松手时，顶部档位名闪一下；有时干脆一直不变。

**根因**：三个写入源在抢同一个标签：

1. `syncLabelsTo`（拖动逻辑）—— 跟着滑钮写正确的档位
2. `syncLabel`（healSlider 的桥）—— 也写正确档位
3. **`enhanceModelMenu`（scan 调用）** —— 它从**宿主状态**读档位，
   而拖动中宿主还是旧档位，于是每次都把标签重置回去

第 3 个是元凶：`scan` 会被 MutationObserver 反复触发，每触发一次就把标签压回旧值。
用拦截 `textContent` setter 抓调用栈才定位到。

**修法**：
- `enhanceModelMenu` 里判断滑杆是否处于 `dshp-sliderActive`（拖动中），是则跳过写标签
- `commit` 的守护定时器不再闭包捕获旧的 `i`，改读 `pickedIndex`（拖动会同步更新）
- 用户再次开始拖动时，守护定时器立刻停表

## 动效统一

用户要求"变化都要有动效，不要硬切"。补齐了：

| 元素 | 过渡 |
|---|---|
| 档位名 | `color/opacity 220ms` + WAAPI 轻微回弹（**从 opacity 0.55 开始，不是 0**） |
| 刻点 | `background-color/transform 280ms`（回弹曲线） |
| 行高亮 | `background-color 240ms` |
| 滑钮 | `transform 260ms`（弹簧曲线） |
| 填充 | `transform 260ms`（同上） |

**关键点**：文字动效不能从 `opacity:0` 开始——那样配合其它写入源就会"闪"。
改成 0.55 起步的轻微回弹，既看得出变化又不刺眼。

**还有一条**：`measure()` 被连续几帧调用时，**只在值真的变化时才写 CSS 变量**。
重复写同一个值会反复重启 CSS 过渡，滑钮要 600ms 以上才到位（实测从 600ms 降到 300ms）。
