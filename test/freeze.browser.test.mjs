/**
 * 回归验证：卡死。
 *
 * 卡死的两个来源，这里各测一条：
 *   ① 导航循环重叠 —— openModelList / afterModelPicked 曾经各自跑自己的 rAF 循环，
 *      还能被彼此的「菜单消失 → 重开触发器」分支唤醒，同时跑时每帧都要走
 *      hostPane()（找 React fiber + 遍历 hook 链），主线程被占满。
 *   ② 档位名守护表叠加 —— 每 commit 一次新起一个 2.5s/40ms 的 setInterval，
 *      宿主每重建一次菜单就多留一个。
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
const SRC = CONSTS_SRC + '\n' + ALL_FUNCS_SRC + '\n';
const defaultsSrc = (/var DEFAULTS = \{[\s\S]*?\};/.exec(source) || [''])[0];
const cssText = new Function(defaultsSrc + '\n' + grabFunction('readConfig') + '\n' + grabFunction('buildCss') + '\nreturn buildCss(readConfig({}));')();

const CHROME = process.env.DSHP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME });
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' - ' + detail));
  if (!ok) failures++;
};

console.log('1. 导航循环互斥：新请求顶掉旧循环');
{
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.setContent(`<!doctype html><html><head><style>${cssText}</style></head><body>
    <div data-slot="conversation.input.model"><button title="M - High">
      <span class="_triggerLabel_">M</span><span class="_triggerEffort_">High</span></button></div>
    <div id="host"></div></body></html>`);
  const res = await page.evaluate(src => {
    /* 用**插件自己的** beginNavLoop，不覆盖 —— 这样测的才是真实现。 */
    const lib = new Function(src + 'return { beginNavLoop: beginNavLoop, token: function () { return navLoopToken; } };')();
    /* 第一个循环：一直返回 true（模拟卡住不退出） */
    const a = lib.beginNavLoop(1000);
    let aSteps = 0;
    let aExited = false;
    const runA = () => {
      if (aExited) return;
      aSteps++;
      const keep = a.tick(() => true);
      if (!keep) { aExited = true; return; }
      requestAnimationFrame(runA);
    };
    /* 先让 A 跑几帧，确认它真的活着 */
    for (let i = 0; i < 3; i++) {
      aSteps++;
      if (!a.tick(() => true)) { aExited = true; break; }
    }
    const tokenA = a.token;
    /* 第二个循环启动：应当立刻让第一个失效 */
    const b = lib.beginNavLoop(1000);
    let bAlive = true;
    const runB = () => { if (!bAlive) return; bAlive = b.tick(() => true); if (bAlive) requestAnimationFrame(runB); };
    runB();
    /* A 继续跑：下一帧 tick 就该因为 token 过期而返回 false。 */
    aSteps++;
    if (!a.tick(() => true)) aExited = true;
    return new Promise(resolve => setTimeout(() => resolve({
      aExited: aExited, bAlive: bAlive, aSteps: aSteps, tokenA: tokenA, tokenB: b.token,
    }), 400));
  }, SRC);
  check('★ 旧循环被顶掉并退出', res.aExited === true, 'aExited=' + res.aExited);
  check('★ 新循环仍在跑', res.bAlive === true, 'bAlive=' + res.bAlive);
  check('新 token 更大', res.tokenB > res.tokenA, res.tokenA + ' -> ' + res.tokenB);
  check('旧循环只跑了少量帧就退出', res.aSteps <= 4, 'aSteps=' + res.aSteps);
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close();
}

