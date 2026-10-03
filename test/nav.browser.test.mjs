/**
 * 回归验证：灰框导航 / 无档位直进列表 / 选完回滑杆 / 文案只在滑杆页显示。
 * 仿宿主三级菜单：root(两行) → effort(档位) → model(模型列表)。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DSHP_PLAYWRIGHT || 'playwright');

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
function grabFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到 ' + name);
  let depth = 0, i = source.indexOf('{', start);
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}
const CONSTS_SRC = (source.match(/^\t\tvar [A-Za-z_$][\w$]*[^\n]*$/gm) || [])
  .filter(l => !/^var (module|exports) /.test(l)).map(l => l.replace(/^\t\t/, '')).join('\n');
const ALL_FUNCS_SRC = (() => {
  const names = [...source.matchAll(/^\t\tfunction ([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]);
  return names.map(n => grabFunction(n)).join('\n');
})();
const INSTALL_SRC = CONSTS_SRC + '\n' + ALL_FUNCS_SRC + '\n';
const defaultsSrc = (/var DEFAULTS = \{[\s\S]*?\};/.exec(source) || [''])[0];
const cssText = new Function(defaultsSrc + '\n' + grabFunction('readConfig') + '\n' + grabFunction('buildCss') + '\nreturn buildCss(readConfig({}));')();

const CHROME = process.env.DSHP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME });
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' - ' + detail));
  if (!ok) failures++;
};
const LEVELS = ['Off', 'Low', 'High', 'Max'];

/* 仿真宿主：一个 role=menu 节点复用，pane 由 window.__pane 驱动。
   Escape 在 effort/root → 回上一层，在 model → 关菜单（和真机一致）。 */
async function mount(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.setContent(`<!doctype html><html><head><style>${cssText}
    :root{--dsw-alias-state-business-primary:#3b82f6;--dsw-alias-bg-layer-2:#ececf0;--dsw-alias-bg-layer-1:#fff;}
    body{margin:24px;font:14px system-ui}
    [role='menuitemradio'],[role='menuitem']{display:flex;width:220px;padding:8px 10px;border:0;background:none;border-radius:8px;cursor:pointer;font:inherit;text-align:left}
  </style></head><body>
    <div data-slot="conversation.input.model"><button title="DeepSeek-V41-Flash · High">
      <span class="_triggerLabel_">DeepSeek-V41-Flash</span><span class="_triggerEffort_">High</span>
    </button></div>
    <div id="host"></div>
  </body></html>`);

  await page.evaluate(({ LEVELS, hasEfforts }) => {
    window.__pane = 'root';
    window.__hasEfforts = hasEfforts;
    window.__menuOpen = false;
    const host = document.getElementById('host');
    function render() {
      if (!window.__menuOpen) { host.innerHTML = ''; return; }
      const m = document.createElement('div');
      m.setAttribute('role', 'menu'); m.id = 'menu';
      if (window.__pane === 'root') {
    /* 照宿主真实结构：两行页的单元格带 cellLabel/cellValue 标记。 */
    m.innerHTML = '<button role="menuitem" data-r="0"><span class="cellLabel">模型</span><span class="cellValue">DeepSeek-V41-Flash</span></button>' +
      '<button role="menuitem" data-r="1"><span class="cellLabel">推理等级</span><span class="cellValue">High</span></button>';
      } else if (window.__pane === 'effort') {
    /* 档位行带 ModelSelect 自己的类名（optionCopy/modelName）—— 真机就是这样。 */
    m.innerHTML = LEVELS.map((l, i) => '<button role="menuitemradio" aria-checked="' + (i === 2) +
      '"><span class="optionCopy"><span class="modelName">' + l + '</span></span></button>').join('');
      } else {
    m.innerHTML = '<div class="dshp-search">搜索</div>' +
	  '<button role="menuitemradio" aria-checked="false"><span class="optionCopy"><span class="modelName">DeepSeek-V41-Flash</span></span></button>' +
	  '<button role="menuitemradio" aria-checked="false"><span class="optionCopy"><span class="modelName">另一模型</span></span></button>';
      }
      host.innerHTML = ''; host.appendChild(m);
      m.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.getAttribute('role') === 'menuitem') {
          window.__pane = b.dataset.r === '0' ? 'model' : 'effort'; render();
        } else if (window.__pane === 'model') {
          window.__menuOpen = false; render();           /* 选中即关菜单 */
        } else {
          window.__menuOpen = false; render();           /* 选档位也关 */
        }
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !window.__menuOpen) return;
      if (window.__pane === 'effort') { window.__pane = 'root'; render(); }
      else { window.__menuOpen = false; render(); }
    }, true);
    document.querySelector('[data-slot="conversation.input.model"] button')
      .addEventListener('click', () => { window.__menuOpen = true; window.__pane = 'root'; render(); });
    window.__render = render;
    window.__open = () => { window.__menuOpen = true; window.__pane = 'root'; render(); };
    render();
  }, { LEVELS, hasEfforts: opts.hasEfforts !== false });

  await page.evaluate(src => {
    window.__lib = new Function(src + 'return {enhanceModelMenu: enhanceModelMenu, relabelTrigger: relabelTrigger, hostPane: hostPane, arm: function(){ userInteracted = true; }};')();
  }, INSTALL_SRC);
  return { page, errors };
}

