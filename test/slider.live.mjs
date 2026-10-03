import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DSHP_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ executablePath: process.env.DSHP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 940 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e && e.message).slice(0, 140)));
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
const openReasoning = async () => {
  await page.click("[data-slot='conversation.input.model'] button");
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll("[role='menuitem']")).find(b => /推理等级/.test(b.textContent || ''));
    if (row) row.click();
  });
  await page.waitForTimeout(700);
};
const levelOf = () => page.evaluate(() => {
  const btn = document.querySelector("[data-slot='conversation.input.model'] button");
  const m = /推理等级\s*(\S+)/.exec(btn ? btn.getAttribute('aria-label') || '' : '');
  return m ? m[1] : '(unknown)';
});

console.log('真机：模型选单里长出滑杆');
const startLevel = await levelOf();
console.log('  当前等级: ' + startLevel);
await openReasoning();
const info = await page.evaluate(() => {
  const s = document.querySelector('.dshp-slider');
  const radios = Array.from(document.querySelectorAll("[role='menuitemradio']"));
  return {
    exists: !!s,
    now: s && s.getAttribute('aria-valuenow'),
    text: s && s.getAttribute('aria-valuetext'),
    dots: s ? s.querySelectorAll('.dshp-sliderDot').length : 0,
    labels: radios.map(r => (r.textContent || '').trim()),
    checked: radios.findIndex(r => r.getAttribute('aria-checked') === 'true'),
    beforeFirst: s && radios[0] ? s.nextElementSibling === radios[0] || s.compareDocumentPosition(radios[0]) & Node.DOCUMENT_POSITION_FOLLOWING : null,
  };
});
console.log('  ' + JSON.stringify(info));
check('推理等级页出现了滑杆', info.exists);
check('滑杆读数 = 宿主当前选中的那一档', info.now === String(info.checked) && info.text === info.labels[info.checked],
  `now=${info.now}/${info.text} checked=${info.checked}/${info.labels[info.checked]}`);
check('刻点数 = 等级数（不写死）', info.dots === info.labels.length, info.dots + ' vs ' + info.labels.length);
check('滑杆排在选项列表上方', info.beforeFirst === true, String(info.beforeFirst));

/* 拖到最左（Off）松手 → 真机上要真的生效 */
const box = await page.$eval('.dshp-sliderTrack', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.mouse.move(box.x + box.w * 0.8, box.y + box.h / 2);
await page.mouse.down();
await page.mouse.move(box.x + 1, box.y + box.h / 2, { steps: 8 });
const mid = await page.evaluate(() => ({
  menuOpen: !!document.querySelector("[role='menu']"),
  target: document.querySelector('[data-dshp-target]') ? document.querySelector('[data-dshp-target]').textContent.trim() : null,
  now: document.querySelector('.dshp-slider').getAttribute('aria-valuenow'),
}));
check('拖动中菜单没关、目标行被点亮', mid.menuOpen && mid.target === 'Off' && mid.now === '0', JSON.stringify(mid));
await page.screenshot({ path: '_diag/slider-drag.png', clip: { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 120), width: Math.min(420, box.w + 80), height: 300 } });
await page.mouse.up();
await page.waitForTimeout(1200);
const after = await levelOf();
check('松手后真的改成了 Off', after === 'Off', `之前 ${startLevel} → 现在 ${after}`);
check('菜单已关闭（宿主行为）', await page.evaluate(() => !document.querySelector("[role='menu']")), '');

/* 改回 High */
await openReasoning();
const box2 = await page.$eval('.dshp-sliderTrack', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.mouse.move(box2.x + box2.w * 0.665, box2.y + box2.h / 2);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(1200);
const restored = await levelOf();
check('再滑回去也能改（恢复 High）', restored === 'High', restored);
check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? '失败 ' + failures + ' 项' : '真机：推理等级滑杆可用，拖动预览 / 松手生效');
process.exit(failures ? 1 : 0);
