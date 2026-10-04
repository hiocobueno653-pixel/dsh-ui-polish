/**
 * 真浏览器验证：推理等级滑杆。
 *
 * 为什么必须在真引擎里跑：命中判定要用 getBoundingClientRect + pointer 事件 +
 * setPointerCapture，jsdom 既没有真实布局也没有指针捕获。
 *
 * 关键约束（真机上量出来的）：**宿主的 radio 一被点就关菜单**，
 * 所以滑杆必须「拖动只改视觉、松手才提交」，不能边拖边点。
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
/* 把源码里所有类名常量一起带进页面：installSlider 之类会引用
   LEVEL_LABEL_CLASS / SLIDER_CLASS 等，少带一个就是 ReferenceError。
   以前这里是手写一行 var RADIO_SELECTOR，后加常量时就漏过一次。 */
const CONSTS_SRC = (source.match(/^\t\tvar [A-Za-z_$][\w$]*[^\n]*$/gm) || [])
  .filter(l => !/^var (module|exports) /.test(l))
  .map(l => l.replace(/^\t\t/, ''))
  .join('\n');
/* 注意：函数对象没法当参数穿过 Playwright 的序列化，所以传**源码**，
   在页面里 new Function 出来用——测的仍然是插件里那一份实现。 */
/* 自动带上源码里**所有**顶层函数定义。
   installSlider 内部会调 syncLabelsTo / fracAt / measureGeo / paintFrac 等一串函数，
   以前靠手写 grabFunction 列表，后加函数时就漏过（表现为 ReferenceError 或断言失败）。
   全量带上最省事，也最不容易再坏——函数声明会提升，顺序无关。 */
const ALL_FUNCS_SRC = (() => {
  const names = [...source.matchAll(/^\t\tfunction ([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]);
  return names.map(n => grabFunction(n)).join('\n');
})();
const INSTALL_SRC = CONSTS_SRC + '\n' + ALL_FUNCS_SRC + '\n';

const ensureInstaller = page =>
  page.evaluate(src => {
    if (!window.__installSlider) window.__installSlider = new Function(src + 'return installSlider;')();
    return true;
  }, INSTALL_SRC);

const defaultsSrc = (/var DEFAULTS = \{[\s\S]*?\};/.exec(source) || [''])[0];
const cssText = new Function(defaultsSrc + '\n' + grabFunction('readConfig') + '\n' + grabFunction('buildCss') + '\nreturn buildCss(readConfig({}));')();

const CHROME = process.env.DSHP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME });
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};

