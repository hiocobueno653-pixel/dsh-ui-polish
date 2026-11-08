/**
 * 真浏览器验证：等级页不能被上下滚动。
 *
 * 用户反馈（截图）：滑杆右侧冒出滚动条，灰框和滑杆能被上下拖着走。
 * 参考实现里这一块是"钉死"的 —— 等级页内容只有「灰框 + 滑杆」，比面板矮得多，
 * 根本不该有滚动。
 *
 * 成因：宿主把选项行放在一层 `overflow:hidden auto` 的滚动容器里
 * （`MenuSurface > div.groups.scrollable > button[role=menuitemradio]`），
 * 我们的滑杆插在同一层；容器一旦比内容矮一点（窗口矮、宿主给的锚定高度小、
 * 宿主重渲染后量尺还没跟上），滚动条就出现，滑杆跟着被拖着上下移。
 *
 * 这一条用**真实滚动行为**断言（改 scrollTop 后再量滑杆位置），
 * 不是查 CSS 文本：选择器写对但被别的规则压掉，文本断言照样过。
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
const defaultsSrc = (/var DEFAULTS = \{[\s\S]*?\};/.exec(source) || [''])[0];
const cssText = new Function(defaultsSrc + '\n' + grabFunction('readConfig') + '\n' + grabFunction('buildCss') + '\nreturn buildCss(readConfig({}));')();

const CHROME = process.env.DSHP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME });
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};

/* 宿主样式照抄一份（MenuSurface / groups / 选项行），只保留与高度有关的几条：
   面板是 flex 列、有 max-height，选项行容器 min-height:0 + overflow:hidden auto。 */
const HOST_CSS = `
  [role='menu'].menu{
    box-sizing:border-box;display:flex;flex-direction:column;padding:4px;
    width:280px;max-height:var(--cap,900px);overflow:hidden;border:0;
  }
  .groups{min-height:0;overflow:hidden auto}
  [role='menuitemradio']{display:flex;min-height:34px;padding:5px 7px;border:0;background:none;font:inherit}
`;
const LEVELS = ['Default', 'Low', 'High', 'Max'];
const rows = LEVELS.map((l, i) =>
  `<button type="button" role="menuitemradio" aria-checked="${i === LEVELS.length - 1 ? 'true' : 'false'}">${l}</button>`).join('');

/* 滑杆 DOM：与 installSlider 产出一致（root > track > clip(fill,pclip) + dots + knob）。 */
const SLIDER_HTML = `
  <div class="dshp-slider" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="3">
    <div class="dshp-sliderTrack">
      <div class="dshp-sliderClip"><div class="dshp-sliderFill"></div></div>
      <div class="dshp-sliderDots"><span class="dshp-sliderDot"></span><span class="dshp-sliderDot"></span><span class="dshp-sliderDot"></span><span class="dshp-sliderDot"></span></div>
      <div class="dshp-sliderKnob"></div>
    </div>
  </div>`;

async function mount({ cap, levelPage, sliderIn } = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const head = `
    <div class="dshp-head" role="presentation">
      <div class="dshp-levelLabel">Max</div>
      <div class="dshp-modelRow"><span class="dshp-modelName">Deepseek-V4.1-Flash</span><span class="dshp-modelChevron">›</span></div>
    </div>`;
  const groupsInner = sliderIn === 'groups' ? SLIDER_HTML + rows : rows + SLIDER_HTML;
  await page.setContent(`<!doctype html><html><head><style>${HOST_CSS}${cssText}
    :root{--dsw-alias-state-business-primary:#3b82f6;--dsw-alias-bg-layer-2:#ececf0;--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#111114;--dsw-alias-label-secondary:#666}
    body{margin:0;font:14px system-ui}
  </style></head><body>
    <div role="menu" id="menu" class="menu" style="--cap:${cap}px">
      <div aria-hidden="true"></div>
      ${head}
      <div class="groups scrollable">${groupsInner}</div>
    </div>
  </body></html>`);
  if (levelPage) await page.evaluate(() => document.querySelector('#menu').classList.add('dshp-levelPage'));
  return page;
}

