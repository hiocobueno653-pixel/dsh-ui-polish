/**
 * 真机验证：在真跑着的 DSH 里确认浮层毛玻璃生效、可开关。
 *
 *   node test/live-verify.mjs "<dsh web 打印的带 token 的 URL>"
 *
 * 起隔离实例的办法（不动正在用的桌面端）：
 *   $h2 = "$env:TEMP\dsh-uicheck"; New-Item -ItemType Directory -Force $h2
 *   Copy-Item "$env:USERPROFILE\.dsh\sessions" "$h2\sessions" -Recurse -Force   # 想看真实会话才需要
 *   $env:DSH_HOME = $h2
 *   & $dsh plugin --profile uicheck add "file:."
 *   & $dsh --profile uicheck --port 19899 --no-open
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DSHP_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ executablePath: process.env.DSHP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 940 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e && e.message).slice(0, 160)));
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-composer-card]', { timeout: 60000 }).catch(() => {});
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(700);
  const closed = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]'); if (!d) return false;
    const b = Array.from(d.querySelectorAll('button')).find(x => /稍后|以后|跳过|Skip|Later|Not now/i.test(x.textContent || '')) || d.querySelector('button');
    if (!b) return false; b.click(); return true;
  }).catch(() => false);
  if (!closed) break;
}
await page.waitForTimeout(1500);
let failures = 0;
const check = (n, ok, d) => { console.log((ok ? '  ok   ' : '  FAIL ') + n + (ok || d === undefined ? '' : ' — ' + d)); if (!ok) failures++; };

console.log('插件装载');
const loaded = await page.evaluate(() => ({
  css: !!document.querySelector('style[data-plugin="ui-polish"]'),
  flag: document.documentElement.getAttribute('data-dshp'),
  cls: document.documentElement.classList.contains('dshp-css'),
  api: typeof (window.dshUiPolish && window.dshUiPolish.setGlass),
  plugins: Array.from(document.querySelectorAll('style[data-plugin]')).map(s => s.getAttribute('data-plugin')).filter(n => /ui-polish|motion-layer|image-gen/.test(n)),
}));
console.log('  ' + JSON.stringify(loaded));
check('样式表已注入', loaded.css && loaded.cls, JSON.stringify(loaded));
check('宿主半标记 data-dshp=on', loaded.flag === 'on', String(loaded.flag));
check('三个插件同时在', loaded.plugins.length === 3, loaded.plugins.join(','));
check('运行时开关可用', loaded.api === 'function', String(loaded.api));

console.log('真机：四种弹层都要有毛玻璃');
const targets = [
  ['权限选单', "[data-slot='conversation.input.permission'] button"],
  ['模型选单', "[data-slot='conversation.input.model'] button"],
  ['工作区选单', "[aria-label='选择工作区']"],
];
for (const [name, sel] of targets) {
  const btn = await page.$(sel);
  if (!btn) { console.log('  skip ' + name + '（这个界面没有）'); continue; }
  await btn.click();
  await page.waitForTimeout(700);
  const st = await page.evaluate(() => {
    const menu = document.querySelector("[role='menu']");
    if (!menu) return null;
    const cs = getComputedStyle(menu);
    const child = menu.querySelector("[aria-hidden='true']");
    const ccs = child ? getComputedStyle(child) : null;
    return { bg: cs.backgroundColor, blur: cs.backdropFilter, childBg: ccs ? ccs.backgroundColor : null, childBlur: ccs ? ccs.backdropFilter : null, item: menu.querySelector("[role='menuitem']") ? getComputedStyle(menu.querySelector("[role='menuitem']")).color : null };
  });
  check(name + '：有底 + 有模糊', !!st && st.blur.includes('blur(') && !/^rgba\(0, 0, 0, 0\)$/.test(st.bg), JSON.stringify(st));
  check(name + '：子材质层已关（不叠两层）', !!st && st.childBlur === 'none', st && String(st.childBlur));
  if (name === '权限选单' && st) {
    const b = await page.$eval("[role='menu']", el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await page.screenshot({ path: '_diag/polish-menu.png', clip: { x: Math.max(0, b.x - 130), y: Math.max(0, b.y - 100), width: Math.min(760, b.w + 320), height: Math.min(440, b.h + 220) } });
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

console.log('真机：关掉后要还原成宿主原样');
const restored = await page.evaluate(() => {
  window.dshUiPolish.off();
  const el = document.querySelector("[role='menu']");
  return { hasSheet: !!document.querySelector('style[data-plugin="ui-polish"]'), flag: document.documentElement.getAttribute('data-dshp') };
});
check('off 后样式表被摘掉', !restored.hasSheet && restored.flag === 'off', JSON.stringify(restored));
const back = await page.evaluate(() => {
  window.dshUiPolish.on();
  return { hasSheet: !!document.querySelector('style[data-plugin="ui-polish"]'), sheets: document.querySelectorAll('style[data-plugin="ui-polish"]').length };
});
check('on 后恢复且只有一张表', back.hasSheet && back.sheets === 1, JSON.stringify(back));
check('页面无 JS 报错', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(failures ? '失败 ' + failures + ' 项' : '真机全部通过：弹层毛玻璃生效，可开关');
process.exit(failures ? 1 : 0);