/* 仿真宿主菜单：4 档，第三档（High）选中；点任何一项都会"关菜单"（这里用计数模拟）。 */
const LEVELS = ['Auto', 'Low', 'High', 'Max'];
async function mountMenu(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  /* 主题变量：浅色一套、深色一套（和 glass 套件同款模拟）。
     深色的关键点：bg-layer-1 是深灰 —— 滑钮以前跟着它走，整颗钮沉进
     深色毛玻璃里看不见（用户要求深色下也要白色）。 */
  const themeVars = opts.dark
    ? '--dsw-alias-state-business-primary:#3b82f6;--dsw-alias-bg-layer-2:#2c2c2f;--dsw-alias-bg-layer-1:#232326;--dsw-alias-label-primary:#f5f5f7;'
    : '--dsw-alias-state-business-primary:#3b82f6;--dsw-alias-bg-layer-2:#ececf0;--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#111114;';
  await page.setContent(`<!doctype html><html><head><style>${cssText}
    :root{${themeVars}}
    body{margin:24px;font:14px system-ui}
    [role='menuitemradio']{display:flex;width:220px;padding:8px 10px;border:0;background:none;border-radius:8px;cursor:pointer;font:inherit;text-align:left}
  </style></head><body>
    <div role="menu" aria-label="模型与推理等级" id="menu">
      ${LEVELS.map((l, i) => `<button type="button" role="menuitemradio" aria-checked="${i === opts.current ? 'true' : 'false'}"><span class="name">${l}</span></button>`).join('')}
    </div>
    <div id="log"></div>
  </body></html>`);
  /* 宿主行为：点某一项 → 记录 + 关菜单（点完菜单就没了，和真机一致） */
  await page.evaluate(() => {
    document.querySelectorAll("[role='menuitemradio']").forEach(btn => {
      btn.addEventListener('click', () => {
        window.__picked = (btn.textContent || '').trim();
        const menu = document.querySelector("[role='menu']");
        if (menu) menu.remove();     // ← 真机就是这样：选完菜单关闭
      });
    });
  });
  await ensureInstaller(page);
  const installed = await page.evaluate(() => !!window.__installSlider(document.querySelector('#menu')));
  /* 等两件事：
     ① measure() 要等一帧才能量到布局（真机也是分帧长出来的）；
     ② 滑钮的 transition 是 260ms，读位置必须等它跑完。
     这里直接等「滑钮位置稳定」而不是固定时长——机器忙时 400ms 也可能不够。 */
  await page.waitForFunction(() => {
    const k = document.querySelector('.dshp-sliderKnob');
    const s = document.querySelector('.dshp-slider');
    if (!k || !s) return false;
    /* ⚠️ 这里必须等"真正落位"，不能只比 x 和 transform：刚装上时 --dshp-x 是空串
       （parseFloat('')||0 = 0），transform 也是 0，两者"相等"会被当成已稳定 —— 而这时
       dshp-first 还挂着（transition:none），换档会**瞬移**而不是滑行，
       后面"摘除时应在半途"的前提就永远成立不了（实测 oldX 直接落在目标档）。
       所以：过渡已放开（无 dshp-first）+ 轨道已量到（travel>0）+ 位置已追平。 */
    if (s.classList.contains('dshp-first')) return false;
    const xRaw = s.style.getPropertyValue('--dshp-x');
    if (xRaw === '') return false;
    const x = parseFloat(xRaw) || 0;
    const travel = parseFloat(s.style.getPropertyValue('--dshp-travel')) || 0;
    if (travel <= 0) return false;
    const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(k).transform);
    if (!m) return false;
    const parts = m[1].split(',').map(v => parseFloat(v.trim()));
    const tx = parts.length >= 6 ? parts[4] : 0;
    return Math.abs(tx - x) < 1;      /* 动画已到位 */
  }, { timeout: 5000 }).catch(() => {});
  return { page, installed };
}

console.log('装上了吗');
{
  const { page, installed } = await mountMenu({ current: 2 });
  check('等级页装上了滑杆', installed);
  const info = await page.$eval('.dshp-slider', el => ({
    role: el.getAttribute('role'),
    now: el.getAttribute('aria-valuenow'),
    text: el.getAttribute('aria-valuetext'),
    max: el.getAttribute('aria-valuemax'),
    dots: el.querySelectorAll('.dshp-sliderDot').length,
  }));
  check('滑杆的 a11y 属性齐全', info.role === 'slider' && info.max === '3' && info.dots === 4, JSON.stringify(info));
  check('初始停在当前档（第 3 档）', info.now === '2' && info.text === LEVELS[2], JSON.stringify(info));
  const geo = await page.evaluate(() => {
    const t = document.querySelector('.dshp-sliderTrack').getBoundingClientRect();
    const k = document.querySelector('.dshp-sliderKnob').getBoundingClientRect();
    const f = document.querySelector('.dshp-sliderFill').getBoundingClientRect();
    return { track: t.width, left: t.left, right: t.right, knobLeft: k.left, knobRight: k.right, knobCenter: k.left + k.width / 2, fillRight: f.right };
  });
  const expectedCenter = geo.left + 11 + (geo.track - 22) * (2 / 3);
  check('滑钮停在 2/3 处（第 3/4 档）', Math.abs(geo.knobCenter - expectedCenter) < 1.5,
    `knob ${geo.knobCenter.toFixed(1)} vs ${expectedCenter.toFixed(1)}`);
  /* 填色盖到滑钮**圆心**：滑钮是圆的，填到右缘时那条被 scaleX 压出的直边会在
     上下边缘处超出圆的收边，蓝色从滑钮右肩露出来（用户截图）。填到圆心则直边
     永远藏在钮最宽处底下。最右档另有吸附铺满（见下方 Max 档用例）。 */
  check('填充右缘落在滑钮圆心（不越出、不露肩）',
    Math.abs(geo.fillRight - geo.knobCenter) < 1.5 && geo.fillRight <= geo.knobRight + 0.5,
    `fill ${geo.fillRight.toFixed(1)} vs center ${geo.knobCenter.toFixed(1)} / right ${geo.knobRight.toFixed(1)}`);
  await page.close();
}