/* ① 核心：等级页把滑杆所在那层锁住，滚不动。 */
console.log('等级页：滑杆所在容器被锁住');
{
  /* cap 故意小于「灰框 + 滑杆」，制造"容器比内容矮"的真实溢出场景。 */
  const page = await mount({ cap: 70, levelPage: true, sliderIn: 'groups' });
  const r = await page.evaluate(() => {
    const groups = document.querySelector('.groups');
    const slider = document.querySelector('.dshp-slider');
    const before = slider.getBoundingClientRect().top;
    groups.scrollTop = 40;            /* 模拟滚轮/拖动滚动条 */
    const after = slider.getBoundingClientRect().top;
    return {
      overflowY: getComputedStyle(groups).overflowY,
      shrink: getComputedStyle(groups).flexShrink,
      clientHeight: groups.clientHeight,
      scrollTop: groups.scrollTop,
      moved: Math.abs(after - before),
      sliderH: slider.getBoundingClientRect().height,
    };
  });
  check('★ 这一层不是滚动容器（overflow-y 是 clip）', r.overflowY === 'clip', r.overflowY);
  check('★ 改 scrollTop 不动（滑杆不再上下移动）', r.scrollTop === 0 && r.moved < 1, JSON.stringify(r));
  check('★ 不会被 flex 压成 0 高（滑杆整条还在）', r.clientHeight >= 36 && r.sliderH >= 36, JSON.stringify(r));
  await page.close();
}

/* ①b 面板够高时（真机常态）：内容完整可见、且没有滚动条。 */
console.log('等级页：面板够高时完整可见');
{
  const page = await mount({ cap: 900, levelPage: true, sliderIn: 'groups' });
  const r = await page.evaluate(() => {
    const box = document.querySelector('#menu').getBoundingClientRect();
    const slider = document.querySelector('.dshp-slider').getBoundingClientRect();
    const head = document.querySelector('.dshp-head').getBoundingClientRect();
    return {
      overflowY: getComputedStyle(document.querySelector('.groups')).overflowY,
      insideBox: slider.bottom <= box.bottom + 0.5 && head.top >= box.top - 0.5,
      menuH: Math.round(box.height),
    };
  });
  check('没有滚动条（overflow-y 是 clip）', r.overflowY === 'clip', r.overflowY);
  check('灰框与滑杆都完整落在面板里', r.insideBox === true, JSON.stringify(r));
  await page.close();
}

/* ② 滑杆不参与 flex 收缩：容器再矮也不把轨道压扁。 */
console.log('滑杆不被压扁');
{
  const page = await mount({ cap: 70, levelPage: true, sliderIn: 'groups' });
  const r = await page.evaluate(() => {
    const s = document.querySelector('.dshp-slider');
    const t = document.querySelector('.dshp-sliderTrack');
    return { shrink: getComputedStyle(s).flexShrink, sliderH: s.getBoundingClientRect().height, trackH: t.getBoundingClientRect().height };
  });
  check('滑杆 flex-shrink 是 0', r.shrink === '0', r.shrink);
  check('轨道没被压扁（20px）', Math.abs(r.trackH - 20) < 1, JSON.stringify(r));
  await page.close();
}

/* ③ 模型列表页不受影响：列表自己该滚还滚。 */
console.log('模型列表页保持可滚');
{
  const page = await mount({ cap: 90, levelPage: false, sliderIn: 'groups' });
  const r = await page.evaluate(() => {
    const groups = document.querySelector('.groups');
    return { overflowY: getComputedStyle(groups).overflowY, overflowed: groups.scrollHeight > groups.clientHeight };
  });
  check('列表页仍是 overflow auto', r.overflowY === 'auto', r.overflowY);
  check('列表页仍可滚（有溢出时）', r.overflowed === true, JSON.stringify(r));
  await page.close();
}

await browser.close();
console.log('');
console.log(failures ? '失败 ' + failures + ' 项' : '全部通过：等级页钉死不滚，列表页仍然可滚');
process.exit(failures ? 1 : 0);