/* hostPane 需要读 React fiber；这里给不了真 fiber，就让它返回 null，
   走插件自己的 DOM 兜底路径（和真机读不到 fiber 时一致）。 */
async function drive(page, fn) {
  await page.evaluate(src => {
    if (!window.__enhance) {
      window.__lib = new Function(src + 'return {enhanceModelMenu: enhanceModelMenu, relabelTrigger: relabelTrigger, hostPane: hostPane, arm: function(){ userInteracted = true; }};')();
      window.__enhance = window.__lib.enhanceModelMenu;
      window.__lib.arm();
    }
  }, INSTALL_SRC);
  await page.evaluate(fn);
}

console.log('1. 灰框进入模型列表');
{
  const { page, errors } = await mount();
  await page.evaluate(() => window.__open());
  await page.waitForTimeout(150);
  /* 宿主先自动推进到档位页（增强器的正常行为），再验灰框 */
  await drive(page, () => {
    const m = document.getElementById('menu');
    window.__pane = 'effort'; window.__render();
    window.__enhance(document.getElementById('menu'));
  });
  await page.waitForTimeout(400);
  const hasHead = await page.evaluate(() => !!document.querySelector('.dshp-head'));
  check('等级页装上了灰框', hasHead);
  const label = await page.evaluate(() => {
    const l = document.querySelector('.dshp-head .dshp-levelLabel');
    return l ? l.textContent : null;
  });
  check('灰框显示档位名', label === 'High', String(label));

  /* 点灰框 */
  await page.evaluate(() => {
    const h = document.querySelector('.dshp-head');
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true }));
  });
  await page.waitForTimeout(1200);
  const pane = await page.evaluate(() => window.__pane);
  check('★ 点灰框后到达模型列表', pane === 'model', 'pane=' + pane);
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close();
}

console.log('2. dshp-advancing 标记会被清掉（退出列表后可再次推进）');
{
  const { page } = await mount();
  await page.evaluate(() => window.__open());
  await page.waitForTimeout(150);
  await drive(page, () => window.__enhance(document.getElementById('menu')));
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const h = document.querySelector('.dshp-head');
    if (h) h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true }));
  });
  await page.waitForTimeout(1200);
  /* 直接把菜单推到列表页，看标记有没有残留 */
  await page.evaluate(() => { window.__pane = 'model'; window.__render(); });
  await page.waitForTimeout(300);
  await drive(page, () => window.__enhance(document.getElementById('menu')));
  await page.waitForTimeout(200);
  const flag = await page.evaluate(() => document.getElementById('menu').classList.contains('dshp-advancing'));
  check('列表页清掉了 dshp-advancing', flag === false, '残留=' + flag);
  await page.close();
}