console.log('两端：滑钮不许探出轨道');
{
  for (const [label, idx] of [['第一档', 0], ['最后一档', LEVELS.length - 1]]) {
    const { page } = await mountMenu({ current: idx });
    const geo = await page.evaluate(() => {
      const t = document.querySelector('.dshp-sliderTrack').getBoundingClientRect();
      const k = document.querySelector('.dshp-sliderKnob').getBoundingClientRect();
      return { trackLeft: t.left, trackRight: t.right, knobLeft: k.left, knobRight: k.right };
    });
    check(`${label}：滑钮完全落在轨道内`, geo.knobLeft >= geo.trackLeft - 0.5 && geo.knobRight <= geo.trackRight + 0.5,
      `knob ${geo.knobLeft.toFixed(1)}–${geo.knobRight.toFixed(1)} / track ${geo.trackLeft.toFixed(1)}–${geo.trackRight.toFixed(1)}`);
    await page.close();
  }
}

console.log('拖动：只改视觉，松手才提交');
{
  const { page } = await mountMenu({ current: 2 });   // High
  const box = await page.$eval('.dshp-sliderTrack', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  /* 拖到最左（第一档）但**先不松手** */
  await page.mouse.move(box.x + box.w * 0.9, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 2, box.y + box.h / 2, { steps: 6 });
  const mid = await page.evaluate(() => ({
    picked: window.__picked || null,                       // 还没提交
    now: document.querySelector('.dshp-slider').getAttribute('aria-valuenow'),
    target: document.querySelector("[data-dshp-target]") ? document.querySelector("[data-dshp-target]").textContent.trim() : null,
    menuAlive: !!document.querySelector("[role='menu']"),
  }));
  check('拖动中：菜单还开着（没有边拖边点）', mid.menuAlive && mid.picked === null, JSON.stringify(mid));
  check('拖动中：滑杆指到第一档', mid.now === '0', String(mid.now));
  check('拖动中：列表里对应那一行被点亮', mid.target === LEVELS[0], String(mid.target));
  /* 松手 → 提交 */
  await page.mouse.up();
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => ({ picked: window.__picked || null, menuAlive: !!document.querySelector("[role='menu']") }));
  check('★ 松手才提交：选中第一档', after.picked === LEVELS[0], JSON.stringify(after));
  check('提交后菜单关闭（和宿主原本行为一致）', !after.menuAlive, JSON.stringify(after));
  await page.close();
}

console.log('松手时若没换档：不提交、不动状态');
{
  const { page } = await mountMenu({ current: 1 });   // Low
  const box = await page.$eval('.dshp-sliderTrack', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + box.w * 0.34, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.35, box.y + box.h / 2);
  await page.mouse.up();
  await page.waitForTimeout(120);
  const st = await page.evaluate(() => ({ picked: window.__picked || null, menuAlive: !!document.querySelector("[role='menu']"), now: document.querySelector('.dshp-slider').getAttribute('aria-valuenow') }));
  check('原地松手不提交（菜单不关）', st.picked === null && st.menuAlive, JSON.stringify(st));
  check('滑杆回到当前档', st.now === '1', String(st.now));
  await page.close();
}

console.log('点击轨道（不拖）也能选');
{
  const { page } = await mountMenu({ current: 0 });   // Off
  const box = await page.$eval('.dshp-sliderTrack', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + box.w * 0.99, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);
  check('点最右端 → 选最后一档', await page.evaluate(() => window.__picked) === LEVELS[LEVELS.length - 1], String(await page.evaluate(() => window.__picked)));
  await page.close();
}

