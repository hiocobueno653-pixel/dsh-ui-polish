/** dsh-ui-polish 浏览器半（手写 __ModuleLoader__ 工厂，无构建链，无 JSX）。
 *
 *  一句话：**宿主漏画的地方，补一层材质**。不改结构、不碰数据、不接管任何席位。
 *
 *  ## 这一版修的是什么
 *
 *  弹层菜单（权限选择、模型选择、工作区选择、右键菜单…）看起来是"透明的"，
 *  背后的工作区名和输入框文字直接透上来。查下来不是配色问题，是**材质没画出来**：
 *
 *  宿主 ui-primitives 的 MenuSurface 结构是
 *      <div role="menu" data-menu-material="translucent" class="_surface_.. _list_..">
 *        <div aria-hidden="true" class="_material_.."></div>   ← 材质层
 *        <div class="_viewport_.." role="presentation">…</div>
 *      </div>
 *  材质层的规则本身是对的：
 *      background: rgba(248,249,250,.58); backdrop-filter: blur(40px) saturate(1.5); z-index:-1
 *  但**父层 `_surface_` 上有 `isolation: isolate`**。isolation 会把这一层变成
 *  "backdrop root"，于是子层的 backdrop-filter 只能采到自己组内——组内除了透明什么都没有，
 *  模糊就失效了；只剩 58% 的淡色，看起来就是透明菜单。
 *  （宿主的源码注释写着这套 backing 是给 macOS"让 Chromium 能模糊透明窗口"用的，
 *    但 Windows/Linux 上并没有那层 backing，于是问题直接暴露。）
 *
 *  ## 修法
 *
 *  把材质画在**浮层自己**身上：它挂在 body 下，backdrop 能正常采到页面，
 *  模糊立刻生效；再把那个失效的子材质层关掉，免得叠两次。
 *  底色取宿主自己的主题变量（`--dsw-alias-bg-layer-1`），所以浅色/深色自动跟随。
 *
 *  只认 `data-menu-material="translucent"` 这一个契约属性——宿主哪天真修好了，
 *  这份样式可以直接删，不需要动别的。
 */
