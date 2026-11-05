/**
 * 真浏览器验证：等级页要把宿主原生的档位行藏起来。
 *
 * 为什么单独一条：宿主 2026-11 版把档位行包进了一层滚动容器
 *   MenuSurface[role=menu] > div.groups.scrollable > button[role=menuitemradio]
 * 而插件原来写的是直接子级选择器（.dshp-levelPage > [role=menuitemradio]），
 * 一条也匹配不上 —— 真机上滑杆下面那四行又露出来了（用户截图）。
 *
 * 这里用**计算样式**断言，不是查 CSS 文本：选择器写对了但被别的规则压掉，
 * 文本断言照样过，用户看到的仍是列表。
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

const LEVELS = ['Default', 'Low', 'High', 'Max'];
const rowsHtml = LEVELS.map((l, i) =>
  `<button type="button" role="menuitemradio" aria-checked="${i === LEVELS.length - 1 ? 'true' : 'false'}"><span>${l}</span></button>`).join('');

async function mount(html) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(`<!doctype html><html><head><style>${cssText}
    :root{--dsw-alias-state-business-primary:#3b82f6;--dsw-alias-bg-layer-2:#ececf0;--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#111114}
    body{margin:24px;font:14px system-ui}
    [role='menu']{display:flex;flex-direction:column;width:240px;padding:4px}
    .groups{overflow:hidden auto}
    [role='menuitemradio']{display:flex;min-height:34px;padding:5px 7px;border:0;background:none;font:inherit;text-align:left}
  </style></head><body>${html}</body></html>`);
  return page;
}

/* ① 宿主 2026-11 结构：档位行在 .groups 里，不再是 MenuSurface 的直接子级。 */
console.log('新宿主结构（档位行包在 .groups 里）');
{
  const page = await mount(`
    <div role="menu" id="menu">
      <div aria-hidden="true" class="material"></div>
      <div class="groups scrollable">${rowsHtml}</div>
    </div>`);
  await page.evaluate(() => document.querySelector('#menu').classList.add('dshp-levelPage'));
  const state = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[role='menuitemradio']")];
    return {
      displays: rows.map(r => getComputedStyle(r).display),
      groupsDisplay: getComputedStyle(document.querySelector('.groups')).display,
    };
  });
  check('★ 四行档位全部不可见', state.displays.every(d => d === 'none'), JSON.stringify(state.displays));
  check('滚动容器本身没被藏掉（滑杆就插在里面）', state.groupsDisplay !== 'none', state.groupsDisplay);
  await page.close();
}

/* ② 老宿主结构：档位行是直接子级 —— 兼容路径不能回归。 */
console.log('老宿主结构（档位行是直接子级）');
{
  const page = await mount(`<div role="menu" id="menu">${rowsHtml}</div>`);
  await page.evaluate(() => document.querySelector('#menu').classList.add('dshp-levelPage'));
  const displays = await page.evaluate(() =>
    [...document.querySelectorAll("[role='menuitemradio']")].map(r => getComputedStyle(r).display));
  check('老结构下四行也全部不可见', displays.every(d => d === 'none'), JSON.stringify(displays));
  await page.close();
}

/* ③ 模型列表页（外层 role=group、内层 role=menu、不带 .dshp-levelPage）：
      放宽到后代选择器后，绝不能把模型列表也藏掉。 */
console.log('模型列表页不受影响');
{
  const page = await mount(`
    <div role="group" id="shell">
      <div role="menu" id="list" class="groups">${rowsHtml}</div>
    </div>`);
  const displays = await page.evaluate(() =>
    [...document.querySelectorAll("[role='menuitemradio']")].map(r => getComputedStyle(r).display));
  check('模型列表的行仍然可见', displays.every(d => d !== 'none'), JSON.stringify(displays));
  await page.close();
}

await browser.close();
console.log('');
console.log(failures ? '失败 ' + failures + ' 项' : '全部通过：等级页只剩滑杆，列表页不受影响');
process.exit(failures ? 1 : 0);