console.log('原本就在最右档时打开：填色要铺满（用户报的场景）');
{
  const { page } = await mountMenu({ current: LEVELS.length - 1 });   // Max
  await page.waitForTimeout(500);      /* 等落位动画走完 */
  const geoMax = await page.evaluate(() => {
    const t = document.querySelector('.dshp-sliderTrack').getBoundingClientRect();
    const f = document.querySelector('.dshp-sliderFill').getBoundingClientRect();
    const k = document.querySelector('.dshp-sliderKnob').getBoundingClientRect();
    return { trackRight: t.right, fillRight: f.right, knobRight: k.right };
  });
  check('★ 最右档：填色铺满到轨道右端（右边不露灰）',
    Math.abs(geoMax.fillRight - geoMax.trackRight) < 1.5 && Math.abs(geoMax.knobRight - geoMax.trackRight) < 1.5,
    JSON.stringify(geoMax));
  await page.close();
}

console.log('深色主题：滑钮仍白、轨道仍可见（用户要求深色下按钮也是白色）');
{
  /* 夹具里的 bg-layer-1 = #232326（宿主深色同款）、label-primary 反相为近白。
     以前 --dshp-knob 绑 bg-layer-1：深色下钮变深灰，几乎和轨道同色看不见。 */
  const { page } = await mountMenu({ current: 1, dark: true });
  const colors = await page.evaluate(() => {
    /* 通道提取要兼容两种序列化：rgba(…) 和 Chrome 对带 alpha 的 color-mix
       原样保留的 color(srgb r g b / a)（0~1 通道，×255 归一）。 */
    const chans = str => {
      let m = /rgba?\(([^)]+)\)/.exec(str);
      if (m) return m[1].split(',').slice(0, 3).map(v => parseFloat(v.trim()));
      m = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(str);
      if (m) return [parseFloat(m[1]) * 255, parseFloat(m[2]) * 255, parseFloat(m[3]) * 255];
      return null;
    };
    const s = document.querySelector('.dshp-slider');
    const cs = getComputedStyle(s);
    return {
      knob: chans(getComputedStyle(document.querySelector('.dshp-sliderKnob')).backgroundColor),
      track: chans(getComputedStyle(document.querySelector('.dshp-sliderTrack')).backgroundColor),
      /* --dshp-knob 写在样式表（.dshp-slider 规则）里，不在内联 style 上：
         必须用 getComputedStyle 读。 */
      knobVar: (cs.getPropertyValue('--dshp-knob') || '').trim(),
    };
  });
  const whiteish = c => !!c && c[0] >= 250 && c[1] >= 250 && c[2] >= 250;
  check('★ 深色下滑钮仍是纯白', whiteish(colors.knob), JSON.stringify(colors.knob));
  /* 轨道 = 文字色(深色主题下是 #f5f5f7) 13% + 透明：alpha 混在通道里，
     RGB 通道仍是浅色 —— 这正是"深色下轨道和深灰玻璃底分得开"的机制。
     阈值 180：要防的回归是把它改回 bg-layer-2（深色下 = 44,44,47 的深灰，轨道消失），
     而不是要求它等于纯白。 */
  check('★ 深色下轨道用的是反相后的浅色通道（不沉底）', (() => {
    const c = colors.track;
    return !!c && c[0] >= 180 && c[1] >= 180 && c[2] >= 180;
  })(), JSON.stringify(colors.track));
  check('★ --dshp-knob 已固定为 #fff（不再跟 bg-layer-1）', colors.knobVar === '#fff', colors.knobVar);
  await page.close();
}