console.log('3. "选择强度" 只在滑杆页显示');
{
  const { page } = await mount();
  await page.evaluate(() => window.__open());
  await page.waitForTimeout(150);
  await drive(page, () => window.__enhance(document.getElementById('menu')));
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__pane = 'effort'; window.__render();
    window.__enhance(document.getElementById('menu'));
  });
  await page.waitForTimeout(300);
  const onLevel = await page.evaluate(() => {
    window.__lib.relabelTrigger();
    return document.querySelector('.dshp-head').closest('[role=menu]') ? true : false;
  });
  check('档位页标记已建立', onLevel);
  const lvlText = await page.evaluate(() => {
    const l = document.querySelector("[class*='triggerLabel']");
    return l ? l.textContent : null;
  });
  check('★ 档位页显示「选择强度」', lvlText === '选择强度', String(lvlText));

  /* 离开到列表页 */
  await page.evaluate(() => { window.__pane = 'model'; window.__render(); });
  await page.waitForTimeout(200);
  await drive(page, () => window.__enhance(document.getElementById('menu')));
  await page.waitForTimeout(200);
  const offText = await page.evaluate(() => {
    window.__lib.relabelTrigger();
    const l = document.querySelector("[class*='triggerLabel']");
    const e = document.querySelector("[class*='triggerEffort']");
    return { label: l ? l.textContent : null, effort: e ? e.textContent : null };
  });
  check('★ 列表页恢复模型名', offText.label === 'DeepSeek-V41-Flash', String(offText.label));
  check('★ 列表页恢复档位名', offText.effort === 'High', String(offText.effort));
  await page.close();
}

console.log('4. 选择强度不会污染弹层里的模型名');
{
  const { page } = await mount();
  await page.evaluate(() => window.__open());
  await page.waitForTimeout(150);
  await drive(page, () => window.__enhance(document.getElementById('menu')));
  await page.waitForTimeout(400);
  const names = await page.evaluate(() => {
    window.__lib.relabelTrigger();
    return [...document.querySelectorAll("[role='menuitemradio'], [role='menuitem']")].map(e => e.textContent);
  });
  check('弹层内没有出现"选择强度"', !names.some(t => t.includes('选择强度')), names.join('/'));
  await page.close();
}

console.log('5. 选完有档位的模型 → 自然回到滑杆页');
{
  const { page, errors } = await mount();
  await page.evaluate(() => window.__open());
  await page.waitForTimeout(150);
  await drive(page, () => { window.__pane = 'model'; window.__render(); window.__enhance(document.getElementById('menu')); });
  await page.waitForTimeout(300);
  const hooked = await page.evaluate(() => {
    const it = document.querySelectorAll("[role='menuitemradio']");
    return it.length >= 2;
  });
  check('模型列表页有多个模型项', hooked);
  await page.evaluate(() => {
    window.__afterPicked = new Function(window.__src, 'return afterModelPicked;')();
  }).catch(() => {});
  /* 直接调用插件的 afterModelPicked（模拟选中模型后宿主关菜单） */
  await page.evaluate(src => {
    const f = new Function(src + 'return afterModelPicked;')();
    /* 宿主行为：选中即关菜单 */
    window.__pane = 'root'; window.__menuOpen = true; window.__render();
    setTimeout(f, 0);
  }, INSTALL_SRC);
  await page.waitForTimeout(1500);
  const pane = await page.evaluate(() => window.__pane);
  check('★ 有档位时回到档位页（滑杆页）', pane === 'effort', 'pane=' + pane);
  const hasSlider = await page.evaluate(() => {
    window.__enhance(document.getElementById('menu'));
    return !!document.querySelector('.dshp-slider');
  });
  check('★ 滑杆已装上', hasSlider);
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close();
}

