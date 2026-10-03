/**
 * 真浏览器验证：宿主浮层的毛玻璃材质。
 *
 * 必须在真引擎里跑：color-mix / backdrop-filter / @supports / 伪元素都在
 * 「计算值」这一层才有答案，jsdom 一个都算不出来。
 *
 * 测三件事：
 *   1) 有材质的浮层真的画出了底、且带模糊（不是透明）
 *   2) 没声明材质的浮层、对话框，一律不碰（不制造回归）
 *   3) 降级路径齐全：不支持 backdrop-filter / 减少透明 / 强制配色
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DSHP_PLAYWRIGHT || 'playwright');

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/* 把工厂里的两个纯函数抠出来直接求值：测的就是插件真正会注入的东西。 */
function grabFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到 ' + name);
  let depth = 0, i = source.indexOf('{', start);
  const from = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}
/* DEFAULTS 是被这两个函数引用的常量，一起抠出来 */
const defaultsSrc = (/var DEFAULTS = \{[\s\S]*?\};/.exec(source) || [''])[0];
if (!defaultsSrc) throw new Error('找不到 DEFAULTS');
const factory = body => new Function(defaultsSrc + '\n' + grabFunction('readConfig') + '\n' + grabFunction('buildCss') + '\n' + body);
const cssText = factory('return buildCss(readConfig({ config: { enabled: true, glass: true, tintAlpha: 0.76, blurPx: 40 } }));')();

const CHROME = process.env.DSHP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME });

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};

/* 仿真宿主：一个带材质的菜单、一个不带材质的、一个对话框 */
const DOM = `
<div role="menu" id="glassMenu" data-menu-material="translucent">
  <div aria-hidden="true" id="brokenMaterial" class="material"></div>
  <div role="menuitem">仅可查看</div>
</div>
<div role="menu" id="plainMenu"><div role="menuitem">普通菜单</div></div>
<div role="dialog" aria-modal="true" id="dlg"><div>设置</div></div>`;

async function mount(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.emulateMedia({ reducedMotion: opts.reduced ? 'reduce' : 'no-preference', forcedColors: opts.forcedColors ? 'active' : 'none' });
  /* 主题变量：浅色一套，深色一套（模拟宿主切主题） */
  const theme = opts.dark
    ? ':root{--dsw-alias-bg-layer-1:#232326;}'
    : ':root{--dsw-alias-bg-layer-1:#ffffff;}';
  await page.setContent(`<!doctype html><html><head><style>
    ${theme}
    body{margin:0;background:${opts.dark ? '#151517' : '#ffffff'}}
    #glassMenu,#plainMenu,#dlg{width:200px;height:80px;padding:6px}
    /* 忠实仿真宿主：材质层是**类**选择器（._material_..），不是 id——
       用 id 写会把特异性抬到比插件规则还高，测出来的是假绿。 */
    .material{position:absolute;inset:0;z-index:-1;background:rgba(248,249,250,.58);backdrop-filter:blur(40px) saturate(1.5)}
    #plainMenu,#dlg{background:rgba(0,0,0,0)}
  </style><style id="polish">${cssText}</style></head><body>${DOM}</body></html>`);
  return page;
}

console.log('有材质的浮层：真的画出了底 + 模糊');
{
  const page = await mount();
  /* color-mix() 出来的计算值是 `color(srgb r g b / a)`，不是 rgba()——
     两种都要认得，否则测出来的是 null。 */
  const alphaOf = css => {
    const legacy = /rgba?\(([^)]+)\)/.exec(css);
    if (legacy) {
      const parts = legacy[1].split(',').map(s => Number(s.trim()));
      return parts.length === 4 ? parts[3] : 1;
    }
    const modern = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)\)/.exec(css);
    if (modern) return Number(modern[4]);
    return null;
  };
  const m = await page.$eval('#glassMenu', el => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, blur: cs.backdropFilter };
  });
  const alpha = alphaOf(m.bg);
  check('浮层有底色（不再透明）', alpha !== null && alpha > 0.4, String(alpha) + ' ← ' + m.bg);
  check('浮层带背景模糊', /blur\(40px\)/.test(m.blur), m.blur);
  check('-webkit- 前缀也写了（WebKit 内核）', cssText.includes('-webkit-backdrop-filter:blur(40px)'), '');

  const child = await page.$eval('#brokenMaterial', el => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, blur: cs.backdropFilter };
  });
  check('失效的子材质层被关掉（不叠两层）', child.bg === 'rgba(0, 0, 0, 0)' && child.blur === 'none', JSON.stringify(child));
  await page.close();
}

console.log('深色主题：跟随宿主的主题变量');
{
  const page = await mount({ dark: true });
  const bg = await page.$eval('#glassMenu', el => getComputedStyle(el).backgroundColor);
  const nums = (/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(bg) || []).slice(1, 4).map(Number);
  check('深色主题下底色是暗的（不是白板）', nums.length === 3 && nums.every(n => n < 0.35), bg);
  await page.close();
}

console.log('不误伤：没声明材质的浮层 / 对话框一律不碰');
{
  const page = await mount();
  const plain = await page.$eval('#plainMenu', el => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, blur: cs.backdropFilter };
  });
  check('普通菜单保持原样（透明 → 仍透明）', plain.bg === 'rgba(0, 0, 0, 0)' && plain.blur === 'none', JSON.stringify(plain));
  const dlg = await page.$eval('#dlg', el => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, blur: cs.backdropFilter };
  });
  check('对话框保持原样（宿主自己画了实底，别去搅和）', dlg.bg === 'rgba(0, 0, 0, 0)' && dlg.blur === 'none', JSON.stringify(dlg));
  await page.close();
}

console.log('降级路径');
{
  const page = await mount({ forcedColors: true });
  const m = await page.$eval('#glassMenu', el => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, blur: cs.backdropFilter };
  });
  check('强制配色下不自己画材质（交给系统配色）', m.blur === 'none', JSON.stringify(m));
  await page.close();
  check('样式里带 @supports 兜底（不支持模糊时把底加厚）', cssText.includes('@supports not ((backdrop-filter:blur(1px))'), '');
  check('样式里带 prefers-reduced-transparency 兜底', cssText.includes('prefers-reduced-transparency'), '');
  check('样式里带 forced-colors 兜底', cssText.includes('forced-colors:active'), '');
}

console.log('配置真的生效');
{
  const custom = factory('return buildCss(readConfig({ config: { tintAlpha: 0.5, blurPx: 12 } }));')();
  check('tintAlpha 生效', custom.includes('50%,transparent'), (custom.match(/bg-layer-1,#fff\) [^,]+/) || [''])[0]);
  check('blurPx 生效', custom.includes('blur(12px)'), (custom.match(/blur\(\d+px\)/) || [''])[0]);
  const guard = factory('return JSON.stringify(readConfig({ config: { tintAlpha: 5, blurPx: -3 } }));')();
  const parsed = JSON.parse(guard);
  check('越界的配置被挡掉（回到默认）', parsed.tintAlpha === 0.76 && parsed.blurPx === 40, guard);
  const empty = factory('return JSON.stringify(readConfig(undefined));')();
  check('读不到配置不报错、用默认值', JSON.parse(empty).tintAlpha === 0.76, empty);
}

await browser.close();
console.log('');
console.log(failures ? '失败 ' + failures + ' 项' : '全部通过：浮层有了真正的毛玻璃，且没碰不该碰的地方');
process.exit(failures ? 1 : 0);