console.log('键盘：←/→ 直接换档');
{
  const { page } = await mountMenu({ current: 1 });   // Low
  await page.focus('.dshp-slider');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  check('→ 选中下一档', await page.evaluate(() => window.__picked) === LEVELS[2], String(await page.evaluate(() => window.__picked)));
  await page.close();

  const p2 = await mountMenu({ current: 3 });   // Max
  await p2.page.focus('.dshp-slider');
  await p2.page.keyboard.press('Home');
  await p2.page.waitForTimeout(150);
  check('Home 直接到第一档', await p2.page.evaluate(() => window.__picked) === LEVELS[0], String(await p2.page.evaluate(() => window.__picked)));
  await p2.page.close();

  const p3 = await mountMenu({ current: 0 });   // Off
  await p3.page.focus('.dshp-slider');
  await p3.page.keyboard.press('ArrowLeft');
  await p3.page.waitForTimeout(120);
  check('已经在第一档时 ← 不提交（菜单不关）', await p3.page.evaluate(() => !!document.querySelector("[role='menu']")), '');
  await p3.page.close();
}

console.log('不误伤：不是"选项列表"的菜单不装滑杆');
{
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.setContent(`<!doctype html><html><body style="margin:24px">
    <div role="menu" id="plain">
      <button role="menuitem">仅可查看</button>
      <button role="menuitem">工作区内修改</button>
    </div>
    <div role="menu" id="one"><button role="menuitemradio" aria-checked="true">只有一个</button></div>
  </body></html>`);
  await ensureInstaller(page);
  const res = await page.evaluate(() => ({
    plain: !!window.__installSlider(document.querySelector('#plain')),
    one: !!window.__installSlider(document.querySelector('#one')),
    sliders: document.querySelectorAll('.dshp-slider').length,
  }));
  check('普通菜单不装', res.plain === false && res.one === false, JSON.stringify(res));
  check('页面里没有多余的滑杆', res.sliders === 0, String(res.sliders));
  await page.close();
}

console.log('幂等：重复装不会叠出第二条');
{
  const { page } = await mountMenu({ current: 2 });
  const count = await page.evaluate(() => {
    window.__installSlider(document.querySelector('#menu'));
    window.__installSlider(document.querySelector('#menu'));
    return document.querySelectorAll('.dshp-slider').length;
  });
  check('重复调用只有一条滑杆', count === 1, String(count));
  await page.close();
}

console.log('等级页里混进多条滑杆时：去重而不是半套增强（真机 React 重渲染会复制插入节点）');
{
  /* 旧实现只处理第一条：第一条未接线被移除后，installSlider 因"已有滑杆"返回 null，
     下面 slider.contains() 直接抛 TypeError，整轮扫描被吞 —— 灰框插了、滑杆没装。 */
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.setContent(`<!doctype html><html><head><style>${cssText}
    :root{--dsw-alias-state-business-primary:#3b82f6;--dsw-alias-bg-layer-1:#fff;}
    body{margin:24px;font:14px system-ui}
    [role='menuitemradio']{display:flex;width:220px;padding:8px 10px;border:0;background:none;border-radius:8px;cursor:pointer;font:inherit;text-align:left}
  </style></head><body>
    <div role="menu" id="menu">
      ${['Auto', 'Low', 'High', 'Max'].map((l, i) => `<button type="button" role="menuitemradio" aria-checked="${i === 2}"><span class="modelName">${l}</span></button>`).join('')}
    </div></body></html>`);
  const res = await page.evaluate(src => {
    const enhance = new Function(src + 'return enhanceModelMenu;')();
    const menu = document.getElementById('menu');
    const mk = (wired, id) => {
      const d = document.createElement('div');
      d.className = 'dshp-slider';
      if (wired) d.dataset.dshpWired = '1';
      d.id = id;
      menu.appendChild(d);
      return d;
    };
    /* 场景 A：两条都未接线 → 全拆重装，且不许抛 */
    mk(false, 'a1'); mk(false, 'a2');
    let threw = null;
    try { enhance(menu); } catch (e) { threw = String(e && e.message || e); }
    const afterA = {
      threw: threw,
      count: menu.querySelectorAll('.dshp-slider').length,
      wired: menu.querySelector('.dshp-slider') ? menu.querySelector('.dshp-slider').dataset.dshpWired : null,
      levelPage: menu.classList.contains('dshp-levelPage'),
    };
    /* 场景 B：第一条已接线、第二条是野生的 → 保留第一条（身份不变） */
    menu.querySelectorAll('.dshp-slider').forEach(s => s.remove());
    const keep = mk(true, 'keepme'); mk(false, 'stray');
    let threw2 = null;
    try { enhance(menu); } catch (e) { threw2 = String(e && e.message || e); }
    const afterB = {
      threw: threw2,
      count: menu.querySelectorAll('.dshp-slider').length,
      keptFirst: document.getElementById('keepme') === keep && keep.isConnected,
      strayGone: !document.getElementById('stray'),
    };
    return { afterA: afterA, afterB: afterB };
  }, INSTALL_SRC);
  check('★ 两条半成品滑杆：不抛错、重装成一条接好线的、等级页标记正常',
    res.afterA.threw === null && res.afterA.count === 1 && res.afterA.wired === '1' && res.afterA.levelPage,
    JSON.stringify(res.afterA));
  check('★ 一好一坏：保留接好线的那条、拆掉野生的',
    res.afterB.threw === null && res.afterB.count === 1 && res.afterB.keptFirst && res.afterB.strayGone,
    JSON.stringify(res.afterB));
  check('无页面报错', errs.length === 0, errs.join('|'));
  await page.close();
}