console.log('2. 守护表全局唯一：重建滑杆不会叠加定时器');
{
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.setContent(`<!doctype html><html><head><style>${cssText}
    :root{--dsw-alias-state-business-primary:#3b82f6;--dsw-alias-bg-layer-1:#fff;}
    body{margin:24px;font:14px system-ui}
    [role='menuitemradio']{display:flex;width:220px;padding:8px 10px;border:0;background:none;border-radius:8px;cursor:pointer;font:inherit;text-align:left}
  </style></head><body>
    <div data-slot="conversation.input.model"><button title="M - High">
      <span class="_triggerLabel_">M</span><span class="_triggerEffort_">High</span></button></div>
    <div id="host"></div></body></html>`);
  const res = await page.evaluate(src => {
    const LEVELS = ['Off', 'Low', 'High', 'Max'];
    const lib = new Function(src + 'return { installSlider: installSlider };')();
    const host = document.getElementById('host');
    /* 统计真实存活的 setInterval 数量 */
    let live = 0;
    const realSetInterval = window.setInterval;
    window.setInterval = function () { live++; return realSetInterval.apply(window, arguments); };
    const realClear = window.clearInterval;
    window.clearInterval = function (id) { live--; return realClear.apply(window, arguments); };

    function mount() {
      host.innerHTML = '<div role="menu">' + LEVELS.map((l, i) =>
        '<button role="menuitemradio" aria-checked="' + (i === 2) + '">' + l + '</button>').join('') + '</div>';
      return host.firstElementChild;
    }
    /* 装 5 次（模拟宿主反复重建菜单），每次点一下轨道触发 commit */
    for (let k = 0; k < 5; k++) {
      const menu = mount();
      lib.installSlider(menu);
      const track = menu.querySelector('.dshp-sliderTrack');
      const r = track.getBoundingClientRect();
      const cx = r.right - 2, cy = r.top + r.height / 2;
      track.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 1, isPrimary: true }));
      track.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 1, isPrimary: true }));
    }
    window.setInterval = realSetInterval;
    window.clearInterval = realClear;
    return { live: live };
  }, SRC);
  /* 装 5 次 = 最多 1 个守护表（旧的在装新滑杆时被 stopSliderGuard 停掉） */
  check('★ 5 次重建后最多 1 个定时器', res.live <= 1, '存活定时器=' + res.live);
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close();
}

console.log('3. 无档位/有档位切换仍然正确（确认没改坏导航）');
{
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.setContent(`<!doctype html><html><head><style>${cssText}</style></head><body>
    <div data-slot="conversation.input.model"><button title="M - High">
      <span class="_triggerLabel_">M</span><span class="_triggerEffort_">High</span></button></div>
    <div id="host"></div></body></html>`);
  const res = await page.evaluate(src => {
    const lib = new Function(src + `
      function __arm() { userInteracted = true; }
      return { afterModelPicked: afterModelPicked, arm: __arm };
    `)();
    lib.arm();
    window.__pane = 'root';
    window.__rows = 2;
    /* 造一个两行页菜单 + 模型列表页菜单 */
    window.__makeRoot = () => {
      const host = document.getElementById('host');
      host.innerHTML = '<div role="menu"><button role="menuitem">模型</button><button role="menuitem">推理等级</button></div>';
      const menu = host.firstElementChild;
      menu.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        window.__pane = b === menu.children[0] ? 'model' : 'effort';
        window.__makePane();
      });
      return menu;
    };
    window.__makePane = () => {
      const host = document.getElementById('host');
      if (window.__pane === 'model') {
        host.innerHTML = '<div role="menu"><button role="menuitemradio">A</button><button role="menuitemradio">B</button></div>';
      } else if (window.__pane === 'effort') {
        host.innerHTML = '<div role="menu">' + ['Off','Low','High','Max'].map((l,i)=>
          '<button role="menuitemradio" aria-checked="'+(i===2)+'">'+l+'</button>').join('') + '</div>';
      }
    };
    window.__makeRoot();
    /* effortChoicesOf 读不到 fiber → null → 走「有档位」分支，期望进 effort */
    lib.afterModelPicked();
    return new Promise(r => setTimeout(() => r({ pane: window.__pane }), 800));
  }, SRC);
  check('★ 有档位 → 回到滑杆页', res.pane === 'effort', 'pane=' + res.pane);
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close();
}

await browser.close();
console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
process.exit(failures === 0 ? 0 : 1);