window.__ModuleLoader__.load({
	id: "dsh-ui-polish",
	factory: function () {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var NS = "ui-polish";
		var ROOT_CLASS = "dshp-css";

		var DEFAULTS = { enabled: true, glass: true, tintAlpha: 0.76, blurPx: 40, slider: true };

		/* ==================================================================
		 *  推理等级滑杆
		 *
		 *  宿主把推理等级做成「模型选单 → 推理等级 → 4 个 menuitemradio」两级菜单，
		 *  选一次要点两下。这里在**等级页**上叠一条滑杆：
		 *    · 拖动 = 只改视觉（高亮将要生效的那一行），松手才提交；
		 *      因为宿主的 radio 一被点就关菜单，不能边拖边点。
		 *    · 提交 = click 对应的那个 radio —— 状态仍然由宿主管理，
		 *      我们只是换了个更好按的输入方式，不碰它的数据。
		 *    · 等级名字**从 DOM 里读**（不写死 Off/Low/High/Max），换语言/换模型都对。
		 *  键盘：滑杆可聚焦，←/→ 直接选中相邻档（等价于点那一行）。
		 * ================================================================== */
		var RADIO_SELECTOR = "[role='menuitemradio']";
		var SLIDER_CLASS = "dshp-slider";
		var MODEL_ROW_CLASS = "dshp-modelRow";
		var LEVEL_LABEL_CLASS = "dshp-levelLabel";
		var HEAD_CLASS = "dshp-head";

		/**
		 * 把触发器 title 拆成「模型名 + 档位名」。
		 *
		 * ⚠️ 模型名自己就可能带「·」（真机：`hy3 · WorkBuddy`），
		 * 所以**不能**按第一个「·」切 —— 那样模型名会被截成 `hy3`，
		 * 档位名会被读成 `WorkBuddy`，正反两边都错（用户反馈「名称没变/不对」）。
		 * 判据：**最后一段**才算档位名（是一个档位词，或与触发器上
		 * triggerEffort 那段文字一致），剩下的整体都算模型名；
		 * 都不满足时整串就是模型名，档位读不到（返回 null，交给调用方保留原文案）。
		 */
		function splitTriggerTitle() {
			var out = { model: "", effort: null };
			if (typeof document === "undefined") return out;
			var btn = document.querySelector("[data-slot='conversation.input.model'] button");
			if (!btn) return out;
			var title = String(btn.getAttribute("title") || "").trim();
			if (!title) return out;
			var parts = title.split("·").map(function (s) { return s.trim(); }).filter(Boolean);
			if (parts.length >= 2) {
				var last = parts[parts.length - 1];
				var effSpan = btn.querySelector("[class*='triggerEffort']");
				var effNow = effSpan ? String(effSpan.textContent || "").trim() : "";
				if (LEVEL_WORDS.test(last) || (effNow && effNow === last)) {
					out.effort = last;
					out.model = parts.slice(0, -1).join(" · ");
					return out;
				}
			}
			out.model = title;
			return out;
		}
		/** 模型名：从触发器 title 实时读（形如「模型名 · 档位」）。 */
		function modelName() {
			var got = splitTriggerTitle();
			if (got.model) return got.model;
			if (typeof document === "undefined") return "";
			var btn = document.querySelector("[data-slot='conversation.input.model'] button");
			if (!btn) return "";
			var aria = String(btn.getAttribute("aria-label") || "");
			var m = /当前\s*([^，,]+)/.exec(aria);
			return m ? m[1].trim() : "";
		}
		/** 档位名：title 的最后一段；读不到返回 null（调用方保留宿主原文案）。 */
		function effortLabelFromTitle() {
			return splitTriggerTitle().effort;
		}
		/* 每个菜单当前停在"推理等级页"还是"模型页"。两者都可能是 menuitemradio 列表，
		   所以必须按**来源**判断，不能按"有几个单选"判断。 */
		/* ⚠️ 必须是 WeakMap：菜单节点每次打开都会被宿主换掉，用 Map 会
		   把每一个用过的节点都攒在内存里（一次会话开几百次菜单就留着几百个
		   DOM 节点）。这里只 get/set，不遍历，WeakMap 语义完全够用。 */
		var reasoningPage = new WeakMap();
		/* 每次打开只自动进一次等级页：否则用户按 Esc 退回来会被立刻再推进去，
		   永远看不到上一层（模型列表就进不去了）。菜单每次打开都是新节点，
		   所以用 WeakSet 记录即可，不必手动清理。 */
		/* 推理档位名。模型列表页同样是 menuitemradio, 靠这个区分,
		   绝不把滑杆装到模型列表上。 */
		/* 档位名（关/低/中/高/最大 …）。
		   ⚠️ 一定要包含 default：当前宿主的第一档就叫「Default」
		   （真机截图：Default / Low / High / Max）。以前漏了它，
		   looksLikeLevelPage 认不出这是档位页 → 滑杆永远装不上，
		   菜单退回宿主原生列表（用户截图确认）。
		   这里宁可多列几个：认错大不了少装一次滑杆，认不出则功能整个失效。 */
		var LEVEL_WORDS = /^(off|default|standard|auto|auto.?adjust|adaptive|low|medium|balanced|high|max|maximum|minimal|none|关闭|默认|标准|自动|低|中|高|最大|关)$/i;
		function looksLikeLevelPage(radios) {
			for (var i = 0; i < radios.length; i++) {
				if (LEVEL_WORDS.test(labelOf(radios[i]))) return true;
			}
			return false;
		}
		/**
		 * 整页 radio **全部**是档位名才算档位页（严格版）。
		 *
		 * ⚠️ 宽松版「有一个像就算」会把模型列表误判成档位页 ——
		 * 真机目录里就有个模型名叫 auto，正好在档位词表里；
		 * 一旦判错，滑杆会装到列表上，导航还会在两个界面之间来回跳。
		 * 只在读不到宿主 pane 的兜底路径上用这个严格版。
		 */
		function allLevelWords(radios) {
			if (!radios || radios.length < 2) return false;
			for (var i = 0; i < radios.length; i++) {
				if (!LEVEL_WORDS.test(labelOf(radios[i]))) return false;
			}
			return true;
		}

		/** 直接子级里的 [role='menuitem']（不含子菜单/克隆进来的行要另判）。 */
		function menuRows(menu) {
			var out = [];
			for (var i = 0; i < menu.children.length; i++) {
				var c = menu.children[i];
				if (c.getAttribute && c.getAttribute("role") === "menuitem") out.push(c);
			}
			return out;
		}

		/**
		 * 「正在导航中」的锁：打开模型列表 / 回到滑杆页的过程中，
		 * 增强器不要把菜单又自动推进到别处。
		 *
		 * ⚠️ 为什么必须带超时：
		 * 这个 class 以前只被加、几乎不被清，宿主复用菜单节点时标记会永久残留，
		 * 自动推进从此永久失效 —— 表现就是「从模型列表退出后再打开，进的是原生两行页
		 * 而不是滑杆页」（真机确认）。但反过来，enhanceModelMenu 每轮扫描都无条件清它，
		 * 又会让抑制完全不生效 —— 菜单刚从档位页退回两行页就被立刻推回档位页，
		 * 用户看到的就是"闪一下"（真机确认）。
		 * 两个问题叠在一起，说明这个标记必须是**带时间窗的锁**：写入时记时间戳，
		 * 读取时发现过期就顺手解锁。这样导航期间抑制有效，导航结束后自动恢复。
		 */
		var ADVANCING_LOCK_MS = 1500;
		function markAdvancing(menu) {
			if (!menu) return;
			menu.classList.add("dshp-advancing");
			menu.dataset.dshpAdvancingAt = String(Date.now());
		}
		function clearAdvancing(menu) {
			if (!menu) return;
			menu.classList.remove("dshp-advancing");
			try { delete menu.dataset.dshpAdvancingAt; } catch (err) { /* 忽略 */ }
		}
		/** 导航锁是否仍然有效；过期就当场解锁（自愈，不依赖谁来清）。 */
		function advancingLocked(menu) {
			if (!menu || !menu.classList.contains("dshp-advancing")) return false;
			var at = parseInt(menu.dataset.dshpAdvancingAt || "0", 10);
			if (!at || (Date.now() - at) > ADVANCING_LOCK_MS) {
				clearAdvancing(menu);
				return false;
			}
			return true;
		}

		/* ==============================================================
		 *  导航遮挡（消闪）
		 *
		 *  进出模型列表要经过宿主的「两行页」中转：
		 *      档位页 --Esc--> 两行页 --点第一行--> 模型列表
		 *  这一两帧里，用户会看到两行页，而且**我们插的灰框/滑杆还挂在菜单上**
		 *  （React 不认识它们，重渲染时不会替我们收），看上去就是"闪一下"。
		 *
		 *  做法：导航一开始就把菜单整层 `opacity:0`（不改变布局、不影响焦点，
		 *  所以宿主不会判定"焦点离开"而关掉菜单），落地到模型列表或滑杆页再揭开。
		 *  opacity 而不是 display/visibility：后两者会让焦点掉到 body，
		 *  宿主立刻关菜单（真机踩过）。另有 700ms 兜底，任何异常路径都不会
		 *  留下一个看不见的菜单。
		 * ============================================================== */
		/* ==============================================================
		 *  用户按 Esc → 一次就关菜单
		 *
		 *  宿主的 Escape 是**两级**的（源码 onRootKeyDown）：
		 *      档位页/列表页 --Esc--> 两行页 --再按 Esc--> 关闭
		 *  而我们的自动推进会抢在中间：刚退回两行页，立刻又被推回档位页 ——
		 *  于是 Esc 永远关不掉菜单（真机验证：连按两次都不关）。
		 *
		 *  这里统一接管真正的 Esc（合成的带 __dshpSynthetic 标记，不参与）：
		 *    ① 临时压住**这个**菜单的自动推进，让它停在两行页；
		 *    ② 稍后补一次 Esc，把它真正关掉。
		 *  只对模型选单生效（靠 fiber 认），免得误伤宿主别的菜单。
		 * ============================================================== */
		var escCloseMenu = null;   /* 刚按 Esc 时开着的那个菜单 */
		var escCloseUntil = 0;     /* 压住自动推进的截止时间 */
		function makeEscEvent() {
			var esc = new KeyboardEvent("keydown", {
				key: "Escape", code: "Escape", keyCode: 27, which: 27,
				bubbles: true, cancelable: true, composed: true,
			});
			try { esc.__dshpSynthetic = true; } catch (err) { /* 忽略 */ }
			return esc;
		}
		function armEscClose() {
			var raw = visibleMenu();
			if (!raw || !findModelSelectFiber(raw)) return;
			/* ⚠️ 列表页拿到的是**里面的列表**（role=menu，外壳是 group），
			   而档位页/两行页拿到的是外壳本身。压制与补发都要对着那个
			   **跨页面复用的外壳**做，否则退回两行页后节点对不上，
			   压制失效、补发的目标也已经脱离文档（真机/复刻都验证过）。 */
			var menu = (raw.closest && raw.closest("[role='group']")) || raw;
			escCloseMenu = menu;
			escCloseUntil = Date.now() + 600;
			setTimeout(function () {
				if (escCloseMenu !== menu || Date.now() > escCloseUntil) { escCloseMenu = null; return; }
				var live = visibleMenu();
				if (!live || live !== menu || !menu.isConnected) { escCloseMenu = null; return; }
				/* 菜单还在（刚才那下只退到上一层）→ 补一次真正的关闭。
				   ⚠️ 必须派发到**菜单内部的元素**：宿主的按键处理挂在 React 根上，
				   从 portal 里冒泡才收得到；直接派给 document 收不到（真机实测）。
				   ⚠️ 而且目标必须**还在文档里**：滑杆在退回两行页那一轮就被我们的
				   清理逻辑摘掉了，焦点元素这时是个游离节点 —— 派上去哪儿也不去，
				   补发等于没发（真机验证：Esc 还是关不掉）。所以一律以菜单本体兜底。 */
				var targets = [];
				var focused = document.activeElement;
				if (focused && focused.isConnected && menu.contains(focused)) targets.push(focused);
				targets.push(menu);
				for (var ti = 0; ti < targets.length; ti++) {
					try { targets[ti].dispatchEvent(makeEscEvent()); } catch (err) { /* 忽略 */ }
				}
			}, 60);
		}
		/** 挂一次全局的 Esc 监听（幂等）。 */
		function installEscBridge() {
			if (typeof document === "undefined") return;
			/* 同 installPointerBridge：换掉上一份，保证压制逻辑来自**当前**实例。 */
			var prevEsc = document.__dshpEscHandler;
			if (prevEsc && typeof document.removeEventListener === "function") {
				try { document.removeEventListener("keydown", prevEsc, false); } catch (err) { /* 忽略 */ }
			}
			document.__dshpEscHandler = function (ev) {
				if (ev.key !== "Escape" || ev.__dshpSynthetic) return;
				armEscClose();
			};
			document.addEventListener("keydown", document.__dshpEscHandler, false);
		}

		/** 摘掉 pointer / Esc 两条 document 桥接（整层停用与 off() 用）。 */
		function removeBridges() {
			if (typeof document === "undefined") return;
			try {
				var b = document.__dshpBridgeHandler;
				if (b) {
					document.removeEventListener("pointerdown", b, false);
					document.removeEventListener("pointermove", b, false);
					document.__dshpBridgeHandler = null;
				}
				var e = document.__dshpEscHandler;
				if (e) {
					document.removeEventListener("keydown", e, false);
					document.__dshpEscHandler = null;
				}
			} catch (err) { /* 忽略 */ }
		}

		var veiledMenu = null;
		var veilTimer = null;
		function veilMenu(menu) {
			if (!menu || !menu.classList) return;
			if (veiledMenu && veiledMenu !== menu) unveilMenu();
			veiledMenu = menu;
			try { menu.classList.add("dshp-navBusy"); } catch (err) { /* 忽略 */ }
			if (veilTimer) clearTimeout(veilTimer);
			veilTimer = setTimeout(function () { unveilMenu(); }, 700);
		}
		function unveilMenu() {
			if (veilTimer) { clearTimeout(veilTimer); veilTimer = null; }
			if (veiledMenu) {
				try { veiledMenu.classList.remove("dshp-navBusy"); } catch (err) { /* 忽略 */ }
				veiledMenu = null;
			}
		}
		/** 把我们插进菜单的节点立刻收干净（不等下一轮扫描）。 */
		function clearOurNodes(menu) {
			if (!menu || !menu.querySelectorAll) return;
			var nodes = menu.querySelectorAll(
				"." + HEAD_CLASS + ",." + SLIDER_CLASS + ",." + LEVEL_LABEL_CLASS + ",." + MODEL_ROW_CLASS
			);
			for (var i = 0; i < nodes.length; i++) {
				try { nodes[i].remove(); } catch (err) { /* 忽略 */ }
			}
			try { menu.classList.remove("dshp-levelPage"); } catch (err) { /* 忽略 */ }
		}

		/**
		 * 导航循环的全局互斥锁 —— 卡死的主要来源。
		 *
		 * ⚠️ 为什么需要：openModelList 和 afterModelPicked 都是 rAF 循环
		 * （分别最多 240 / 300 帧，约 4s / 5s）。以前它们各自独立跑，而菜单节点的
		 * pointerdown 会同时触发 openModelList，模型项的点击又会调 afterModelPicked，
		 * 两个循环还能被各自的「菜单消失 → 重开触发器」分支**互相唤醒**。
		 * 一旦两个循环同时在跑，每帧都要走 hostPane()（找 React fiber +
		 * 遍历 hook 链，成本不低），主线程被占满 → 界面看起来就是"卡死"。
		 *
		 * 现在：同一时刻只允许一个导航循环。新请求到来时，
		 * 如果旧的还在跑就直接顶掉它（新的意图优先），保证任何时刻只有一条循环。
		 */
		var navLoopToken = 0;
		/** 开一个新导航循环，返回 token；旧循环的 token 会失效并自行退出。 */
		function beginNavLoop(maxFrames) {
			var token = ++navLoopToken;
			var tries = 0;
			return {
				token: token,
				/* 每 tick 返回 true = 继续，false = 退出循环 */
				tick: function (fn) {
					/* 被更新的循环顶掉了：本轮直接退出，不再做任何 DOM 操作。 */
					if (token !== navLoopToken) return false;
					if (++tries > maxFrames) return false;
					return fn() !== false;
				},
				done: function (cleanup) {
					/* 只有当前这个循环才有权收尾，避免旧循环把新循环的锁解掉。 */
					if (token !== navLoopToken) return;
					if (cleanup) cleanup();
				}
			};
		}

		/**
		 * 档位名守护表的句柄（模块级）。
		 *
		 * ⚠️ 为什么要提到模块级：这个表的闭包捕获了某个滑杆实例的 root/labels。
		 * 宿主重建菜单时会**再装一次滑杆**，如果句柄留在 installSlider 的局部作用域里，
		 * 新实例看不见旧实例的表 —— 于是每重建一次菜单就多留一个 2.5s / 40ms 的定时器，
		 * 它们各自在做 querySelector + 样式写。连续换几次档，页面上就挂着好几个，
		 * 主线程被占满，用户看到的就是"有时候会卡死"。
		 *
		 * 现在句柄全局唯一：新滑杆装上时先把上一个停掉，任何时刻最多一个表在跑。
		 */
		var sliderGuardTimer = null;
		function stopSliderGuard() {
			if (sliderGuardTimer) { clearInterval(sliderGuardTimer); sliderGuardTimer = null; }
		}

		/**
		 * 滑杆的 ResizeObserver 句柄（模块级，全局唯一）。
		 *
		 * ⚠️ 带观察目标的 ResizeObserver 会被**文档强引用**，不 disconnect 就永远
		 * 拽着回调闭包（measure → track/root/radios/menu…），连已脱离文档的菜单
		 * 节点一起留住。以前它造出来连引用都不存，宿主每重建一次滑杆就泄漏一份
		 * ——和触发器观察器是同一类病，而且这条更频繁。
		 */
		var sliderRo = null;
		function stopSliderRo() {
			if (sliderRo) { try { sliderRo.disconnect(); } catch (err) { /* 忽略 */ } sliderRo = null; }
		}

		/**
		 * 「本轮扫描是我们自己造成的」标记 —— 卡死的根治点。
		 *
		 * ⚠️ 自触发循环的完整链条（用户反馈"还是会卡"）：
		 *   主 MutationObserver 监听 body 整棵子树 → 回调里判断"变动是否碰到菜单"
		 *   → 碰���就调 scanBurst() → scan() → enhanceModelMenu()。
		 *   而 enhanceModelMenu 每轮都会写 DOM：insertBefore(head)、appendChild(row)、
		 *   slider.focus({preventScroll:true})、classList.add('dshp-levelPage')……
		 *   这些全都发生在**菜单内部**，于是又满足 mutationTouchesMenu 的条件 →
		 *   再次 scanBurst → 再次 enhanceModelMenu → 再次写 DOM……
		 *   扫描自己喂自己，永远停不下来，界面就卡死了。
		 *
		 * 修法：扫描期间置位 selfScanning，让这一轮自己引发的变动被忽略；
		 * 扫描结束后再放行外部真正的变动。
		 */
		var selfScanning = false;

		/**
		 * 这批 DOM 变动里有没有"菜单出现了或消失了"，值得跑一轮 scan。
		 *
		 * 认三种情况（少一种就会漏）：
		 *   ① 菜单**新增**（刚打开）；
		 *   ② 菜单**内部**被替换 —— 宿主在档位页 / 模型列表页之间切换时
		 *      复用同一个菜单节点，只换里面的内容，addedNodes 里全是列表项、
		 *      没有 [role='menu']，只判断 ① 会漏；
		 *   ③ 菜单**被移除**（收起）—— 浮层节点被整个摘掉，这条记录里
		 *      addedNodes 为空、target 也不在任何菜单内部。
		 *      漏掉它 = 收起后没人去把「选择强度」恢复成宿主原文案（用户截图确认）。
		 */
		function mutationTouchesMenu(rec) {
			var list = [rec.addedNodes, rec.removedNodes];
			for (var li = 0; li < list.length; li++) {
				var nodes = list[li];
				if (!nodes) continue;
				for (var i = 0; i < nodes.length; i++) {
					var n = nodes[i];
					if (!n || n.nodeType !== 1) continue;
					if ((n.matches && n.matches("[role='menu']")) ||
						(n.querySelector && n.querySelector("[role='menu']"))) return true;
				}
			}
			var tgt = rec.target;
			if (tgt && tgt.nodeType === 1 && tgt.closest && tgt.closest("[role='menu']")) return true;
			return false;
		}

		/**
		 * 造滑杆下面那一行：显示**当前模型名**（点它进模型列表）。
		 * 用户明确纠正过：这里保持模型名，不要改成别的文案。
		 */
		function buildModelRow(menu) {
			var name = modelName();
			if (!name) return null;
			var row = document.createElement("div");
			row.className = MODEL_ROW_CLASS;
			row.setAttribute("role", "presentation");
			var text = document.createElement("span");
			text.className = "dshp-modelName";
			text.textContent = name;
			var chev = document.createElement("span");
			chev.className = "dshp-modelChevron";
			chev.setAttribute("aria-hidden", "true");
			chev.textContent = "›";
			row.appendChild(text);
			row.appendChild(chev);
			return row;
		}

		/**
		 * 在模型列表里选了某个模型之后：
		 *   · 新模型**有**推理档位 → 重开菜单并推进到档位页（滑杆）
		 *   · 新模型**没有**推理档位 → 停在两行页，让用户再进列表
		 *
		 * 宿主"选中即关菜单"，所以要先点开触发器，再按 pane 一步步走到目标页。
		 */
		function afterModelPicked() {
			/* ⚠️ 换了模型，之前那次拖动留下的"优先显示"就不该再算数：
			   pickedUntil 有 3 秒窗口，期间滑杆会优先显示 pickedIndex —— 换模型后
			   那可能是旧模型的档位（档位数还不一样），滑杆会短暂显示错的档。
			   这里直接清掉，让滑杆以新模型的真实档位为准。 */
			pickedUntil = 0;
			pickedIndex = null;
			pickedModel = null;
			/* 重开触发器的重试表：宿主"选中即关"，但关菜单要等**异步**的
			   select() 返回（settleSelection → closeAfterSelection），
			   等待期间菜单还开着。所以这里不能只试一次：次数与间隔都设上限，
			   既扛得住慢往返，又不会把触发器点成开关来回来。 */
			var openTries = 0;
			var lastOpenTryAt = 0;
			/* 与 openModelList 共用同一个导航锁：同一时刻只有一个循环在跑，
			   两个循环互相唤醒是"卡死"的另一个来源。
			   上限 900 帧 ≈ 15s：换模型要等宿主往返，比 5s 宽松得多。 */
			var nav = beginNavLoop(900);
			function step() {
				if (!nav.tick(body)) return;
				requestAnimationFrame(step);
			}
			function body() {
				var pane = hostPane();
				if (pane === "effort") return false;        /* 到了档位页，收工 */
				var live = visibleMenu();
				if (!live) {
					/* 菜单被宿主关掉了（选中即关）：点触发器重新打开，
					   新菜单会走自动推进回到滑杆页 —— 用户要的"自然过渡"。 */
					var nowAt = Date.now();
					if (openTries < 4 && nowAt - lastOpenTryAt > 400) {
						openTries++; lastOpenTryAt = nowAt;
						var trigger = document.querySelector("[data-slot='conversation.input.model'] button");
						if (trigger) { try { trigger.click(); } catch (err) { /* 忽略 */ } }
						/* 同 openModelList：新菜单同步出现，立刻遮住，别露一帧两行页。 */
						var fresh = visibleMenu();
						if (fresh) { veilMenu(fresh); clearOurNodes(fresh); }
					}
					return true;
				}

				/* 新模型没有推理档位：直接打开模型列表，跳过空的档位页（用户要求）。
				   有档位：点第二行进滑杆页。 */
				var rows = menuRows(live);
				var onRoot = pane === "root" ||
					(pane === null && rows.length >= 2 && !live.querySelector(RADIO_SELECTOR));
				if (onRoot) {
					/* 消闪：从模型列表回流时同样要经过原生两行页。 */
					veilMenu(live);
					var effs = effortChoicesOf(live);
					markAdvancing(live);
					if (rows.length === 1) {
						/* ⚠️ 只有一行 = 这个模型没有推理档位（宿主根本没画那一格）。
						   直接进模型列表 —— 以前这里要等 1.5s 的导航锁过期后
						   才靠扫描补上，用户看到的是"菜单在两行页上卡一下"。 */
						rows[0].click();
						if (typeof nudgeMenu === "function") nudgeMenu();
					} else if (rows.length >= 2) {
						if (effs && effs.length === 0) {
							rows[0].click();              /* 没有档位 → 直接进模型列表 */
						} else {
							reasoningPage.set(live, true);
							rows[1].click();              /* 有档位 → 进滑杆页 */
						}
						if (typeof nudgeMenu === "function") nudgeMenu();
					}
					/* 一次点击就定了去向，不再继续轮询。 */
					return false;
				}
				if (pane === "model") {
					/* 还在模型列表：等宿主关菜单那一瞬，
					   上面「重开触发器」那一支会接手推进。 */
					markAdvancing(live);
					/* ⚠️ 必须**继续轮询**，不能 return false 退出：
					   宿主是「点中模型才关菜单」，而我们是挂在 pointerdown 上的，
					   这一帧菜单必然还开着（真机现象：选完模型就停在列表页，
					   永远等不到关菜单那一瞬，也就回不到滑杆页）。
					   继续轮询才能在下一次看到 live === null 时走「重开触发器」。 */
					return true;
				}
				/* pane 读不到时按 DOM 结构兜底（拿不到 fiber 的场景）。 */
				var radiosP = radiosOf(live);
				if (radiosP.length >= 2 && looksLikeLevelPage(radiosP)) return false;
				return true;
			}
			step();
		}

		/**
		 * 把输入框上那个触发器的文案改成「选择强度」。
		 *
		 * ⚠️ 两件事：
		 *   ① 不要改 title —— modelName() 从 title 读模型名（取 "·" 前那段），
		 *      改了会让**弹层里**的模型名也变成"选择强度"（真机污染过）。
		 *   ② React 每次重渲染都会把文案改回模型名，所以这个函数要**反复调用**
		 *      （挂在 scan 里，跟着其它增强一起跑）。
		 *   ③ 只在**滑杆页**显示「选择强度」；模型列表页和菜单关闭后恢复宿主原文案
		 *      （用户要求）。原文案**不缓存**：模型名与档位每次从触发器 title 实时
		 *      解析（modelName / effortLabelFromTitle）。缓存过一次换模型就不会更新
		 *      （真机反馈过），宿主换模型必然更新 title，所以重读一定拿到当前值。
		 */
		function relabelTrigger() {
			try {
				var btn = document.querySelector("[data-slot='conversation.input.model'] button");
				if (!btn) return;
				var lab = btn.querySelector("[class*='triggerLabel']");
				var eff = btn.querySelector("[class*='triggerEffort']");
				/* 当前是否停在滑杆页：菜单可见且带我们的等级页标记。 */
				var onLevelPage = false;
				var menus = document.querySelectorAll("[role='menu']");
				for (var m = 0; m < menus.length; m++) {
					var r = menus[m].getBoundingClientRect();
					if (r.width <= 0 || r.height <= 0) continue;
					if (menus[m].classList.contains("dshp-levelPage") ||
						menus[m].querySelector("." + SLIDER_CLASS)) { onLevelPage = true; break; }
				}
				/* ⚠️ 模型名**实时**从 title 解析，绝不缓存。
				   缓存过一次之后，换模型就不会更新了 —— 表现就是
				   「在列表里选了别的模型，触发器上的名称还是原来那个」
				   （用户反馈）。宿主每次换模型都会更新 title，
				   所以这里每次重读，拿到的一定是当前模型。 */
				var wantLabel = onLevelPage ? "选择强度" : modelName();
				if (!wantLabel) {
					/* 读不到 title 时退回文案本身（宿主已经把它渲染出来了）。 */
					wantLabel = (lab && lab.textContent && lab.textContent !== "选择强度")
						? lab.textContent : (lab ? lab.textContent : null);
				}
				if (lab && wantLabel !== null && lab.textContent !== wantLabel) lab.textContent = wantLabel;
				/* 档位名：滑杆页并进模型卡片了，这里清空；其它页面从 title 的
				   "· High" 那半边取，宿主没写 title 时保留现状。 */
				var wantEff = onLevelPage ? "" : effortLabelFromTitle();
				if (wantEff === null && !onLevelPage) wantEff = eff ? eff.textContent : null;
				if (eff && wantEff !== null && eff.textContent !== wantEff) eff.textContent = wantEff;
			} catch (err) { /* 忽略 */ }
		}

		function openModelList(menu, ev) {
			if (ev) { ev.preventDefault(); ev.stopPropagation(); }
			var now = Date.now();
			if (now - lastOpenModelsAt < 600) return;
			lastOpenModelsAt = now;

			/* ⚠️ 消闪第一步：立刻把菜单藏起来、并收掉我们插的灰框/滑杆。
			   接下来要走「Esc 退回两行页 → 点第一行」这条中转路线，
			   中间那几帧既会露出宿主的原生两行页，又会把我们插的节点
			   留在页面上（React 不认识它们，重渲染时不会替我们收）。 */
			if (menu) { veilMenu(menu); clearOurNodes(menu); }

			/* 目标：把菜单带到「模型列表」页（pane === 'model'）。
			   做法：从当前 pane 出发，点宿主的菜单行进到那里——
			   档位页(effort) → 两行页(root) → 模型列表(model)。
			   每步都靠 hostPane() 确认位置，不再靠派发 Escape 猜。 */
			/* 这次导航只处理当前菜单实例：宿主关掉重开时会换成新节点。 */
			var intentMenu = null;
			var escapeSentForMenu = null;
			var modelClickSentForMenu = null;
			/* 重开触发器的重试表（同 afterModelPicked：只试一次会漏掉
			   「菜单还没关就点了触发器 → 反而把它关掉」这种时序）。 */
			var openTries = 0;
			var lastOpenTryAt = 0;
			/* ⚠️ 走共享导航循环：同一时刻只会有一个循环在跑（卡死的根治点）。
			   上限 480 帧 ≈ 8s 兜底。 */
			var nav = beginNavLoop(480);
			function cleanup() { if (intentMenu) clearAdvancing(intentMenu); }
			function step() {
				if (!nav.tick(body)) return;
				requestAnimationFrame(step);
			}
			function body() {
				var pane = hostPane();
				/* 到了模型列表：解锁，让这一页之后还能被正常扫描/清理。 */
				if (pane === "model") {
					unveilMenu();          /* 落地了，揭开遮挡 */
					nav.done(cleanup);
					return false;
				}
				var live = visibleMenu();
				if (!live) {
					/* 菜单被宿主关掉了（Esc 是"关菜单"不是"退回上一层"）：
					   清掉本轮状态，重新点开触发器再来一次。 */
					unveilMenu();
					nav.done(cleanup);
					intentMenu = null;
					escapeSentForMenu = null;
					modelClickSentForMenu = null;
					var nowAt = Date.now();
					if (openTries < 4 && nowAt - lastOpenTryAt > 400) {
						openTries++; lastOpenTryAt = nowAt;
						var trigger = document.querySelector("[data-slot='conversation.input.model'] button");
						if (trigger) { try { trigger.click(); } catch (err) { /* 忽略 */ } }
						/* 宿主是离散事件同步渲染：菜单这一刻已经在了。
						   立刻遮住它，别让「两行页」露出来一帧。 */
						var fresh = visibleMenu();
						if (fresh) { veilMenu(fresh); clearOurNodes(fresh); }
					}
					return true;
				}
				if (intentMenu && intentMenu !== live) {
					clearAdvancing(intentMenu);
					escapeSentForMenu = null;
					modelClickSentForMenu = null;
				}
				intentMenu = live;

				var rows = menuRows(live);
				/* pane 读不到时按 DOM 兜底：radio 全是档位名 = 档位页，
				   两行 = [模型][推理等级]。两种结构都要认，只判断两行的话
				   档位页会静默卡住（真机 fiber 偶尔就读不到）。 */
				var radios2 = radiosOf(live);
				var onEffort = pane === "effort" ||
					(pane === null && !looksLikeModelList(live) && (radios2.length >= 2 &&
						(!!live.querySelector("." + SLIDER_CLASS) ||
							live.classList.contains("dshp-levelPage") ||
							allLevelWords(radios2))));
				var onRoot = pane === "root" ||
					(pane === null && !looksLikeModelList(live) && rows.length >= 2 &&
						!live.querySelector(RADIO_SELECTOR));

				if (onRoot) {
					/* 两行页：第一行是「模型」，点它进列表。
					   ⚠️ 这里以前还调了一次 effortChoicesOf()，结果**根本没被使用**，
					   而它要走 React fiber + 遍历 hook 链，是这条路径上最贵的一步。
					   每帧白跑一遍正是卡顿来源，已删掉。 */
					veilMenu(live);            /* 消闪：中转页不能露出来（顺带续期兜底表） */
					markAdvancing(live);
					if (modelClickSentForMenu !== live && rows.length >= 1) {
						modelClickSentForMenu = live;
						rows[0].click();      /* 第一行 = 模型 → 进列表 */
						if (typeof nudgeMenu === "function") nudgeMenu();
					}
					return true;
				}

				if (onEffort) {
					/* 档位页：宿主没有"返回"按钮，只能用 Esc 退回上一层。
					   ⚠️ 派发到**焦点元素 + document**：
					   宿主的 onRootKeyDown 是 React 合成事件，挂在根容器上，
					   只派发给菜单元素它收不到（真机实测完全不动）。 */
					/* 暂停自动推进，避免回到两行页时被立刻又推进回档位页。
					   每个菜单实例只发一次，避免连续 Esc 把菜单整个关掉。 */
					markAdvancing(live);
					if (escapeSentForMenu === live) return true;
					escapeSentForMenu = live;
					var target = document.activeElement;
					if (!target || !live.contains(target)) {
						target = live.querySelector("." + SLIDER_CLASS) ||
							live.querySelector(RADIO_SELECTOR) || live;
					}
					var targets = [];
					if (target && target.dispatchEvent) targets.push(target);
					if (document.dispatchEvent) targets.push(document);
					for (var i = 0; i < targets.length; i++) {
						try {
							var esc = new KeyboardEvent("keydown", {
								key: "Escape", code: "Escape", keyCode: 27, which: 27,
								bubbles: true, cancelable: true, composed: true,
							});
							/* 滑杆的 Esc 处理器见到这个标记会直接返回，
							   不会补发第二次 Escape 把菜单关掉（真机回归的根因）。 */
							try { esc.__dshpSynthetic = true; } catch (e) { /* 忽略 */ }
							targets[i].dispatchEvent(esc);
						} catch (err) { /* 忽略 */ }
					}
					return true;
				}
				return true;
			}
			step();
		}

		/**
		 * 给模型列表页里的每一项挂监听：选中后触发 afterModelPicked。
		 * 只在"看起来像模型列表"时挂（不是等级页、没有滑杆）。
		 */
		function hookModelPicks(menu) {
			if (!menu || menu.classList.contains("dshp-levelPage")) return;
			if (menu.querySelector("." + SLIDER_CLASS)) return;
			/* ⚠️ 只给**模型选单**挂。别的菜单里同样可能有 menuitemradio
			   （单选设置项、列表选择器…），挂上后用户一点就会触发
			   "回流滑杆页"的导航：菜单被关了又开，看起来像灵异事件。 */
			if (!looksLikeModelList(menu) && paneOf(menu) !== "model") return;
			/* ⚠️ 必须是**模型列表页**才挂，不能见到 radio 就挂：
			   宿主的原生两行页（模型 / 推理等级）也是 role=menuitem，
			   给它挂上会让"点灰框进列表"刚打开就被弹回档位页（真机回归）。
			   模型列表的判据：里面的项是 menuitemradio（模型是单选项），
			   而两行页的项是 menuitem。 */
			/* ⚠️ 必须用**后代**查询，不能限定直接子级：宿主的模型项是包在
			   section[role='group']（MenuGroup）里的，:scope > 在真机上
			   一个都找不到 —— 于是"选完模型回流滑杆页"整条链路从未生效
			   （真机复现：列表里点模型毫无反应）。 */
			var items = menu.querySelectorAll("[role='menuitemradio']");
			if (items.length < 2) return;
			/* 再确认一次：这项项的文本不是推理档位名。 */
			var levelLike = 0;
			for (var q = 0; q < items.length; q++) {
				if (LEVEL_WORDS.test(labelOf(items[q]))) levelLike++;
			}
			if (levelLike === items.length) return;   /* 全是档位名 → 是等级页 */
			/* 明确停在档位页时也不挂（词表可能漏掉某个自定义档位名）。 */
			if (!looksLikeModelList(menu) && hostPane() === "effort") return;
			for (var i = 0; i < items.length; i++) {
				var el = items[i];
				if (el.dataset.dshpPickHooked === "1") continue;
				el.dataset.dshpPickHooked = "1";
				/* 用 pointerdown：宿主在这一刻就会开始关闭菜单。 */
				el.addEventListener("pointerdown", function () {
					setTimeout(afterModelPicked, 0);
				}, true);
			}
		}

		/**
		 * 菜单重开后，把滑杆停到用户刚选的那一档。
		 *
		 * ⚠️ 这里以前只有调用、没有定义（applyPicked 未定义 → ReferenceError 被
		 * 上层的 try/catch 吞掉），于是「装好后停到选中档」这步静默失败：
		 * 重开菜单时滑杆回到宿主默认值，看起来就是"选了没生效"。
		 * 现在实现为：复用滑杆自己暴露的 __dshpSyncIndex 钩子（幂等、不重排）。
		 */
		function applyPicked(menu, slider, radios, idx) {
			if (!slider || typeof slider.__dshpSyncIndex !== "function") return;
			try {
				var i = Math.max(0, Math.min(idx, radios.length - 1));
				slider.__dshpSyncIndex(i);
				/* 让顶部档位名和刻点也跟过去（paint 在钩子里已经做了）。 */
				pickedIndex = i;
			} catch (err) { /* 忽略 */ }
		}

		/**
		 * 当前模型的推理档位列表（从宿主 state 里读）。
		 * 返回 [] 表示这个模型**没有**推理强度可选——此时不该进档位页。
		 */
		function effortChoicesOf(menu) {
			try {
				var f = findModelSelectFiber(menu);
				if (!f) return null;
				var sel = readHostSelection(f);
				if (!sel || !sel.groups) return null;
				for (var gi = 0; gi < sel.groups.length; gi++) {
					var g = sel.groups[gi];
					if (!g || g.id !== sel.provider) continue;
					for (var mi = 0; mi < (g.models || []).length; mi++) {
						var mo = g.models[mi];
						if (!mo || mo.id !== sel.model) continue;
						var effs = mo.reasoning && mo.reasoning.efforts;
						return effs && effs.length ? effs : [];
					}
				}
			} catch (err) { /* 忽略 */ }
			return null;
		}

		/**
		 * 宿主当前停在哪一页——这是界面状态的**唯一真相**，别再用自建标记去猜。
		 *
		 * ModelSelect 里有 pane 状态，三个取值：
		 *   root   = 原生两行（模型 / 推理等级）
		 *   model  = 模型列表
		 *   effort = 推理档位页（我们要在这里装滑杆）
		 *
		 * 以前我们用 5 个自建标记去猜，它们互相覆盖、还会随复用的 DOM 残留，
		 * 导致流转时好时坏。现在一律读 pane。
		 * 取不到返回 null（表示"读不到，别做判断"）。
		 */
		 /**
		  * 当前**真正可见**的那个菜单。
		  *
		  * ⚠️ 不能用 document.querySelector("[role='menu']")：宿主文档里藏着
		  * 好几个 hidden 的 [role='menu']（设置引导、侧栏抽屉等），它们排在
		  * 浮层前面，querySelector 会先把它们挑出来 —— 于是 fiber 找不到
		  * ModelSelect、pane 永远读成 null，插件只好去猜，一猜就错
		  * （真机：模型列表里有个模型叫 auto，正好命中档位词表，列表页被
		  * 误判成档位页 → 反复按 Esc 往回退 → 两个界面来回跳）。
		  */
		function visibleMenu() {
			if (typeof document === "undefined") return null;
			var all = document.querySelectorAll("[role='menu']");
			for (var i = 0; i < all.length; i++) {
				var r = all[i].getBoundingClientRect();
				if (r.width > 0 && r.height > 0) return all[i];
			}
			return null;
		}
		/**
		 * 这个菜单是不是"模型列表页"。
		 *
		 * 结构判据（来自宿主真实结构）：模型列表页的外壳是 role="group"，
		 * 真正的列表是里面单独一层 [role='menu']，分组是 section[role='group']。
		 * 档位页/两行页则是外壳自己带 role="menu"，没有 group 祖先。
		 * 有了它，「列表里有个模型叫 auto」这种命名撞车就不会再把列表页
		 * 误判成档位页。
		 */
		function looksLikeModelList(menu) {
			if (!menu) return false;
			try {
				if (menu.closest && menu.closest("[role='group']")) return true;
				if (menu.querySelector && menu.querySelector("[role='searchbox']")) return true;
			} catch (err) { /* 忽略 */ }
			return false;
		}
		/**
		 * 菜单里有没有**模型选单自己的标记**（档位行的 optionCopy/modelName，
		 * 或两行页单元格的 cellLabel/cellValue）。宿主别的菜单用的是另一套类名，
		 * 所以这可以当作"这是模型选单"的结构证据 —— 在读不到 fiber 的兜底路径上
		 * 用它，避免把别人的单选列表当成档位页装上滑杆。
		 */
		function hasModelSelectMarkup(menu) {
			if (!menu || !menu.querySelector) return false;
			try {
				return !!menu.querySelector(
					"[class*='optionCopy'], [class*='modelName'], [class*='cellLabel'], [class*='cellValue']"
				);
			} catch (err) { /* 忽略 */ }
			return false;
		}
		/**
		 * 从菜单节点往上找 ModelSelect 组件的 fiber。
		 *
		 * ⚠️ 必须放在**模块级**：以前它被关在 installSlider 里面，
		 * 而模块级的 hostPane()/effortChoicesOf() 都在调它 —— 作用域看不到，
		 * 直接抛 ReferenceError 被 try/catch 吞掉，于是 hostPane() **永远返回 null**，
		 * 整个插件从"读宿主 pane"退化成"靠 DOM 猜"，一猜就错
		 * （真机：模型列表里有个模型叫 auto，被当成档位页 → 界面来回跳）。
		 */
		function findModelSelectFiber(menu) {
			if (!menu) return null;
			var key = null, keys = Object.keys(menu);
			for (var ki = 0; ki < keys.length; ki++) {
				if (keys[ki].indexOf("__reactFiber$") === 0) { key = keys[ki]; break; }
			}
			if (!key) return null;
			var f = menu[key];
			for (var d = 0; f && d < 24; d++) {
				if (typeof f.type === "function" && /ModelSelect/.test(f.type.name || "")) return f;
				f = f.return;
			}
			return null;
		}
		/**
		 * 读宿主当前的「供应商 + 模型 + 档位」。
		 *
		 * ⚠️ 值藏在第一个 hook 的 memoizedState.current 里（useSyncExternalStore 的
		 * snapshot），不是 memoizedState 本身——直接读 memoizedState.provider 会拿到
		 * undefined，然后 submitEffort 失败、退回点 radio、菜单就被关掉（真机踩过）。
		 */
		function readHostSelection(f) {
			if (!f) return null;
			var h = f.memoizedState;
			for (var hi = 0; h && hi < 40; hi++) {
				var v = h.memoizedState;
				if (v && v.current && v.current.provider !== undefined) {
					return { provider: v.current.provider, model: v.current.model,
						reasoningEffort: v.current.reasoningEffort, groups: v.groups || null };
				}
				if (v && v.provider !== undefined) {
					return { provider: v.provider, model: v.model, reasoningEffort: v.reasoningEffort, groups: null };
				}
				h = h.next;
			}
			return null;
		}

		/** 当前菜单所属的「供应商+模型」键，用于判断 pickedIndex 是不是还属于这个模型。
		    读不到 fiber 时返回 null（调用方按"不匹配"处理，宁可不兑现刚滑的档）。 */
		function modelKeyOf(menu) {
			try {
				var sel = readHostSelection(findModelSelectFiber(menu));
				if (!sel || sel.provider === undefined) return null;
				return sel.provider + "\u0000" + sel.model;
			} catch (err) { return null; }
		}
		/** 读**指定**菜单所属 ModelSelect 的页状态；读不到返回 null。 */
		function paneOf(menu) {
			try {
				if (!menu) return null;
				var f = findModelSelectFiber(menu);
				if (!f) return null;
				var h = f.memoizedState;
				for (var i = 0; h && i < 40; i++) {
					var v = h.memoizedState;
					if (typeof v === "string" && (v === "root" || v === "model" || v === "effort")) return v;
					h = h.next;
				}
			} catch (err) { /* 忽略 */ }
			return null;
		}
		/**
		 * 当前可见菜单停在哪一页。
		 * ⚠️ 需要针对"某个具体菜单"判断时（比如增强器手里那个），用 paneOf(menu)，
		 * 别用这个 —— 同时有别的菜单可见时，它读到的可能不是你要的那个。
		 */
		function hostPane() { return paneOf(visibleMenu()); }

		function radiosOf(menu) {
			return Array.prototype.slice.call(menu.querySelectorAll(RADIO_SELECTOR));
		}
		function checkedIndex(radios) {
			for (var i = 0; i < radios.length; i++) {
				if (radios[i].getAttribute("aria-checked") === "true") return i;
			}
			return 0;
		}
		function labelOf(el) {
			return String((el && el.textContent) || "").replace(/\s+/g, " ").trim();
		}

		/**
		 * 让宿主用**增强后的新高度**重算一次菜单位置。
		 *
		 * 宿主是拿"增强之前"的高度算的 top；它的 ResizeObserver 对这个浮层又不生效
		 * （实测把面板撑高 60px，style.top 也纹丝不动），于是菜单比该在的位置高出一截
		 * ——实测间隙 45px，而宿主自己的间距是 8px。
		 * 宿主在 window 上监听 resize 会重算，所以主动派发一次：
		 * 不用猜任何数字，位置交给宿主自己算。
		 */
		function realignMenu(menu) {
			if (!menu || menu.dataset.dshpRealign === "1") return;
			menu.dataset.dshpRealign = "1";
			var fire = function () {
				try { window.dispatchEvent(new Event("resize")); } catch (err) { /* 忽略 */ }
			};
			fire();
			/* 滑杆刚插入、字体还没落位，下一帧再补一次。 */
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(fire);
		}

		/** 在一个"选项列表"菜单里装上滑杆；不是选项列表就什么都不做。 */
		function installSlider(menu) {
			if (!menu || !menu.querySelectorAll) return null;
			var radios = radiosOf(menu);
			if (radios.length < 2) return null;
			if (menu.querySelector(".dshp-slider")) return null;

			var labels = radios.map(labelOf);
			var index = checkedIndex(radios);
			var dragging = false;
			/* 这次按下有没有真的开始拖（用来区分"点击"和"拖动"）。 */
			var dragMoved = false;
			var preview = index;
			/* 这个滑杆接管守护表：先停掉上一个实例留下的（见 stopSliderGuard 注释）。 */
			var guardUntil = 0;
			stopSliderGuard();
			/* 同理接管尺寸观察器：新滑杆装上时先断掉上一个实例的（见 stopSliderRo）。 */
			stopSliderRo();
			function stopGuard() {
				stopSliderGuard();
				guardUntil = 0;
			}

			var root = document.createElement("div");
			root.className = "dshp-slider";
			root.setAttribute("role", "slider");
			root.setAttribute("tabindex", "0");
			root.setAttribute("aria-label", "推理等级");
			root.setAttribute("aria-valuemin", "0");
			root.setAttribute("aria-valuemax", String(radios.length - 1));

			var track = document.createElement("div");
			track.className = "dshp-sliderTrack";
			var fill = document.createElement("div");
			fill.className = "dshp-sliderFill";
			var dots = document.createElement("div");
			dots.className = "dshp-sliderDots";
			for (var d = 0; d < radios.length; d++) {
				var dot = document.createElement("span");
				dot.className = "dshp-sliderDot";
				dots.appendChild(dot);
			}
			var knob = document.createElement("div");
			knob.className = "dshp-sliderKnob";
			track.appendChild(fill);
			track.appendChild(dots);
			track.appendChild(knob);
			root.appendChild(track);

			function pct(i) {
				return radios.length <= 1 ? 0 : i / (radios.length - 1);
			}
			/** 吸附到第 i 档：位置 + 文字 + 刻点一起更新（带 CSS 过渡）。 */
			function paint(i) {
				preview = i;
				writePos(pct(i));
				syncLabelsTo(i);
			}
			function clear() {
				for (var k = 0; k < radios.length; k++) radios[k].removeAttribute("data-dshp-target");
			}
			/** 只同步「档位名 + 刻点 + 行高亮」，不碰 --dshp-t（那个由连续拖动负责）。 */
			function syncLabelsTo(i) {
				root.setAttribute("aria-valuenow", String(i));
				root.setAttribute("aria-valuetext", labels[i] || "");
				var label = menu.querySelector("." + LEVEL_LABEL_CLASS);
				if (label && labels[i] && label.textContent !== labels[i]) {
					label.textContent = labels[i];
					/* ⚠️ 动效不能从 opacity:0 开始：
					   拖动跨档时守护定时器会同时写文字，两者叠加看着就是"闪一下"。
					   改成轻微回弹（opacity 0.55→1 + 极小的纵向位移），
					   既看得出变化，又不会整块消失。
					   用 WAAPI 而不是「摘类→读 offsetWidth→加类」，避免强制同步布局。 */
					try {
						if (label.animate) {
							label.animate(
								[
									{ opacity: 0.55, transform: "translateY(2px) scale(0.97)" },
									{ opacity: 1, transform: "translateY(0) scale(1)" }
								],
								{ duration: 200, easing: "cubic-bezier(.2,.6,.2,1)" }
							);
						}
					} catch (err) { /* 忽略 */ }
				}
				for (var k = 0; k < radios.length; k++) {
					dots.children[k].classList.toggle("dshp-sliderDotOn", k <= i);
					radios[k].toggleAttribute("data-dshp-target", k === i);
				}
			}
			/**
			 * 提交：把用户选的档位真正应用下去，**并且让菜单保持打开**。
			 *
			 * 从宿主源码里挖到的机制：
			 *   const closeAfterSelection = () => { setSelectionFocus(true); close(true); };
			 *   const chooseEffort = (effort) => {
			 *     if (effectiveEffort === effort) { closeAfterSelection(); return; }
			 *     submit({ ...reasoningEffort: effort });   // 这条不关菜单
			 *   };
			 * 也就是说，**点宿主的 radio 会走 closeAfterSelection → 菜单必然关闭**，
			 * 我们再去重开就会"关→开"闪一下（用户反馈的闪烁）。
			 *
			 * 正解是根本不点它：直接调 props 上的 select()（React 组件自己的提交函数），
			 * 它只负责应用档位，不碰 open 状态。实测菜单全程不关、零报错。
			 */
			function commit(i) {
				clear();
				pickedIndex = i;
				/* ⚠️ pickedUntil 以前**从未被赋值**（恒为 0），
				   于是 wantIdx 的判断永远为假，重开菜单时用户刚选的档位被宿主默认值顶掉
				   —— 表现就是"选完 High，一重开又变回 Low"。
				   现在给 3 秒窗口：这段时间内重开菜单优先显示用户选的那一档。 */
				pickedUntil = Date.now() + 3000;
				/* 记下这一档属于哪个模型：换模型若不经过 afterModelPicked，
				   靠这个键判断 pickedIndex 是否还该兑现（见变量声明的注释）。 */
				pickedModel = modelKeyOf(root.closest("[role='menu']"));
				var ok = submitEffort(i);
				if (ok) {
					/* 宿主的 select() 会触发重渲染，把我们刚写的档位名冲掉
					   （真机现象：滑杆位置对了、刻点对了，但顶部显示的是上一档）。
					   这里持续盯 1.2 秒：只要发现标签不是用户选的那一档就写回去。
					   用 setInterval 而不是 rAF，因为要跨越宿主的重渲染时刻。 */
					/* ⚠️ 这个定时器只负责"宿主重渲染把我们的写入冲掉时补回去"。
					   以前它闭包捕获了 commit 时的 i，于是每 40ms 都把标签写回**那一档**，
					   和用户随后的拖动打架 —— 表现就是"文字不动"或"闪一下"。
					   现在改成读 pickedIndex（拖动会同步更新它），并在拖动时彻底停表。 */
					/* ⚠️ 而且只保留**一个**全局守护表：以前每 commit 一次就新起一个
					   2.5s / 40ms 的 setInterval，连续换档会叠出好几个，
					   每个都在做 querySelector + 样式写 —— 主线程被占满就是"卡死"。
					   现在新 commit 只是把同一个表的截止时间往后推。 */
					guardUntil = Date.now() + 2500;
					if (!sliderGuardTimer && typeof setInterval === "function") {
						sliderGuardTimer = setInterval(function () {
				/* 用户又开始拖了：停表，把界面完全交给拖动逻辑。 */
				if (dragging || root.classList.contains("dshp-sliderPressed")) { stopGuard(); return; }
				if (Date.now() > guardUntil) { stopGuard(); return; }
				var menu = root.closest("[role='menu']");
				if (!menu) { stopGuard(); return; }
				/* 用当前"用户选中的档位"，不是闭包里的旧值。 */
				var cur = (typeof pickedIndex === "number" && pickedIndex >= 0) ? pickedIndex : i;
				var lb = menu.querySelector("." + LEVEL_LABEL_CLASS);
				var tx = labels[cur];
				if (lb && tx && lb.textContent !== tx) lb.textContent = tx;
				/* 位置变量要一起写（--dshp-t 与 --dshp-x 必须同步）。 */
				var sl = menu.querySelector("." + SLIDER_CLASS);
				if (sl) {
				var want = pct(cur);
				if (sl.style.getPropertyValue("--dshp-t") !== String(want)) {
				sl.style.setProperty("--dshp-t", String(want));
				sl.style.setProperty("--dshp-x", (travelPx * want) + "px");
				writeFill(travelPx * want);
				}
				/* ⚠️ 位置没变时也必须保住填色：React 重渲染会重建 style（--dshp-fillW
				   丢失）或把它重置成 0，只盯着 --dshp-t 的话这一段没人补 ——
				   填色和滑钮短暂脱节，最右档就又露出灰边（"没填满"的残留来源）。 */
				else if (sl.style.getPropertyValue("--dshp-fillW") === "" ||
					parseFloat(sl.style.getPropertyValue("--dshp-fillW")) <= 0) {
					writeFill(travelPx * want);
				}
				}					}, 40);
					}
				}
				if (!ok) {
					/* 拿不到 React 的 select 时的退路：点宿主的 radio。
					   这条路径会让宿主关掉菜单（它内部调 closeAfterSelection），
					   属于极端兜底——正常情况下永远走上面的 select()。 */
					var radio = radios[i];
					if (radio) { try { radio.click(); } catch (err) { /* 忽略 */ } }
				}
			}

			/**
			 * 直接调用 ModelSelect 的 select() 应用档位。
			 * 从菜单节点上的 React fiber 里取组件的 props 与当前选择。
			 * 返回 true 表示调用成功。
			 */
			function submitEffort(idx) {
				var menu = root.closest("[role='menu']");
				if (!menu) return false;
				try {
					var f = findModelSelectFiber(menu);
					if (!f || typeof f.memoizedProps.select !== "function") return false;
					var cur = readHostSelection(f);
					if (!cur) return false;
					var id = effortIdOf(radios, idx, f, cur);
					var sel = { provider: cur.provider, model: cur.model };
					if (id !== null) sel.reasoningEffort = id;
					f.memoizedProps.select(sel);
					return true;
				} catch (err) {
					return false;
				}
			}

			/**
			 * 第 idx 个档位对应的 effort id。
			 * 优先读宿主自己渲染出来的 radio 上的属性；读不到就按序号映射。
			 */
			function effortIdOf(radiosList, idx, fiber, cur) {
				var r = radiosList[idx];
				if (!r) return null;
				/* 首选：从宿主自己的 groups 里读这个模型的真实档位 id 列表。
				   比按标签猜可靠（标签可能被本地化，id 不会）。 */
				try {
					var sel = cur || readHostSelection(fiber || findModelSelectFiber(root.closest("[role='menu']")));
					var groups = sel && sel.groups;
					if (groups) {
						for (var gi = 0; gi < groups.length; gi++) {
							var g = groups[gi];
							if (!g || g.id !== sel.provider) continue;
							for (var mi = 0; mi < (g.models || []).length; mi++) {
								var mo = g.models[mi];
								if (!mo || mo.id !== sel.model) continue;
								var effs = mo.reasoning && mo.reasoning.efforts;
								if (effs && effs.length) {
									/* 宿主的档位列表可能比 radio 多一个「provider 默认」项，先对齐长度。 */
									var offset = radiosList.length - effs.length;
									var ii = idx - (offset > 0 ? offset : 0);
									if (ii >= 0 && ii < effs.length) return effs[ii].id;
									/* ⚠️ 选中行落在「provider 默认」区（ii<0）或超出档位列表 →
									   返回 null = 提交时不带 reasoningEffort（宿主自己就会应用
									   该模型的默认档）。绝不能落到下面的按标签猜：宿主渲染的
									   「Default」行 effort 本来就是 undefined，猜成字符串
									   "default" 提交出去，宿主直接报 model-unavailable:
									   does not support reasoning effort "default"（真机截图：
									   Ling 3.0 只有 low/xhigh/max 三档，第一行叫 Default）。 */
									return null;
								}
							}
						}
					}
				} catch (err) { /* 忽略 */ }
				/* 兜底：档位名小写（Off/Low/High/Max → off/low/high/max）。
				   ⚠️ 但宿主自己渲染的「Default」行没有对应的 effort id ——
				   把它猜成字符串 "default" 提交，宿主必拒（真机踩过）。 */
				var txt = labelOf(radios[idx]).trim();
				if (/^(default|provider default|provider默认|默认)$/i.test(txt)) return null;
				return txt.toLowerCase() || null;
			}

			/* 轨道几何缓存：拖动期间轨道不会动，量一次就够。
			   每帧都 getBoundingClientRect 会造成强制同步布局（实测 7.57 次/移动）。 */
			var geo = null;
			var travelPx = 0;
			/* 滑钮的**实测**宽度（offsetWidth）。写死角 22 会在真机上出错：
			   填色盖到「位置 + 22」而滑钮右缘在「位置 + 实际宽」，差多少就露多少灰边
			   （用户反馈：最右档时右边还是没填满）。 */
			var knobW = 22;
			function measureGeo() {
				var r = track.getBoundingClientRect();
				geo = r.width > 0 ? { left: r.left, width: r.width } : null;
				root.__dshpGeo = geo;      /* 供 pointerBridge / hover 标签联动复用 */
				/* 行程（px）算好给 CSS 用：calc() 不支持 var*var，
				   所以位移一律由 JS 算成 px 写进 --dshp-x。 */
				if (geo) {
					var kw2 = knob.offsetWidth || 22;   /* 同上：不能用 getBoundingClientRect */
					knobW = kw2;
					var want = Math.max(0, geo.width - kw2);
					/* ⚠️ 只在变化时写，并且**必须真的更新**：
					   菜单是分帧长出来的，早期量到的宽度偏小（实测 185.36 vs 应有 194），
					   如果这里不校正，滑钮走的距离就比手指少，越往右偏差越大。 */
					if (Math.abs(want - travelPx) > 0.5) {
						travelPx = want;
						root.style.setProperty("--dshp-travel", travelPx + "px");
						root.style.setProperty("--dshp-x", (travelPx * preview / Math.max(1, radios.length - 1)) + "px");
						writeFill(travelPx * preview / Math.max(1, radios.length - 1));
					}
				}
				return geo;
			}
			/** 把 0~1 的进度写成滑钮的像素位移（CSS 只做读取）。 */
			function writePos(f) {
				root.style.setProperty("--dshp-t", String(f));
				root.style.setProperty("--dshp-x", (travelPx * f) + "px");
				writeFill(travelPx * f);
			}
			/**
			 * 填色：直接写"右端像素"（= 滑钮位置 + 滑钮实测宽度 = 滑钮右缘）。
			 *
			 * ⚠️ 这里**故意不做比例换算**：以前用 (位置+宽)/(行程+宽) 的比例喂给
			 * scaleX，只要"行程"或"滑钮宽度"有一点点量不准（真机上就发生过：
			 * 滑钮实际宽度不是 22），填色右端就会比滑钮右缘短一截 ——
			 * 最右档看着就是"右边没填满"（用户两次反馈）。
			 * 现在直接把右端像素写成宽度：几何上按定义对齐，最右档时宽度正好等于
			 * 整条轨道宽，**不可能**差一点。
			 */
			function writeFill(x) {
				var kw = knobW || 22;
				var full = travelPx + kw;         /* = 轨道宽度 */
				if (full <= 0) { root.style.setProperty("--dshp-fillW", "0px"); return; }
				var right = Math.min(x + kw, full);
				/* 位置已经在最右端：直接写满（浮点误差也不该露一条底色）。 */
				if (x >= travelPx - 0.5) right = full;
				root.style.setProperty("--dshp-fillW", right + "px");
			}
			/**
			 * 连续的 0~1 位置（不做整数吸附）——拖动时用它，滑钮才跟手不跳。
			 *
			 * ⚠️ 必须按「滑钮可用区间」归一化，不能用整条轨道宽度：
			 *   滑钮直径 22px，它只能从 (left + 11) 走到 (right - 11)，
			 *   而 CSS 里的位移是 travel * t（travel = 轨道宽 - 22）。
			 *   用整宽算会让手指与滑钮越靠两端偏差越大（实测起点 +22px、终点 -43px）。
			 */
			function fracAt(clientX) {
				var g = geo || measureGeo();
				if (!g) return null;
				/* ⚠️ 用实测滑钮宽（knobW），不写死 22：与 measureGeo/writeFill 同一口径。
				   写死时一旦实际宽度不是 22，落点换算和滑钮行程就对不上。 */
				var kw = knobW || 22;
				var travel = g.width - kw;          /* 滑钮可移动距离 */
				if (travel <= 0) return 0;
				var t = (clientX - g.left - kw / 2) / travel;
				return t < 0 ? 0 : t > 1 ? 1 : t;
			}
			/** 只按连续比例更新视觉，不动档位名（拖动过程中不刷字，避免频繁重排）。 */
			function paintFrac(f) {
				writePos(f);
			}

			track.addEventListener("pointerdown", function (ev) {
				if (ev.button !== 0) return;
				dragging = true;
				dragMoved = false;
				try { track.setPointerCapture(ev.pointerId); } catch (err) { /* 老浏览器忽略 */ }
				/* ⚠️ 按下只"握起"，**不要**立刻 paint、也不要立刻切到拖动模式：
				   以前按下就 paintFrac + 关掉过渡，滑钮是**瞬移**到按下点的——
				   点一下看着很硬（用户反馈"点击动画太硬"）。
				   现在：按下只给按压反馈（滑钮微微放大），位置等松手时
				   带过渡滑过去；真开始拖了才在第一次 move 切到"跟手模式"。 */
				root.classList.add("dshp-sliderPressed");
				measureGeo();   /* 按下时量一次，整个拖动过程复用（避免每帧读布局） */
				ev.preventDefault();
			});
			track.addEventListener("pointermove", function (ev) {
				if (!dragging) return;
				var f = fracAt(ev.clientX);
				if (f === null) return;
				/* 真的在拖了：切到跟手模式 —— 过渡关掉，位置逐帧跟手指走。 */
				if (!dragMoved) {
					dragMoved = true;
					root.classList.remove("dshp-sliderPressed");
					root.classList.add("dshp-sliderActive");
				}
				/* 每帧只做一次位置写入（合成层属性），跨档时才更新文字与刻点。 */
				writePos(f);
				var idx = Math.round(f * (radios.length - 1));
				if (idx !== preview) {
					preview = idx;
					pickedIndex = idx;   /* 守护定时器读它，保持同步 */
					syncLabelsTo(idx);
				}
			});
			function endDrag(ev) {
				if (!dragging) return;
				dragging = false;
				root.classList.remove("dshp-sliderActive");
				root.classList.remove("dshp-sliderPressed");
				try { track.releasePointerCapture(ev.pointerId); } catch (err) { /* 同上 */ }
				var f = ev && typeof ev.clientX === "number" ? fracAt(ev.clientX) : null;
				geo = null;   /* 下次按下重新量 */
				var target = f === null ? preview : Math.round(f * (radios.length - 1));
				/* ⚠️ index 是"当前生效的档位"，提交后必须跟着更新。
				   以前它初始化后就再没变过，导致连续拖动时
				   target !== index 的判断一直拿第一次的档位比，
				   于是"拖回原档"不提交、该提交的又漏掉，宿主状态和滑杆对不上。 */
				if (target !== index) {
					/* ⚠️ 顺序要紧：先 commit 再 paint。
					   以前是先 paint（启动 260ms 过渡）再 commit，
					   commit 会让宿主重渲染、把位置重置回旧档，
					   两者打架就是"点击切换会闪一下"（拖动时因为位置已经连续更新过，
					   所以看不出这个问题）。
					   改成先提交：等宿主状态落地后，再让位置平滑跟到目标档。 */
					index = target;      /* 立刻记为当前档，后续比较才正确 */
					commit(target);      /* 先真正应用 */
					paint(target);       /* 再让视觉平滑跟上（此时不会被打断） */
				} else {
					paint(index);        /* 原地松手：平滑回位 */
				}
			}
			track.addEventListener("pointerup", endDrag);
			track.addEventListener("pointercancel", function () {
				dragging = false;
				root.classList.remove("dshp-sliderActive");
				root.classList.remove("dshp-sliderPressed");
				paint(index);
			});

			root.addEventListener("keydown", function (ev) {
				/* ⚠️ 关于 Esc：
				   宿主自己的 Esc 有两个层级——第一次「退回上一层」，再按才「关闭菜单」。
				   我们**不能** stopPropagation 拦掉它：那样宿主的关闭逻辑收不到事件，
				   菜单会永远关不掉（真机回归：Esc 完全失效、灰框也进不去列表，
				   因为 openModelList 正是靠派发 Escape 来切换的）。
				   正确做法：让事件照常冒泡给宿主，我们只在它「退回上一层」之后
				   补一次 Escape，确保一次按键就把菜单关干净。 */
				if (ev.key === "Escape") {
					/* 交给全局的 Esc 接管（armEscClose）：它会在宿主"退回上一层"
					   之后补一次 Esc，并顺带压住自动推进 —— 三者都在一处，
					   不再散在滑杆里各管一段。这里只放行，不拦事件。 */
					return;
				}
				var next = null;
				if (ev.key === "ArrowRight" || ev.key === "ArrowUp") next = Math.min(radios.length - 1, index + 1);
				else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") next = Math.max(0, index - 1);
				else if (ev.key === "Home") next = 0;
				else if (ev.key === "End") next = radios.length - 1;
				if (next === null || next === index) return;
				ev.preventDefault();
				ev.stopPropagation();
				index = next;
				paint(next);
				commit(next);
			});
			/* 点滑杆本身（不是拖动）不该触发菜单里的其它行为 */
			root.addEventListener("click", function (ev) { ev.stopPropagation(); });

			/* 输入框上那个触发器的文案（用户要求：显示「选择强度」）。
			   它原本是「模型名 + 档位」，宿主在菜单打开时会自己加灰底
			   （aria-expanded=true → background rgba(38,49,72,.06)），
			   所以我们只换文字，不碰底色。 */
			relabelTrigger();

			/* ⚠️ 初次定位不带走过渡：以前是先 paint（这时还没量到轨道宽度，
			   --dshp-x 是 0）再靠 measure 校正，于是每次打开菜单滑钮都先从
			   最左边滑过来一下 —— 用户看到的就是"滑杆不稳"。先挂 dshp-first
			   把过渡关掉，等定位/连续几帧的宽度校正做完再放开。 */
			root.classList.add("dshp-first");
			paint(index);
			radios[0].parentNode.insertBefore(root, radios[0]);
			/* 标记"这一页是等级页"：CSS 靠它把四个选项行收起来（与参考实现一致）。 */
			/* 行程用 px 变量驱动（ResizeObserver 量一次），这样滑钮的位移是纯合成，
			   不用每帧改 left/width 触发重排 —— 拖起来才跟手。 */
			function measure() {
				var tr = track.getBoundingClientRect();
				var w = tr.width;
				if (w <= 0) return;
				/* ⚠️ 必须用 offsetWidth（布局宽度），不能用 getBoundingClientRect：
				   拖动时滑钮有 scale:1.12，getBoundingClientRect 会返回放大后的 24.6px，
				   于是 travel 变小、滑钮跟不上手指（实测偏差线性到 20px）。 */
				var kw = knob.offsetWidth || 22;
				knobW = kw;
				var want = Math.max(0, w - kw);
				/* ⚠️ 只在值真的变化时写：连续几帧重复写同一个值会**反复重启 CSS 过渡**，
				   滑钮要 600ms 以上才到位（测试实测）。 */
				var changed = Math.abs(want - travelPx) > 0.5;
				if (changed) {
					travelPx = want;
					root.style.setProperty("--dshp-travel", travelPx + "px");
				}
				var wantX = (travelPx * preview / Math.max(1, radios.length - 1)) + "px";
				/* 首次也要写（初始 --dshp-x 是空串，比较会误判为"相同"）。 */
				/* ⚠️ 行程（travel）变化时**也必须**重写填色比例：填色的分母就是
				   行程。以前只在 --dshp-x 变化时才写，于是"行程量到了、位置却没变"
				   的那一帧会留下安装时的旧比例（=1）—— 表现就是**滑钮在最左边、
				   填色却铺满整条轨道**（用户截图确认）。 */
				if (changed || root.style.getPropertyValue("--dshp-x") !== wantX) {
					root.style.setProperty("--dshp-x", wantX);
					writeFill(travelPx * preview / Math.max(1, radios.length - 1));
				}
			}
			measure();
			/* 菜单是分帧长出来的：连续几帧各量一次，直到宽度稳定。
			   只在宽度变化时才真的写变量，避免反复重启过渡。 */
			(function settle(n) {
				if (n <= 0) return;
				if (typeof requestAnimationFrame !== "function") return;
				requestAnimationFrame(function () { measure(); settle(n - 1); });
			})(6);
			if (typeof ResizeObserver === "function") {
				/* 轨道尺寸变了就作废几何缓存（下次取用时重新量）。 */
				try {
					sliderRo = new ResizeObserver(function () { measure(); geo = null; });
					sliderRo.observe(track);
				} catch (err) { sliderRo = null; /* 不支持就算了，measure 仍在 */ }
			}
			/* 首帧宽度可能还是 0（菜单刚插进来），下一帧再量一次。 */
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(measure);
			/* 定位稳定了（过了两帧）再放开过渡，之后的位置变化才带动画。 */
			if (typeof requestAnimationFrame === "function") {
				requestAnimationFrame(function () {
					requestAnimationFrame(function () { root.classList.remove("dshp-first"); });
				});
			} else {
				root.classList.remove("dshp-first");
			}
			/* 给增强器一个把 index 对齐到宿主真实档位的钩子。 */
			root.__dshpSyncIndex = function (i) {
				if (typeof i !== "number" || i < 0) return;
				if (i === index) return;
				index = i;
				preview = i;
				paint(i);
			};
			root.dataset.dshpWired = "1";
			return root;
		}

		/** 菜单是 React 渲染的：被重建就把滑杆补回去。 */
		function installMenus() {
			if (typeof document === "undefined") return function () {};
			var mo = null;
			/* ⚠️ 触发器文案观察器也要存引用：它以前是"造出来就没人管"的，
			   claimMenus 顶掉旧实例时只断主观察器，这个每热更新一次就泄漏一个
			   （连同 relabelTrigger 闭包），正是"重建一次多留一个 → 越用越卡"的来源。 */
			var triggerMo = null;
			var armed = false;
			function scan() {
				/* 滑杆被关掉（window.dshUiPolish.setSlider(false)）之后，
				   任何**已经在队列里**的补扫都不许再动手 —— 否则关掉之后
				   还会替用户推一次菜单（真机/复刻都验证过：关掉后菜单自己进了档位页）。 */
				if (!sliderOn) return;
				/* ⚠️ 平时必须是零成本：App 启动时 DOM 会变动成千上万次，
				   这个回调每次都会被叫到。以前它每次都排两个 setTimeout、还全文档查询，
				   结果把渲染进程拖死、启动超时（真机上表现为"53 个条目没有激活"、
				   正在初始化的 locale 被判成 failed）。所以先做一次廉价判断，早退。 */
				/* ⚠️ 自触发保护：enhanceModelMenu 每轮都会写 DOM（插 head、移动焦点、
				   加 class），这些变动又会被主 observer 看到 → 再触发一轮扫描，
				   扫描自己喂自己就永远停不下来（真机反馈：还是会卡）。
				   这里直接挡掉重入，扫描期间不接受新的一轮。 */
				if (selfScanning) return;
				selfScanning = true;
				/* ⚠️ 卡死的根治办法：扫描期间把观察器**摘下来**。
				   enhanceModelMenu 每一轮都会写菜单内部（插 head、移焦点、加 class），
				   这些自写变动会被主 observer 看到 → 又触发一轮扫描 → 再写 → 死循环。
				   之前用「setTimeout 延后放行标志位」来挡，结果把**我们自己点击后
				   React 切到档位页**那一批变动也一起吞掉了 —— 那批正是要装滑杆的，
				   于是菜单永远停在原生 Default/Low/High/Max（真机回归）。
				   现在改成：扫描期间 disconnect + takeRecords() 丢掉自写记录，
				   扫描结束立刻重连并**同步**放行。外部真实变动（开/关菜单、
				   React 自己的重渲染）照常触发扫描，自己的写入一条都不会回流。 */
				if (mo) { try { mo.disconnect(); } catch (err) { /* 忽略 */ } }
				try {
					scanOnce();
				} catch (err) {
					/* 增强失败绝不能把标志卡住，否则整个插件彻底不动了。 */
				} finally {
					if (mo) {
						/* 丢掉扫描期间攒下的记录：它们全是这一轮自己写的。 */
						try { mo.takeRecords(); } catch (err) { /* 忽略 */ }
						attachMo();
					}
					selfScanning = false;
				}
			}
			/** 把观察器重新挂上（scan 期间会临时摘下，见那里的注释）。 */
			function attachMo() {
				if (!mo) return;
				var target = document.body || document.documentElement || null;
				if (!target) return;
				try { mo.observe(target, { childList: true, subtree: true }); } catch (err) { /* 忽略 */ }
			}
			/** 真正干活的扫描。调用方（scan）已经处理好自触发保护。 */
			function scanOnce() {
				/* ⚠️ 启动时宿主里藏着好几个隐藏的 [role='menu']（设置引导、
				   侧栏抽屉等）。以前只要有 role=menu 就干活，结果在 React 渲染中途
				   去改/点它们 -> React #200（挂载容器丢失）-> 整页白掉（真机实测）。
				   所以：一要用户交互过，二只认**真的可见**的菜单。 */
				if (!userInteracted) return;
				/* ⚠️ 必须放在下面那句"没菜单就 return"**之前**：
				   触发器文案要在菜单**关闭**状态下也保持「选择强度」，
				   而宿主每次重渲染都会把它改回模型名。 */
				relabelTrigger();
				var all = document.querySelectorAll("[role='menu']");
				var menus = [];
				for (var v = 0; v < all.length; v++) {
					var r = all[v].getBoundingClientRect();
					if (r.width > 0 && r.height > 0) menus.push(all[v]);
				}
				var sliders = document.querySelectorAll("." + SLIDER_CLASS);
				if (!menus.length && !sliders.length) return;
				/* 先清孤儿：React 重建菜单时，我插的滑杆/模型行可能被留在菜单外面。 */
				var orphans = sliders;
				for (var k = 0; k < orphans.length; k++) {
					if (!orphans[k].closest("[role='menu']")) orphans[k].remove();
				}
				var strayRows = document.querySelectorAll("." + MODEL_ROW_CLASS);
				for (var r = 0; r < strayRows.length; r++) {
					if (!strayRows[r].closest("[role='menu']")) strayRows[r].remove();
				}
				for (var i = 0; i < menus.length; i++) enhanceModelMenu(menus[i]);
				/* 模型列表页：给每个模型项挂"选中后流转"的钩子。
				   宿主"选中即关菜单"，用户要求选完如果新模型有推理档位，
				   要自然过渡到滑杆页——afterModelPicked 负责把它拉回来并推进。 */
				for (var i2 = 0; i2 < menus.length; i2++) {
					hookModelPicks(menus[i2]);
				}
				/* 兜底：扫完之后，**任何不在等级页**的菜单都不该留着档位标记。
				   模型列表页是另一套 DOM（带搜索框），如果宿主复用了同一个菜单节点、
				   而增强器那一轮没走到清理分支，档位就会残留在列表顶部（用户截图确认）。
				   这里无条件再清一遍，成本极低。 */
				for (var c2 = 0; c2 < menus.length; c2++) {
					var mm = menus[c2];
					if (mm.classList.contains("dshp-levelPage")) continue;
					var sl2 = mm.querySelectorAll("." + SLIDER_CLASS);
					for (var s2 = 0; s2 < sl2.length; s2++) sl2[s2].remove();
					var hd2 = mm.querySelectorAll("." + HEAD_CLASS);
					for (var h2 = 0; h2 < hd2.length; h2++) hd2[h2].remove();
					var lb2 = mm.querySelectorAll("." + LEVEL_LABEL_CLASS);
					for (var l2 = 0; l2 < lb2.length; l2++) lb2[l2].remove();
					var mr2 = mm.querySelectorAll("." + MODEL_ROW_CLASS);
					for (var m2 = 0; m2 < mr2.length; m2++) mr2[m2].remove();
				}
			}
			function scanBurst() {
				scan();
				/* 只有真的开着菜单时才补扫——没菜单时一次定时器都不排。
				   而且同一时刻只允许一个待执行的补扫，避免 DOM 连续变动时堆积。 */
				if (typeof document === "undefined" || !visibleMenu()) return;
				/* 菜单开着 = 自检开启：万一这一轮扫描被吞掉（时序竞态），
				   150ms 后还会自己回来把它装上。见 startWatch 的注释。 */
				startWatch();
				if (burstPending) return;
				burstPending = true;
				var run = function () { burstPending = false; scan(); };
				if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
				else if (typeof setTimeout === "function") setTimeout(run, 60);
			}
			/**
			 * 菜单开着时的低频自检（兜底，防时序竞态）。
			 *
			 * ⚠️ 为什么必须有：增强只跑在"观察到 DOM 变动"这一刻。可 mutation
			 * 回调是微任务、补扫是 rAF，两者谁先谁后没有保证；只要那一轮扫描
			 * 恰好落在"上一轮还没放行"的窗口里，它就被整个丢掉，而且不会再有
			 * 人来补 —— 表现就是菜单停在原生列表、滑杆完全不出现（真机回归）。
			 * 与其和时序搏斗，不如开菜单期间每 150ms 自检一次：装了就是幂等的
			 * 空转，没装就补上。菜单一关、连续几次没菜单就自行停表。
			 */
			var watchTimer = null;
			var watchMiss = 0;
			var watchPending = 0;
			function startWatch() {
				if (watchTimer) return;
				watchTimer = setInterval(function () {
				if (typeof document === "undefined" || !visibleMenu()) {
						if (++watchMiss >= 4) stopWatch();
						return;
					}
					watchMiss = 0;
					/* 自检是兜底，不是常驻工作。每 150ms 全量扫描对模型列表页、
					   外来菜单纯属浪费；只在这几种情况下才值得跑一轮：
					   ① 有"看着像档位页但滑杆没接线"的菜单（安装竞态兜底）；
					   ② 上一轮发现过 ①（watchPending>0：连扫几帧确保落地后清零）；
					   ③ 停在档位页（React 重渲染可能冲掉我们的节点）；
					   ④ 停在模型列表页但还有模型项没挂上选中钩子。 */
					var need = false;
					var visible = visibleMenu();
					if (visible) {
						var sl = visible.querySelector("." + SLIDER_CLASS);
						var pendingSl = !!(sl && sl.dataset.dshpWired !== "1");
						if (pendingSl || watchPending > 0) need = true;
						else {
							var p = paneOf(visible);
							if (p === "effort") need = true;
							else if (p === "model") {
								var items = visible.querySelectorAll("[role='menuitemradio']");
								for (var wi = 0; wi < items.length; wi++) {
									if (items[wi].dataset.dshpPickHooked !== "1") { need = true; break; }
								}
							}
						}
						watchPending = pendingSl ? 3 : 0;
					}
					if (!need) return;
					scan();
				}, 150);
			}
			function stopWatch() {
				if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
				watchMiss = 0;
				watchPending = 0;
			}
			/* 补扫表的句柄（全局唯一，新的补扫先停旧的）。 */
			var nudgeTimer = null;
			function stopNudge() {
				if (nudgeTimer) { clearInterval(nudgeTimer); nudgeTimer = null; }
			}
			/**
			 * 我们**主动点开档位页**之后的补扫。
			 *
			 * ⚠️ 为什么必须有这一步：那批菜单内容是"我们自己点击"引发的重渲染，
			 * 而扫描期间观察器是摘下来的（防自触发死循环），于是没人来扫它 ——
			 * 结果就是点了「推理等级」却停在原生列表上，滑杆不出现（真机回归）。
			 * 这里在点击后按 60ms 补扫，一旦装上"接好线"的滑杆就立刻停手，
			 * 最多 10 次 ≈ 600ms；菜单被关掉也立刻停手。成本极低、幂等。
			 */
			function nudge() {
				if (nudgeTimer) return;
				var left = 10;
				nudgeTimer = setInterval(function () {
					var sl = document.querySelector("." + SLIDER_CLASS);
					if (sl && sl.dataset.dshpWired === "1") { stopNudge(); return; }
					if (typeof document === "undefined" || !visibleMenu()) { stopNudge(); return; }
					scanBurst();
					if (--left <= 0) stopNudge();
				}, 60);
			}
			/* 暴露给工厂作用域：导航（自动推进 / 点灰框进列表 / 选完模型回流）成功后调用。 */
			nudgeMenu = function () { stopNudge(); nudge(); };
			/**
			 * 只在**用户第一次交互之后**才开始观察 DOM。
			 *
			 * 这是这次把 App 拖垮的根因修法：菜单只可能在点击/按键之后出现，
			 * 启动期间挂着一个 subtree 观察器毫无意义、却要在成千上万次 DOM 变动里
			 * 反复回调。现在启动期间的开销是**零**，第一次 pointerdown/keydown 才武装。
			 */
			function arm() {
				if (armed) return;
				armed = true;
				userInteracted = true;
				/* 触发器文案：宿主每次重渲染都会把它改回模型名，
				   所以挂一个 observer 盯着它，变了就矫正（比轮询省电）。 */
				try {
					var watchBtn = document.querySelector("[data-slot='conversation.input.model'] button");
					if (watchBtn && typeof MutationObserver === "function") {
						triggerMo = new MutationObserver(function () { relabelTrigger(); });
						triggerMo.observe(watchBtn, { childList: true, subtree: true, characterData: true });
					}
				} catch (err) { /* 忽略 */ }
				setTimeout(relabelTrigger, 0);
				/* 也许菜单已经开着（比如热更新后）——但要晚一帧, 让 React 先挂完它自己的事件。 */
				if (typeof requestAnimationFrame === "function") requestAnimationFrame(function () { scanBurst(); });
				else if (typeof setTimeout === "function") setTimeout(scanBurst, 80);
				if (typeof MutationObserver !== "function") return;
				mo = new MutationObserver(function (records) {
					/* 先看这批变动有没有可能长出菜单——没有就直接返回，不做全文档查询。 */
					var maybe = false;
					for (var i = 0; i < records.length && !maybe; i++) {
						var rec = records[i];
						if (mutationTouchesMenu(rec)) maybe = true;
					}
					if (maybe) scanBurst();
				});
				attachMo();
			}
			/* 捕获阶段(true)会抢在 React 前面跑。React 用 focusin 追踪焦点,
			   我们在它之前改 DOM, 它读到的就是被改过的状态 -> 真机直接白屏
			   (document 被换掉, SidebarRoot 报 documentElement 为 null)。
			   所以一律用冒泡阶段: 等 React 处理完我们再武装。 */
			document.addEventListener("pointerdown", arm, false);
			document.addEventListener("keydown", arm, false);
			/* ⚠️ 绝不靠 focusin 武装: 启动引导页会**自动聚焦**某个元素,
			   focusin 随之触发 -> arm() 立刻跑 scan() -> 我们在 React 渲染到一半时
			   改它的 DOM -> React 抛 #200(挂载容器丢失) -> document 被换掉 -> 全白。
			   真机时间轴: 0.5s 还正常(355 节点), 0.6s 就崩。
			   只认 pointerdown/keydown: 只有真人操作才会来, 那时 React 早已挂载完毕。 */
			/* 关掉时把武装监听也摘掉：只断观察器的话，监听还在，
			   armed 又已经是 true，重新打开时不会再挂新观察器 —— 状态会错乱。 */
			return function () {
				if (mo) mo.disconnect();
				if (triggerMo) { try { triggerMo.disconnect(); } catch (err) { /* 忽略 */ } triggerMo = null; }
				stopNudge(); stopWatch(); unveilMenu();
				stopSliderGuard(); stopSliderRo();
				document.removeEventListener("pointerdown", arm, false);
				document.removeEventListener("keydown", arm, false);
			};
		}

		/**
		 * 一个菜单的"当前页"同步：
		 *   · 等级页（有 ≥2 个 menuitemradio）：装滑杆 + 顶部那行模型
		 *   · 上一层（[模型][推理等级] 两行）：清掉自己加的东西，记住模型行，并**直接进等级页**
		 * 为什么要"直接进"：参考实现就是一次点击看到滑杆（用户截图 1 → 2）；
		 * 而模型列表通过顶部那行模型进（截图 3 的灰色行），不用退回去找。
		 */
		function enhanceModelMenu(menu) {
			if (!menu || menu.nodeType !== 1) return false;
			var radios = radiosOf(menu);
			var slider = menu.querySelector("." + SLIDER_CLASS);
			/* 只认「接好线」的滑杆：行程变量、档位联动都在 installSlider 尾部设置。
			   如果有个滑杆占着位置却没接好（旧实例装的、或 React 重建时留下的半成品），
			   直接换掉重装——否则新的联动逻辑永远不会生效（真机上就是这么坏的）。 */
			if (slider && slider.dataset.dshpWired !== "1") {
				slider.remove();
				slider = null;
			}
			var modelRow = menu.querySelector("." + MODEL_ROW_CLASS);

			/* 不能只信 reasoningPage: 那个 Map 只有我们自己写过才是 true,
			   宿主从上一层直接切到等级页时从没写过, 于是这里恒为 false、
			   滑杆永远装不上(真机实测)。改成看内容——档位名认得出来就是等级页。 */
			/* ⚠️ 判据顺序要紧：先看**这是不是模型列表**，再看像不像档位页。
			   宿主的模型目录里可能真有模型叫 auto（真机就是），而 auto 正在
			   档位词表里 —— 只看词表的话，模型列表会被当成档位页，滑杆装到
			   列表上，导航还会在列表和两行页之间来回跳（用户截图确认）。
			   所以：模型列表结构（外层 role=group）一票否决；pane 读到 effort
			   就直接认。 */
			var paneHere = paneOf(menu);
			var isReasoning = reasoningPage.get(menu) === true ||
				paneHere === "effort" ||
				(radios.length >= 2 && !looksLikeModelList(menu) &&
					paneHere !== "model" && paneHere !== "root" &&
					hasModelSelectMarkup(menu) && allLevelWords(radios));
			if (radios.length >= 2 && isReasoning) {
			unveilMenu();   /* 落到滑杆页 = 导航结束，揭开遮挡 */
			clearAdvancing(menu);
				/* 顶部那一块：灰底圆角框里装「当前档位 + 模型名」，整块都是进模型列表的点击区。 */
				var head = menu.querySelector("." + HEAD_CLASS);
				if (!head) {
					head = document.createElement("div");
					head.className = HEAD_CLASS;
					head.setAttribute("role", "presentation");
					var label = document.createElement("div");
					label.className = LEVEL_LABEL_CLASS;
					head.appendChild(label);
					var row = buildModelRow(menu);
					if (row) head.appendChild(row);
					/* ⚠️ 监听挂在 head 上会**失效**：head 是我们插入的，宿主重渲染时
					   会被换成新节点，绑在旧节点上的监听一并丢失
					   （真机实测：openModelList 连入口都没进，灰框点了没反应）。
					   改成**事件委托**挂在 menu 上——menu 是宿主自己的稳定节点。 */
					if (!menu.dataset.dshpHeadHooked) {
						menu.dataset.dshpHeadHooked = "1";
						/* pointerdown：宿主在这一刻就开始关菜单，必须用捕获阶段抢先拿到。 */
						menu.addEventListener("pointerdown", function (ev) {
							var t = ev.target;
							var h = t && t.closest ? t.closest("." + HEAD_CLASS) : null;
							if (!h) return;
							openModelList(menu, ev);
						}, true);
						/* click 兜底（键盘激活等场景）。 */
						menu.addEventListener("click", function (ev) {
							var t = ev.target;
							var h = t && t.closest ? t.closest("." + HEAD_CLASS) : null;
							if (!h) return;
							openModelList(menu, ev);
						});
					}
					menu.insertBefore(head, menu.firstChild);
				}
				/* 用户刚滑过的那一档优先：重开菜单时别被宿主的默认值顶回去。
				   ⚠️ 还要比对模型键：换模型没经过 afterModelPicked 时（键盘 Enter
				   选中、宿主侧直接切换），旧模型的 pickedIndex 会套到新模型头上，
				   新模型档位数不同，滑杆内部 index 被钉死在错误位置。 */
				var wantIdx = (Date.now() < pickedUntil && pickedIndex !== null &&
					pickedModel === modelKeyOf(menu))
					? Math.max(0, Math.min(pickedIndex, radios.length - 1))
					: checkedIndex(radios);
				var labelEl = head.querySelector("." + LEVEL_LABEL_CLASS);
				var text = labelOf(radios[wantIdx]);
				/* ⚠️ 正在拖动时**绝不能**写标签：
				   拖动过程中宿主状态还是旧档位（我们还没提交），
				   而 scan 会被 MutationObserver 反复触发，每次都把标签重置回旧值
				   —— 表现就是"文字不动"或"闪一下"（真机抓栈确认是这里）。
				   拖动时标签归 syncLabelsTo 管，这里让路。 */
				var sliderEl = menu.querySelector("." + SLIDER_CLASS);
			var isDragging = !!(sliderEl &&
				(sliderEl.classList.contains("dshp-sliderActive") || sliderEl.classList.contains("dshp-sliderPressed")));
				if (!isDragging && labelEl && labelEl.textContent !== text) labelEl.textContent = text;
				/* React 会把我们插的节点搬家：跑到灰框外面的模型行是"野生"的，清掉。
				   用户看到的就是顶部多出一行重复的模型名。 */
				var strays = menu.querySelectorAll("." + MODEL_ROW_CLASS);
				for (var s = 0; s < strays.length; s++) {
					if (strays[s].parentNode !== head) strays[s].remove();
				}
				/* head 里没有模型行时才补（React 可能把它搬走）。
				   ⚠️ 这里以前写成 var head = buildModelRow(menu)：把 head 容器变量覆盖了，
				   还把行插到菜单顶部，结果灰框外面多浮一条重复的模型名（真机截图可见）。 */
				if (head && !head.querySelector("." + MODEL_ROW_CLASS)) {
					var rowEl = buildModelRow(menu);
					if (rowEl) head.appendChild(rowEl);
				}
				/* ⚠️ 必须把返回值接回来：不接的话 slider 还是 null，
				   installSlider 就不会被调用 —— 行程与档位联动全都接不上。
				   联动只在 installSlider 里接一次：装好（dshpWired=1）就一定全通。 */
				if (!slider) slider = installSlider(menu);
				/* 装好后把滑杆停到「用户选中的那一档」（而不是宿主的默认档）。 */
				if (slider && wantIdx !== checkedIndex(radios)) {
					try { applyPicked(menu, slider, radios, wantIdx); } catch (err) { /* 忽略 */ }
				}
				/* 让滑杆自己的 index 跟宿主真实状态保持一致：
				   index 是"当前生效的档位"，它错了后续的 target !== index 判断就会错
				   （连续拖动时表现为漏提交/重复提交）。 */
				/* ⚠️ 但**只在宿主状态稳定之后**才回写：宿主的 select() 是异步的
				   （真机要等一个往返），刚提交完那段时间它的 aria-checked 还是旧档。
				   这时候回写会把滑钮拽回旧档，下一轮扫描又用 applyPicked 拉回来 ——
				   滑钮在两个位置之间来回弹，用户看到的就是"滑动时有时会闪烁"
				   （真机反馈 + 复刻复现：读数序列出现 Max → Default 的回落）。
				   拖动中同理：跟手的位置不能被抢走。 */
				var settled = !isDragging && Date.now() >= pickedUntil;
				if (slider && slider.dataset.dshpWired === "1" && settled) {
					try {
						var hostIdx = checkedIndex(radios);
						if (typeof slider.__dshpSyncIndex === "function") slider.__dshpSyncIndex(hostIdx);
					} catch (err) { /* 忽略 */ }
				}
				/* ⚠️ 顺序要紧：宿主在子菜单打开时会把焦点放在某一档上。
				   如果先 display:none 把那一行藏了，焦点会掉到 body → 宿主判定
				   "焦点离开菜单"→ 立刻关掉菜单（真机上就是这么消失的）。
			   所以先把焦点挪到滑杆（还在菜单里），再隐藏。
			   ⚠️ 只在焦点掉出菜单时才补：滑杆自己已经有了就别再动 ——
			   每轮扫描都 focus() 会把焦点从用户正在操作的元素上抢走。 */
				if (!menu.contains(document.activeElement) ||
					!slider.contains(document.activeElement)) {
					try { slider.focus({ preventScroll: true }); } catch (err) { /* 老浏览器忽略 */ }
				}
				menu.classList.add("dshp-levelPage");
				realignMenu(menu);
				return true;
			}

			/* 回到上一层（模型列表 / 两行页）：
			   我们插的节点 React 不认识，自己收干净。
			   （"本轮已推进"之类的标记已废弃——位置一律读 hostPane()。） */
			/* React 不认识我们插的节点，得自己收干净 */
			if (slider) slider.remove();
			if (modelRow) modelRow.remove();
			var head = menu.querySelector("." + HEAD_CLASS);
			if (head) head.remove();     /* 里面装着档位标题与模型行 */
			/* 模型列表页不该出现推理档位（用户要求）。
			   宿主原生菜单里可能残留一行档位标题，一并收掉。 */
			var strayLabel = menu.querySelector("." + LEVEL_LABEL_CLASS);
			if (strayLabel) strayLabel.remove();
			menu.classList.remove("dshp-levelPage");
			/* ⚠️ 这里**不要**清导航锁（dshp-advancing）。
			   openModelList / afterModelPicked 正在导航途中时会写上它，
			   用来抑制自动推进；每轮扫描都清掉的话，菜单刚从档位页退回两行页
			   就会被立刻推回档位页 —— 用户看到的就是「闪一下」（真机确认）。
			   锁带 1.5s 时间窗，由 advancingLocked() 读到过期时自愈解锁，
			   所以既不会永久残留、也不会过早失效。 */
			delete menu.dataset.dshpRealign;   /* 下次重开要重新对齐 */
			/* 模型列表页也是 menuitemradio，别把滑杆装到那里去。 */
			/* 模型列表页是导航的目标页之一：到这里就算落地，揭开遮挡。 */
			if (radios.length >= 2) { unveilMenu(); return false; }

			var rows = menuRows(menu);
			/* 两行 = [模型][推理等级]。语言无关：按位置认，不认文字。 */
			/* 只在**这一轮打开**内去重：菜单被宿主复用时，WeakSet 会永久记住"已推进"，
			   导致从模型列表退出后再打开停在原生两行页（真机确认）。
			   改成看菜单上的标记，关闭时会被清掉，下次打开就能重新推进。 */
			/* 位置以宿主 pane 为准：只有 root（两行页）才需要从这里推进。
			   不再用 dshpAdvanced / wantModelsOnce 这些会互相打架的标记。 */
			var paneNow = paneOf(menu);
			if (paneNow !== null && paneNow !== "root") return false;
			/* ⚠️ 只有**确认这是模型选单**时才允许点它的行。
			   宿主里别的菜单（权限选单、命令面板、右键菜单…）同样是
			   role=menuitem 的列表，误点会把用户的设置直接改掉
			   （第二行会被当成「推理等级」点下去）。
			   认法两种：fiber 认得出 ModelSelect；或菜单里带宿主那套
			   单元格标记（cellLabel / cellValue）。 */
			if (paneNow === null &&
				!menu.querySelector("[class*='cellLabel'], [class*='cellValue']")) return false;
			/* ⚠️ 自动推进会真的去点宿主的菜单行。这一层由 MutationObserver 驱动，
			   启动期也会跑；如果在 React 渲染中途点下去，React 会报 #200
			   （挂载容器丢失）→ 整个页面白掉（真机实测，就是这么崩的）。
			   所以必须等用户真的交互过（arm 之后）才允许推进。 */
			if (!userInteracted) return false;
			/* ⚠️ 这里**不能**用 keepOpenUntil 挡：重开菜单后正是靠自动推进
			   才会从「原生两行」走到等级页，挡掉的话滑杆永远不会出现
			   （真机实测：第二次换档就是这么坏的）。 */
			if (rows.length >= 1 && !advancingLocked(menu) && !looksLikeModelList(menu)) {
				/* 用户刚按了 Esc：这一轮别推进，让他把菜单关掉（见 armEscClose）。 */
				if (escCloseMenu === menu && Date.now() < escCloseUntil) return false;
				/* 消闪：马上要经过宿主的原生两行页，先把它藏起来。 */
				veilMenu(menu);
				markAdvancing(menu);
				if (rows.length === 1) {
					/* ⚠️ 只有一行 = 宿主**没画**「推理等级」那一格，
					   也就是这个模型没有推理档位。用户要求：这种模型点开就
					   直接进模型列表，不要停在只有一行的页面上。 */
					rows[0].click();          /* 唯一一行 = 模型 → 进列表 */
				} else {
					/* 两行 = [模型][推理等级]。用户要求：没有推理档位的模型
					   不进空的档位页；有档位的直接进档位页（滑杆页）。 */
					var effs = effortChoicesOf(menu);
					if (effs && effs.length === 0) {
						rows[0].click();        /* 无档位 → 直接进模型列表 */
					} else {
						reasoningPage.set(menu, true);
						rows[1].click();        /* 有档位 → 进滑杆页 */
					}
				}
				/* ⚠️ 这次点击会让 React 重建菜单内容，而扫描期间观察器是
				   摘下来的 —— 不补扫的话滑杆装不上（真机回归）。 */
				if (typeof nudgeMenu === "function") nudgeMenu();
			}
			return false;
		}

		var stopMenus = null;
		var sliderOn = true;
		var burstPending = false;
		/* 「我们刚点开档位页，接着补扫几帧」的句柄；由 installMenus 装上。
		   导航成功后调用，保证 React 为这次点击重建的菜单内容一定被扫到。 */
		var nudgeMenu = null;
		/* 用户是否已经交互过。只有为 true 时才允许做"点宿主菜单行"这类副作用。 */
		var userInteracted = false;
		/* ⚠️ 这几个标记已废弃（重构前它们互相覆盖、还会随复用的 DOM 残留，
		   是"点灰框没反应""退出重开停原生页"的根源）。
		   界面位置现在一律读 hostPane()。 */
		/* 去重用：pointerdown 与随后的 click 只处理一次。 */
		var lastOpenModelsAt = 0;

		/* 当前按在轨道上的指针（pointerId + 轨道元素）。
		   用 null 表示"没有指针按着"，比布尔量更不容易卡住。 */
		/* 用户刚选的那一档在这段时间内优先显示（重开菜单时用）。 */
		var pickedUntil = 0;
		/* 用户最后一次滑到的档位（重开菜单时优先显示它）。 */
		var pickedIndex = null;
		/* ⚠️ pickedIndex 属于哪个模型（provider+model 键）。换模型不一定经过
		   afterModelPicked（键盘 Enter 选中、宿主侧直接切换都不会触发我们的
		   pointerdown 钩子），那时旧模型的档位序号会套到新模型头上 ——
		   新模型档位数不同，滑杆内部 index 被钉在错误位置，方向键"看似没反应"
		   （复刻页场景 14 抓到）。兑现前必须比对模型键。 */
		var pickedModel = null;
		var activePointerId = null;
		var activeTrack = null;

		/**
		 * 拖动期的"联络桥"：挂在 document 的**冒泡**阶段（不是捕获——捕获会抢在
		 * React 前面改 DOM，实测导致白屏，见下方安装处的注释）。
		 *
		 * 为什么不写在滑杆自己的监听里：菜单是分几帧长出来的，增强有时落在渲染完成之前，
		 * 留下"滑杆在、联动没接"的半成品（真机实测）。挂在 document 上就不挑安装时机。
		 * ⚠️ 但接好线（dshpWired=1）的滑杆会让路给它自己的 pointermove：
		 * 两边坐标系不同（这里整轨归一化，滑杆用 fracAt），双写会在轨道两端打架
		 * （见 onPointer 里的让路判断）。所以桥接只服务"没接好线"的窗口期。
		 */
		function installPointerBridge() {
			if (typeof document === "undefined") return;
			/* ⚠️ 每次安装都**换掉**上一份监听。以前用 document.__dshpBridge 一次性
			   标志防重装，结果热更新后新实例看到标志就跳过，监听永远留在旧闭包里
			   —— 新代码的行程变量、Esc 压制全都不会生效。 */
			var prevBridge = document.__dshpBridgeHandler;
			if (prevBridge && typeof document.removeEventListener === "function") {
				try { document.removeEventListener("pointerdown", prevBridge, false); } catch (err) { /* 忽略 */ }
				try { document.removeEventListener("pointermove", prevBridge, false); } catch (err) { /* 忽略 */ }
			}
			function onPointer(ev) {
				/* 只认「这一次指针**按在轨道上**」——按下时记住 pointerId，
				   只有同一个 pointerId 的 move 才联动；up/cancel 立刻忘掉。
				   ⚠️ 不要用模块级布尔量记状态：一旦漏掉一次 up（指针移出窗口、
				   宿主 pointer capture 等），它会永久卡在 true，
				   之后鼠标只是划过轨道标签就跟着变（真机现象）。 */
				var target = ev.target;
				if (!target || !target.closest) return;
				var track = target.closest(".dshp-sliderTrack");
				if (!track) return;
				/* ⚠️ 接好线的滑杆要让路：它自己的 pointermove 用 fracAt 坐标系
				   （(x−left−半滑钮)/travel）联动档位名，桥接这里用的是整轨归一化
				   （(x−left)/width）——两套公式在两端差约一个滑钮半径，落进错开带时
				   两边 round 出不同档位，桥接后写还会覆盖滑杆的值：
				   用户看到「Low」、松手提交的却是「Off」。桥接只兜底
				   「滑杆在、联动没接」的半成品（见本函数注释），那是它存在的理由。 */
				var slider = track.closest(".dshp-slider");
				if (slider && slider.dataset.dshpWired === "1") return;
				if (ev.type === "pointerdown") {
					if (ev.button !== 0) return;
					activePointerId = ev.pointerId;
					activeTrack = track;
				} else if (ev.type === "pointerup" || ev.type === "pointercancel") {
					activePointerId = null;
					activeTrack = null;
					return;
				} else {
					/* pointermove：必须是同一个指针、且仍然按在同一条轨道上 */
					if (activePointerId === null || ev.pointerId !== activePointerId) return;
					if (activeTrack !== track) return;
				}
				var menu = slider && slider.closest("[role='menu']");
				if (!menu) return;
				var rect = (slider && slider.__dshpGeo) ? slider.__dshpGeo : track.getBoundingClientRect();
				if (!rect || rect.width <= 0) return;   /* 轨道还没布局好：这次不算数 */
				var radios = radiosOf(menu);
				if (radios.length < 2) return;
				var t = (ev.clientX - rect.left) / rect.width;
				t = t < 0 ? 0 : t > 1 ? 1 : t;
				var i = Math.round(t * (radios.length - 1));
				var label = menu.querySelector("." + LEVEL_LABEL_CLASS);
				var text = labelOf(radios[i]);
				if (label && text && label.textContent !== text) label.textContent = text;
			}
			/* 同上: 捕获阶段会抢在 React 前面。这两条挂在 document 上、
			   每个 pointermove 都会跑, 捕获阶段等于给全应用的指针事件插了一道
			   前置钩子 —— 实测就是白屏的直接来源。改冒泡阶段。 */
			document.addEventListener("pointerdown", onPointer, false);
			document.addEventListener("pointermove", onPointer, false);
			document.__dshpBridgeHandler = onPointer;
		}

		/**
		 * 装上菜单增强，并**顶掉上一份实例**。
		 *
		 * 为什么需要这个：客户端 bundle 每次热更新/重载都会再跑一遍 apply()，
		 * 而旧闭包里的 MutationObserver 并不会自己停 —— 于是在同一个页面上会有两份
		 * 我的代码抢同一个菜单：旧的先给菜单插了滑杆，新的看到"已经有滑杆"就跳过，
		 * 结果新代码里的行程变量、档位联动、模型行全都不生效（真机上就是这么坏的）。
		 * 这里让新实例先停掉旧的，保证同一时刻只有一个增强器。
		 */
		function claimMenus() {
			try {
				if (typeof window !== "undefined" && typeof window.__dshpStopMenus === "function") {
					window.__dshpStopMenus();
				}
			} catch (err) { /* 旧实例停不掉也无所谓，下面还有 owner 判据 */ }
			stopMenus = installMenus();
			try {
				if (typeof window !== "undefined") {
					window.__dshpStopMenus = function () {
						if (stopMenus) { try { stopMenus(); } catch (err) { /* 忽略 */ } stopMenus = null; }
					};
				}
			} catch (err) { /* 忽略 */ }
		}

		/** 开/关滑杆：关掉时把已经装上的拆掉，界面回到宿主原样。 */
		function setSlider(on) {
			sliderOn = on !== false;
			if (typeof document === "undefined") return sliderOn;
			if (!sliderOn) {
				if (stopMenus) { try { stopMenus(); } catch (err) { /* 忽略 */ } stopMenus = null; }
				try {
					if (typeof window !== "undefined" && window.__dshpStopMenus) window.__dshpStopMenus = null;
				} catch (err) { /* 忽略 */ }
				stopSliderGuard();
				stopSliderRo();
				removeBridges();
				var live = document.querySelectorAll(".dshp-slider");
				for (var i = 0; i < live.length; i++) {
					if (live[i].parentNode) live[i].parentNode.removeChild(live[i]);
				}
				/* ⚠️ 光摘滑杆不够：灰框/模型行/档位标签和 dshp-levelPage 类也要撤。
				   CSS 里 .dshp-levelPage 会把宿主的选项行 display:none 藏掉，
				   滑杆页开着时停用，留下的就是个"选项被藏、滑杆也没了"的空壳菜单。 */
				var heads = document.querySelectorAll("." + HEAD_CLASS + ",." + MODEL_ROW_CLASS + ",." + LEVEL_LABEL_CLASS);
				for (var hj = 0; hj < heads.length; hj++) {
					if (heads[hj].parentNode) heads[hj].parentNode.removeChild(heads[hj]);
				}
				var lvPages = document.querySelectorAll(".dshp-levelPage");
				for (var lj = 0; lj < lvPages.length; lj++) lvPages[lj].classList.remove("dshp-levelPage");
				var marked = document.querySelectorAll("[data-dshp-target]");
				for (var k = 0; k < marked.length; k++) marked[k].removeAttribute("data-dshp-target");
				document.documentElement.classList.remove("dshp-sliderOn");
			} else {
				/* class 必须无条件加。以前它躲在 else if (!stopMenus) 里,
				   stopMenus 一非空(插件重装、或文档被换过)整段就被跳过,
				   类名和监听器一起没了, 真机上表现为滑杆永远不出现。 */
				if (!stopMenus) claimMenus();
				installPointerBridge();
				installEscBridge();
				document.documentElement.classList.add("dshp-sliderOn");
			}
			/* ⚠️ DOM 拆装之外还要刷新样式表：配置 slider:false 时表里根本没有滑杆段，
			   运行时 setSlider(true) 只装 DOM 不补样式，会得到一条裸滑杆（轨道高 0、
			   档位行没隐藏）。反向关掉时把滑杆段撤掉，样式与 DOM 状态保持一致。 */
			try {
				ensure({ enabled: current.enabled, glass: current.glass, tintAlpha: current.tintAlpha, blurPx: current.blurPx, slider: sliderOn });
			} catch (err) { /* 忽略 */ }
			return sliderOn;
		}

		/** 读宿主半的 config；读不到就用默认值，任何异常都不该让界面挂掉。 */
		function readConfig(ctx) {
			var out = { enabled: DEFAULTS.enabled, glass: DEFAULTS.glass, tintAlpha: DEFAULTS.tintAlpha, blurPx: DEFAULTS.blurPx, slider: DEFAULTS.slider };
			var raw = null;
			try {
				raw = ctx && (ctx.config || ctx.options || (ctx.scope && ctx.scope.config));
			} catch (err) {
				return out;
			}
			if (!raw || typeof raw !== "object") return out;
			try {
				if (raw.enabled === false) out.enabled = false;
				if (raw.glass === false) out.glass = false;
				if (raw.slider === false) out.slider = false;
				var alpha = Number(raw.tintAlpha);
				if (Number.isFinite(alpha) && alpha > 0 && alpha <= 1) out.tintAlpha = alpha;
				var blur = Number(raw.blurPx);
				if (Number.isFinite(blur) && blur >= 0 && blur <= 200) out.blurPx = blur;
			} catch (err) {
				/* 配置形态意外：保持默认。 */
			}
			return out;
		}

		/** 依配置生成样式文本（数字来自 config，方便自己调浓淡）。 */
		function buildCss(cfg) {
			var alpha = cfg.tintAlpha;
			var blur = cfg.blurPx;
			/* 模糊不可用（或系统要求减少透明）时，把底加厚——不然只剩半透明，字看不清。 */
			var opaque = Math.max(alpha, 0.96);
			/* ⚠️ 毛玻璃与滑杆是**两个独立开关**（glass / slider），样式表必须分别裁剪：
			   以前整张表都门控在 glass 上，于是 glass:false + slider:true 时
			   滑杆 DOM 照样被 setSlider 装上，却没有一行样式（轨道高 0、档位行没隐藏）。
			   缺省（undefined）一律视为开，保证只关其一时的输出与旧版逐字节一致。 */
			var glassCss = cfg.glass === false ? [] : [
				"/* ---- 浮层毛玻璃：材质画在浮层自己身上（见文件头注释的根因） ---- */",
				"[data-menu-material='translucent']{",
				"  background-color:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) " + alpha * 100 + "%,transparent);",
				"  backdrop-filter:blur(" + blur + "px) saturate(1.5);",
				"  -webkit-backdrop-filter:blur(" + blur + "px) saturate(1.5);",
				"}",
				"/* 子材质层失效（父层 isolation 切断了 backdrop 采样根），关掉免得叠两层 */",
				"[data-menu-material='translucent'] > [aria-hidden='true']{",
				"  background:none;backdrop-filter:none;-webkit-backdrop-filter:none;",
				"}",
				"@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){",
				"  [data-menu-material='translucent']{",
				"    background-color:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) " + opaque * 100 + "%,transparent);",
				"  }",
				"}",
				"@media (prefers-reduced-transparency:reduce){",
				"  [data-menu-material='translucent']{",
				"    background-color:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) " + opaque * 100 + "%,transparent);",
				"    backdrop-filter:none;-webkit-backdrop-filter:none;",
				"  }",
				"}",
				"@media (forced-colors:active){",
				"  [data-menu-material='translucent']{",
				"    background-color:Canvas;backdrop-filter:none;-webkit-backdrop-filter:none;",
				"  }",
				"}",
			];
			var sliderCss = cfg.slider === false ? [] : [
				"/* ---- 推理等级滑杆 ---- */",
				"/* 自动进等级页的那一两帧：把宿主的两行压住，避免闪一下。",
				"   ⚠️ 这里只留 min-height，**不要**加 visibility:hidden。",
				"   旧规则写的是 html.dshp-advancing，而 class 实际加在 [role='menu'] 上，",
				"   从未匹配过（死代码）；若改成能匹配的写法，一旦标记残留菜单就整个隐形，",
				"   比闪一下严重得多。压高度已经足够消掉那次跳动。 */",
				"[role='menu'].dshp-advancing{min-height:150px}",
				"/* 导航遮挡：进出模型列表时把整层藏起来，避开「两行页中转」那一两帧的闪。",
				"   用 opacity 而不是 display/visibility —— 布局与焦点都不受影响，",
				"   宿主不会因此判定焦点离开而关菜单。由 JS 在落地后立刻撤掉，",
				"   另有 700ms 兜底，任何异常路径都不会留下看不见的菜单。 */",
				"[role='menu'].dshp-navBusy{opacity:0!important;pointer-events:none}",
				/* ---- 顶部一块：灰底圆角框装「当前档位 + 模型名」，整块可点进模型列表 ---- */
				".dshp-head{",
				"  /* 宽度按内容（模型名）收缩，水平居中；不是整宽 */",
				"  display:block;width:fit-content;max-width:calc(100% - 24px);margin:6px auto 2px;",
				"  padding:6px 12px 4px;border-radius:10px;cursor:pointer;",
				"  /* 平时和背景一样，只有悬停/按下才浮出灰底 */",
				"  background:transparent;",
				"  transition:background-color 140ms var(--dshm-ease,ease);",
				"}",
				"@media (hover:hover){",
				"  .dshp-head:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 8%,transparent)}",
				"}",
				".dshp-head:active{background:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 12%,transparent)}",
				".dshp-levelLabel{",
				"  padding:2px 0;text-align:center;font-size:15px;font-weight:600;line-height:20px;",
				"  color:var(--dsw-alias-state-business-primary,#3b82f6);",
				"}",
				"/* 模型那行沿用宿主单元格的结构，但去掉「模型」二字、居中；",
				"   它自己的悬停底色也去掉——整块的底色由 .dshp-head 统一给。 */",
				".dshp-modelRow{display:flex;align-items:center;justify-content:center;gap:3px;",
				"  padding:1px 0 2px;min-width:0;color:var(--dsw-alias-label-secondary,#666)}",
				".dshp-modelName{font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
				".dshp-modelChevron{font-size:15px;line-height:18px;opacity:.5;translate:0 -1px}",
				"/* 等级页只留「档位 + 模型行 + 滑杆」——参考实现滑杆下面没有列表。",
				"   隐藏而不是删除：选项行是提交时的落点（click 它才真正改档），也是读屏的兜底。 */",
				".dshp-levelPage > [role='menuitemradio']{display:none!important}",
				".dshp-levelPage{padding-bottom:10px}",
				".dshp-slider{",
				"  --dshp-accent:var(--dsw-alias-state-business-primary,#3b82f6);",
				/* 轨道底色别用 bg-layer-2：浅色主题里它就是白的，压在毛玻璃上等于没有轨道。
				   用「文字色的低透明度」——深浅主题自动反相，永远有对比。 */
				"  --dshp-track:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 13%,transparent);",
				"  --dshp-trackEdge:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 7%,transparent);",
				"  --dshp-knob:var(--dsw-alias-bg-layer-1,#fff);",
				"  box-sizing:border-box;width:100%;padding:10px 12px 6px;outline:none;cursor:pointer;",
				"  touch-action:none;user-select:none;",
				"}",
				".dshp-slider:focus-visible .dshp-sliderTrack{",
				"  box-shadow:inset 0 0 0 1px var(--dshp-trackEdge),0 0 0 2px color-mix(in srgb,var(--dshp-accent) 45%,transparent);",
				"}",
				".dshp-sliderTrack{",
				"  position:relative;height:20px;border-radius:999px;background:var(--dshp-track);",
				"  box-shadow:inset 0 0 0 1px var(--dshp-trackEdge);",
				"  transition:box-shadow var(--dshm-dur-2,180ms) ease;",
				"}",
				"/* 行程 = 轨道宽度减去一个滑钮直径：滑钮两端都留在轨道里。 */",
				".dshp-sliderFill{",
				"  position:absolute;top:0;bottom:0;border-radius:999px;background:var(--dshp-accent);",
				"  /* ⚠️ 用 transform:scaleX 而不是 width：",
				"     width/left 是布局属性，每帧改会让浏览器重算布局（真机实测掉帧到 33ms）；",
				"     transform 走合成层，不重排，拖动才跟手。",
				"     ⚠️ 左端从**轨道边缘**（left:0）起算，不是从滑钮圆心：",
				"     之前用 left:11px 会让最左边留出一截灰色（用户反馈左边没填满）。",
				"     右端用滑钮圆心位置（--dshp-x + 11px）由宽度决定。 */",
				"  left:0;",
				"  /* ⚠️ 用 scaleX 而不是 width：width 是**布局属性**，拖动时每帧改它",
				"     会触发重排（用户反馈「滑块不稳定」）。宽度固定为满行程，用比例缩放；",
				"     全程走合成层，拖动才稳。右端位置 = 宽度 × 比例 = 滑钮右缘；",
				"     最右档时比例正好是 1，整条轨道填满（不会露出灰色）。 */",
				"  /* 宽度 = 滑钮右缘（JS 直接写 px），几何上按定义对齐；",
				"     最右档时正好等于整条轨道宽，右边不会露灰色。 */",
				"  width:var(--dshp-fillW,0px);",
				"  /* 落位动画：稍带回弹的缓动，和滑钮同一条曲线，两者不会脱节。 */",
				"  transition:width 380ms cubic-bezier(.32,1.08,.5,1);",
				"}",
				".dshp-sliderActive .dshp-sliderFill,",
				".dshp-sliderActive .dshp-sliderKnob{transition:none}",
				"/* 首次定位（刚装上滑杆）不带动画：位置还没量准，动了就是「从左边滑过来」。 */",
				".dshp-first .dshp-sliderFill,",
				".dshp-first .dshp-sliderKnob,",
				".dshp-first .dshp-sliderDot{transition:none}",
				"/* 拖动中提前升到合成层，避免每帧新建图层（属性名要与实际用的一致）。 */",
				".dshp-sliderActive .dshp-sliderKnob,",
				".dshp-sliderActive .dshp-sliderFill{will-change:transform}",
				"/* 刻点也和滑钮同心：内缩一个半径（11px）再减掉点半径（2.5px）。 */",
				".dshp-sliderDots{position:absolute;inset:0;display:flex;align-items:center;justify-content:space-between;padding:0 8.5px}",
				/* 刻点：用「叠加一层白」的方式做亮起，配合透明度渐变，
				   两个点之间的切换是平滑过渡而不是硬跳。 */
				".dshp-sliderDot{",
				"  position:relative;width:5px;height:5px;border-radius:50%;",
				"  background:color-mix(in srgb,var(--dshp-accent) 38%,transparent);",
				"  /* 缩放走 transform（不用独立 scale：那会连带放大位移）。 */",
				"  --dshp-dk:1;",
				"  transform:scale(var(--dshp-dk));",
				"  transition:background-color 280ms cubic-bezier(.4,0,.2,1),",
				"             transform 280ms cubic-bezier(.34,1.4,.64,1);",
				"}",
				".dshp-sliderDot::after{",
				"  content:'';position:absolute;inset:0;border-radius:50%;",
				"  background:color-mix(in srgb,#fff 62%,transparent);",
				"  opacity:0;transition:opacity 260ms cubic-bezier(.4,0,.2,1);",
				"}",
				".dshp-sliderDotOn{background:color-mix(in srgb,#fff 62%,transparent)}",
				".dshp-sliderDotOn::after{opacity:1}",
				".dshp-sliderKnob{",
				"  position:absolute;top:50%;left:0;",
				"  width:22px;height:22px;margin-top:-11px;border-radius:50%;",
				"  background:var(--dshp-knob);box-shadow:0 1px 3px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.06);",
				"  /* ⚠️ 缩放必须写进 transform，不能用独立的 scale 属性：",
				"     独立 scale 以元素中心为基准缩放，会把 translateX 的位移一起放大",
				"     （实测 1.12 倍 → 走满行程时滑钮中心多偏 23px，看着就是跟不上手指）。",
				"     写进 transform 则是先平移后缩放，位置不受影响。",
				"     --dshp-k 是缩放倍数（拖动时 1.12，平时 1）。 */",
				"  --dshp-k:1;",
				"  transform:translateX(var(--dshp-x,0px)) scale(var(--dshp-k));",
				"  /* 点击切换时的过渡要更慢更柔（用户要求不要太快）；",
				"     拖动时被 .dshp-sliderActive 覆盖成 none，所以不影响跟手。 */",
				"  transition:transform 380ms cubic-bezier(.32,1.08,.5,1);",
				"  pointer-events:none;",				"}",
				"/* 按住（还没开始拖）与拖动中同款反馈：滑钮微微放大、阴影加深；",
				"   按住时的放大是过渡过去的（此时过渡还开着），所以按下不突兀。 */",
				".dshp-sliderPressed .dshp-sliderKnob,",
				".dshp-sliderActive .dshp-sliderKnob{--dshp-k:1.12;box-shadow:0 3px 10px rgba(0,0,0,.32),0 0 0 1px rgba(0,0,0,.08)}",
				"/* 刻点被「越过」时轻轻弹一下（用变量，配合上面的 transition）。 */",
				".dshp-sliderDotOn{--dshp-dk:1.25}",
				"/* 档位名的变化反馈由 JS 的 WAAPI 驱动（见 syncLabelsTo），",
				"   这里只保证属性本身有过渡，避免宿主重渲染时硬切。 */",
				".dshp-levelLabel{",
				"  transition:color 220ms cubic-bezier(.4,0,.2,1),opacity 220ms cubic-bezier(.4,0,.2,1);",
				"}",
				"/* 拖动时把「将要生效」的那一行点亮——滑杆和列表说的是同一件事。",
				"   加上过渡，档位切换时高亮是渐变而不是硬切。 */",
				"[role='menuitemradio']{",
				"  transition:background-color 240ms cubic-bezier(.4,0,.2,1);",
				"}",
				"[role='menuitemradio'][data-dshp-target]{",
				"  background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 10%,transparent);",
				"}",
				"@media (prefers-reduced-motion:reduce){",
				"  .dshp-sliderFill,.dshp-sliderKnob,.dshp-sliderDot,",
				"  [role='menuitemradio'],.dshp-levelLabel{transition:none}",
				"}",
				"@media (forced-colors:active){",
				"  .dshp-sliderTrack{border:1px solid CanvasText}",
				"  .dshp-sliderFill{background:Highlight}",
				"  .dshp-sliderKnob{background:Canvas;border:1px solid CanvasText}",
				"}",
			];
			return glassCss.concat(sliderCss).join("\n");
		}

		var styleEl = null;
		var current = { enabled: DEFAULTS.enabled, glass: DEFAULTS.glass, tintAlpha: DEFAULTS.tintAlpha, blurPx: DEFAULTS.blurPx, slider: DEFAULTS.slider };

		function drop() {
			if (typeof document === "undefined") return;
			if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
			styleEl = null;
			document.documentElement.classList.remove(ROOT_CLASS);
		}

		function ensure(cfg) {
			if (typeof document === "undefined") return;
			current = cfg;
			var root = document.documentElement;
			root.setAttribute("data-dshp", cfg.enabled && cfg.glass ? "on" : "off");
			/* 整张表该撤下的唯一情况：毛玻璃与滑杆**两段都关**（或整层停用）。
			   只关其一时仍要注入——否则 slider 开着却没有它的样式。 */
			if (!cfg.enabled || (cfg.glass === false && cfg.slider === false)) {
				drop();
				return;
			}
			var css = buildCss(cfg);
			if (!styleEl) {
				styleEl = document.createElement("style");
				styleEl.setAttribute("data-plugin", NS);
				/* head 可能还没就绪（启动早期）：退回 documentElement，别抛。 */
				var host = document.head || document.documentElement;
				if (!host) return;
				host.appendChild(styleEl);
			}
			if (styleEl.textContent !== css) styleEl.textContent = css;
			root.classList.add(ROOT_CLASS);
		}

		/* ---------- cordis 客户端插件入口 ---------- */
		var inject = [];

		function apply(ctx) {
			/* ⚠️ 这一层是**纯锦上添花**：任何一步出问题都必须咽下去，
			   绝不能让插件的激活失败——宿主把"条目没激活"当致命错误，
			   整个 App 会弹"应用无法启动"，代价远大于少一层毛玻璃。 */
			var cfg;
			try { cfg = readConfig(ctx); } catch (err) { cfg = null; }
			if (!cfg) return;
			/* enabled:false = **整层**停用（配置注释承诺的行为）：样式、滑杆、
			   两条 document 桥接、导航观察器全部撤掉，界面回到宿主原样。
			   以前这里只撤毛玻璃，滑杆与观察器照常运行，排障/A-B 时是误导。 */
			if (!cfg.enabled) {
				try { setSlider(false); } catch (err) { /* 静默 */ }
				try { ensure(cfg); } catch (err) { /* 静默 */ }
				return;
			}
			try { ensure(cfg); } catch (err) { /* 注入失败：静默 */ }
			try { setSlider(cfg.slider !== false); } catch (err) { /* 同上 */ }
		}

		exports.apply = apply;
		exports.inject = inject;

		/* 运行时开关：DevTools 里 dshUiPolish.setGlass(false) 立刻还原成宿主原样。 */
		if (typeof window !== "undefined") {
			try {
				window.dshUiPolish = {
					setGlass: function (on) {
						ensure({ enabled: true, glass: on !== false, tintAlpha: current.tintAlpha, blurPx: current.blurPx, slider: current.slider !== false });
						return on !== false;
					},
					setTint: function (next) {
						var alpha = Number(next);
						if (Number.isFinite(alpha) && alpha > 0 && alpha <= 1) current.tintAlpha = alpha;
						ensure({ enabled: true, glass: true, tintAlpha: current.tintAlpha, blurPx: current.blurPx, slider: current.slider !== false });
						return current.tintAlpha;
					},
					/* off/on = 整层开关（与 enabled:false 同义）：毛玻璃 + 滑杆 + 桥接全撤/全回。 */
					off: function () {
						try { setSlider(false); } catch (err) { /* 忽略 */ }
						return window.dshUiPolish.setGlass(false);
					},
					on: function () {
						var r = window.dshUiPolish.setGlass(true);
						try { setSlider(true); } catch (err) { /* 忽略 */ }
						return r;
					},
					/* 推理等级滑杆的开关 */
					setSlider: setSlider,
					/* 排障/测试用：手动对一个菜单装滑杆，返回装了没有。 */
					enhanceMenu: function (menu) { return enhanceModelMenu(menu || document.querySelector("[role='menu']")); },
					version: "0.1.0",
				};
			} catch (err) {
				/* window 被冻结之类：不影响样式层。 */
			}
		}

		/* 仅供测试断言 */
		exports.__config = readConfig;
		exports.__css = buildCss;
		return module.exports;
	},
});