console.log('6. 没有推理强度的模型 → 直接进模型列表');
{
  const { page, errors } = await mount();
  await drive(page, () => window.__open());
  await page.waitForTimeout(200);
  /* effortChoicesOf 读不到 fiber 时返回 null；这里用覆盖实现注入"无档位/有档位"两种情况。 */
  /* 每次都在同一个实例里注入：effortChoicesOf 覆盖 + userInteracted=true，
     否则增强器会因为「用户还没交互过」直接 return，自动推进不会发生。 */
  const run = (efforts) => page.evaluate(({ src, effs }) => {
    if (!window.__scenario6) {
      window.__scenario6 = new Function(src + `
        var __eff = null;
        function effortChoicesOf(menu) { return __eff; }
        function __arm() { userInteracted = true; }
        return { enhanceModelMenu: enhanceModelMenu, arm: __arm, set: function (e) { __eff = e; } };
      `)();
      window.__scenario6.arm();
    }
    window.__scenario6.set(effs);
    window.__pane = 'root'; window.__render();
    window.__scenario6.enhanceModelMenu(document.getElementById('menu'));
    return window.__pane;
  }, { src: INSTALL_SRC, effs: efforts });

  const noEff = await run([]);
  check('★ 无档位时自动进入模型列表', noEff === 'model', 'pane=' + noEff);

  /* 导航锁有 1.5s 时间窗（防抖），对照组要等它过期，否则会被正确地抑制掉。 */
  await page.waitForTimeout(1700);
  const hasEff = await run([{ id: 'high' }, { id: 'low' }]);
  check('有档位时仍进滑杆页', hasEff === 'effort', 'pane=' + hasEff);
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close();
}

console.log('7. 收起菜单后恢复宿主原文案');
{
  const { page, errors } = await mount();
  await drive(page, () => window.__open());
  await page.waitForTimeout(200);
  /* 进档位页 → 装滑杆 → 文案变「选择强度」 */
  await page.evaluate(() => { window.__pane = 'effort'; window.__render(); });
  await drive(page, () => window.__enhance(document.getElementById('menu')));
  await page.waitForTimeout(300);
  const whileOpen = await page.evaluate(() => {
    window.__lib.relabelTrigger();
    const l = document.querySelector("[class*='triggerLabel']");
    return l ? l.textContent : null;
  });
  check('打开时显示「选择强度」', whileOpen === '选择强度', String(whileOpen));

  /* 收起：宿主把菜单节点整个从 DOM 摘掉（真机行为）。
     这里用**插件自己的** mutationTouchesMenu + MutationObserver 链路，
     这样回退修复时这个用例真的会红。 */
  const afterClose = await page.evaluate(async src => {
    const lib = new Function(src + `
      function __arm2() { userInteracted = true; }
      var __scans = 0;
      var __obs = new MutationObserver(function (records) {
        var maybe = false;
        for (var i = 0; i < records.length && !maybe; i++) {
          if (mutationTouchesMenu(records[i])) maybe = true;
        }
        if (maybe) { __scans++; relabelTrigger(); }
      });
      __obs.observe(document.body, { childList: true, subtree: true });
      return { relabel: relabelTrigger, scans: function () { return __scans; } };
    `)();
    /* 收起菜单：把浮层节点整个摘掉 */
    window.__pane = 'root'; window.__menuOpen = false; window.__render();
    await new Promise(r => setTimeout(r, 250));
    lib.relabel();
    const l = document.querySelector("[class*='triggerLabel']");
    const e = document.querySelector("[class*='triggerEffort']");
    return { label: l ? l.textContent : null, effort: e ? e.textContent : null, scans: lib.scans() };
  }, INSTALL_SRC);
  check('★ 收起被识别为菜单变动', afterClose.scans >= 1, 'scans=' + afterClose.scans);
  check('★ 收起后恢复模型名', afterClose.label === 'DeepSeek-V41-Flash', String(afterClose.label));
  check('★ 收起后恢复档位名', afterClose.effort === 'High', String(afterClose.effort));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close();
}
await browser.close();
console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
process.exit(failures === 0 ? 0 : 1);







