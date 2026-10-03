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
  await page.setContent(`<!doctype html><html><head><style>${cssText}
    :root{--dsw-alias-state-business-primary:#3b82f6;--dsw-alias-bg-layer-2:#ececf0;--dsw-alias-bg-layer-1:#fff;}
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
    const x = parseFloat(s.style.getPropertyValue('--dshp-x')) || 0;
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
  /* 填色盖到滑钮**右缘**（不是圆心）：盖到圆心时滑钮右半边压在空轨道上，
     最右档看着就是"右边没填满"（用户反馈）。 */
  check('填充右缘与滑钮右缘对齐', Math.abs(geo.fillRight - geo.knobRight) < 1.5, `${geo.fillRight.toFixed(1)} vs ${geo.knobRight.toFixed(1)}`);
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

await browser.close();
console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过：滑杆拖动预览、松手提交，且没碰别的菜单');
process.exit(failures ? 1 : 0);