console.log('飞行交接：滑行半途滑杆被宿主重建时，动画接得上（不瞬移、不闪回、不叠影）');
{
  /* 键盘换档 1→2：滑钮从 1/3 行程向 2/3 滑行（380ms 过渡）。
     滑行半途把滑杆整个摘掉再重装 —— 模拟宿主重渲染对滑杆节点的重建。
     radio 的 aria-checked 仍是旧档（宿主异步往返还没回包），这正是
     "闪回旧档"的源头；旧节点的滑行则会被拦腰砍成硬切。 */
  const { page } = await mountMenu({ current: 1 });
  /* ⚠️ 夹具没有 React fiber，commit 会走 radio.click() 退路、把整个菜单摘掉；
     真机走的是 select()，菜单不关（半途重建恰恰发生在"菜单还开着"的时候）。
     实例属性盖掉原型方法：只让"这扇门"的 remove 变空转，radio 上的监听
     不用动（滑杆闭包还握着原 radio 的引用，换节点反而会把联动拆散）。 */
  await page.evaluate(() => {
    const menu = document.getElementById('menu');
    menu.remove = function () {};
  });
  await page.evaluate(() => {
    document.querySelector('.dshp-slider')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await page.waitForTimeout(120);   /* 滑行到约 1/3 程（380ms 曲线的半途区） */
  const f1 = await page.evaluate(async () => {
    const menu = document.getElementById('menu');
    const tx = el => {
      const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform);
      return m ? parseFloat(m[1].split(',')[4]) : 0;
    };
    const old = menu.querySelector('.dshp-slider');
    const oldX = tx(old.querySelector('.dshp-sliderKnob'));
    old.remove();                     /* React 摘掉旧节点 */
    const s2 = window.__installSlider(menu);   /* ……并在下一帧装上新的 */
    if (!s2) throw new Error('重装失败');
    const travel = parseFloat(s2.style.getPropertyValue('--dshp-travel'));
    const firstX = parseFloat(s2.style.getPropertyValue('--dshp-x'));
    const samples = [];
    for (let i = 0; i < 30; i++) {    /* ~500ms：盖住交接放行 + 补完滑行 + 时长收回 */
      await new Promise(r => requestAnimationFrame(r));
      const k = s2.querySelector('.dshp-sliderKnob');
      if (k) samples.push(tx(k));
    }
    return {
      travel, oldX, firstX, count: menu.querySelectorAll('.dshp-slider').length,
      min: Math.min.apply(null, samples), last: samples[samples.length - 1],
      dur: s2.style.getPropertyValue('--dshp-dur'),
    };
  });
  const from1 = f1.travel / 3, to1 = f1.travel * 2 / 3;
  const fmt = v => Number(v.toFixed(1));
  check('★ 前提：摘除瞬间旧滑钮确实在半途',
    f1.oldX > from1 + 3 && f1.oldX < to1 - 3,
    `oldX=${fmt(f1.oldX)} from=${fmt(from1)} to=${fmt(to1)}`);
  /* 第一帧必须仍在半途带内：贴回旧档(from1)=闪回，贴到目标(to1)=硬切瞬移。
     带内沿留 8% 行程的余量 —— JS 飞行曲线是宿主回弹曲线的近似，
     两者对不上半档以内是正常的，别把断言卡在执行时序上。 */
  check('★ 重建第一帧落在半途带内（不闪回旧档、不瞬移到目标）',
    f1.firstX > from1 + f1.travel * 0.08 && f1.firstX < to1 - f1.travel * 0.08,
    `firstX=${fmt(f1.firstX)} band=(${fmt(from1 + f1.travel * 0.08)},${fmt(to1 - f1.travel * 0.08)}) oldX=${fmt(f1.oldX)}`);
  check('★ 补完滑行不闪回（全程不低于换档前的旧档位）',
    f1.min >= from1 - 2.5, `min=${fmt(f1.min)} from=${fmt(from1)}`);
  check('★ 补完滑行落到目标档', Math.abs(f1.last - to1) <= 1.5,
    `last=${fmt(f1.last)} to=${fmt(to1)}`);
  check('★ 交接临时时长用完即收回（--dshp-dur 不残留，之后的换档不会被"动画忽快"污染）',
    f1.dur === '', String(f1.dur));
  check('★ 重建不叠影：菜单里仍只有一条滑杆', f1.count === 1, String(f1.count));

  /* 二次交接：接棒的补完段里**再**重建一次（这回奔 Max）。
     飞行记录/认领必须各按各的剩余时长走，否则越接越慢或越接越快；
     Max 档还要验证补完后填色吸附铺满（--dshp-sx=1）。 */
  await page.evaluate(() => {
    document.querySelector('.dshp-slider')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await page.waitForTimeout(90);
  const f2 = await page.evaluate(async () => {
    const menu = document.getElementById('menu');
    const tx = el => {
      const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform);
      return m ? parseFloat(m[1].split(',')[4]) : 0;
    };
    const old = menu.querySelector('.dshp-slider');
    const oldX = tx(old.querySelector('.dshp-sliderKnob'));
    old.remove();
    const s3 = window.__installSlider(menu);
    if (!s3) throw new Error('二次重装失败');
    const travel = parseFloat(s3.style.getPropertyValue('--dshp-travel'));
    const firstX = parseFloat(s3.style.getPropertyValue('--dshp-x'));
    const samples = [];
    for (let i = 0; i < 30; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const k = s3.querySelector('.dshp-sliderKnob');
      if (k) samples.push(tx(k));
    }
    return {
      travel, oldX, firstX,
      last: samples[samples.length - 1],
      sx: parseFloat(s3.style.getPropertyValue('--dshp-sx')),
      dur: s3.style.getPropertyValue('--dshp-dur'),
      count: menu.querySelectorAll('.dshp-slider').length,
    };
  });
  check('★ 前提：第二次摘除时确实在 2/3→满程的半途',
    f2.oldX > f2.travel * (2 / 3) + 3 && f2.oldX < f2.travel - 3,
    `oldX=${fmt(f2.oldX)} travel=${fmt(f2.travel)}`);
  check('★ 连续两次重建仍接得上：第一帧落在半途带内',
    f2.firstX > f2.travel * (2 / 3 + 0.08) && f2.firstX < f2.travel * (1 - 0.08),
    `firstX=${fmt(f2.firstX)} travel=${fmt(f2.travel)} oldX=${fmt(f2.oldX)}`);
  check('★ 二次交接落到 Max 且填色铺满（补完段时长不越接越慢）',
    Math.abs(f2.last - f2.travel) <= 1.5 && f2.sx === 1,
    `last=${fmt(f2.last)} travel=${fmt(f2.travel)} sx=${f2.sx}`);
  check('★ 二次交接后临时时长同样收回、不叠影',
    f2.dur === '' && f2.count === 1, `dur=${f2.dur} count=${f2.count}`);
  await page.close();
}

await browser.close();
console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过：滑杆拖动预览、松手提交、半途重建动画接得上，且没碰别的菜单');
process.exit(failures ? 1 : 0);

