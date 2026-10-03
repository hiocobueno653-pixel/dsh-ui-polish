/**
 * 回归验证（本轮新增）：
 *   A. 自触发扫描循环 —— enhanceModelMenu 每轮写 DOM → 主 observer → 再扫描 → 不停
 *   B. 换模型后触发器名称不更新 —— 旧实现把原文案缓存进 dataset，永不刷新
 *   C. 无档位/有档位两条流转仍然正确
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
/* installMenus 内部的三层缩进变量（沙箱里补桩，否则抽出来的函数引用不到）。 */
const SANDBOX_PRELUDE = [
  'var mo = null;',
  'var nudgeTimer = null;',
  'var watchTimer = null;',
  'var watchMiss = 0;',
].join('\n');
const ALL_FUNCS_SRC = (() => {
  const names = [...source.matchAll(/^\t\tfunction ([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]);
  /* installMenus 内部的 scan/scanBurst 等是三层缩进，上面抓不到，
     这里单独补进来 —— 少了它们就测不到"自触发扫描循环"这条（用户反馈的卡死）。 */
  const nested = ['scan', 'scanBurst', 'arm', 'attachMo', 'nudge', 'stopNudge', 'startWatch', 'stopWatch'];
  return names.concat(nested).map(n => grabFunction(n)).join('\n');
})();
const SRC = CONSTS_SRC + '\n' + SANDBOX_PRELUDE + '\n' + ALL_FUNCS_SRC + '\n';
const defaultsSrc = (/var DEFAULTS = \{[\s\S]*?\};/.exec(source) || [''])[0];
const cssText = new Function(defaultsSrc + '\n' + grabFunction('readConfig') + '\n' + grabFunction('buildCss') + '\nreturn buildCss(readConfig({}));')();
const CHROME = process.env.DSHP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME });
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' - ' + detail));
  if (!ok) failures++;
};

const SHELL = (extraCss = '') => `<!doctype html><html><head><style>${cssText}
  :root{--dsw-alias-state-business-primary:#3b82f6;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#ececf0;}
  body{margin:24px;font:14px system-ui}
  [role='menuitemradio'],[role='menuitem']{display:flex;width:220px;padding:8px 10px;border:0;background:none;border-radius:8px;cursor:pointer;font:inherit;text-align:left}
  ${extraCss}</style></head><body>
  <div data-slot="conversation.input.model"><button title="DeepSeek-V41-Flash · High">
    <span class="_triggerLabel_">DeepSeek-V41-Flash</span><span class="_triggerEffort_">High</span></button></div>
  <div id="host"></div></body></html>`;

console.log('A. 自触发扫描循环会被抑制');
{
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.setContent(SHELL());
  /* 完整复现真机链条：observer 看到菜单内变动 → scanBurst → scan → enhanceModelMenu
     → 写 DOM → observer 又看到 …… 修复前这里会无限增殖。 */
  const res = await page.evaluate(async src => {
    const lib = new Function(src + `
      var __scanCount = 0;
      /* 直接复用插件自己的 scan()（它带 selfScanning 保护），
         只在外面套一层计数，不改行为。 */
      var __realScan = scan;
      function __countingScan() { __scanCount++; return __realScan(); }
      return {
        enhanceModelMenu: enhanceModelMenu, relabelTrigger: relabelTrigger,
        touches: mutationTouchesMenu, scan: __countingScan,
        scans: function () { return __scanCount; },
        arm: function () { userInteracted = true; }
      };
    `)();
    lib.arm();
    const host = document.getElementById('host');
    /* 档位行照宿主真实结构带 ModelSelect 的类名（optionCopy/modelName）：
       插件现在要求"确认是模型选单"才动手，夹具没有这些标记就测不到真实行为。 */
    host.innerHTML = '<div role="menu">' + ['Off','Low','High','Max'].map((l,i) =>
      '<button role="menuitemradio" aria-checked="' + (i===2) +
      '"><span class="optionCopy"><span class="modelName">' + l + '</span></span></button>').join('') + '</div>';
    const menu = host.firstElementChild;
    /* 与真机同款 observer：碰到菜单就再扫一轮 */
    const mo = new MutationObserver((records) => {
      for (const rec of records) if (lib.touches(rec)) { lib.scan(); break; }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    /* 先单独跑一次，看 enhanceModelMenu 到底有没有写 DOM */
    lib.enhanceModelMenu(menu);
    const probe = {
      head: !!menu.querySelector('.dshp-head'),
      slider: !!menu.querySelector('.dshp-slider'),
      levelPage: menu.classList.contains('dshp-levelPage')
    };
    lib.scan();                       /* 起始那一轮 */
    await new Promise(r => setTimeout(r, 1500));
    mo.disconnect();
    return { scans: lib.scans(), probe: probe };
  }, SRC);
  /* 有界 = 没被自触发拖死。真机上前几版这里会飙到几千上万轮。 */
  check('前置：enhanceModelMenu 确实写了 DOM', res.probe.head && res.probe.levelPage, JSON.stringify(res.probe));
  check('★ 扫描次数有界（无自触发增殖）', res.scans <= 60, 'scans=' + res.scans);
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close();
}
console.log('B. 换模型后触发器名称跟着变');
{
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.setContent(SHELL());
  const res = await page.evaluate(src => {
    const lib = new Function(src + 'return { relabelTrigger: relabelTrigger };')();
    const btn = document.querySelector("[data-slot='conversation.input.model'] button");
    const lab = btn.querySelector("[class*='triggerLabel']");
    const eff = btn.querySelector("[class*='triggerEffort']");
    const before = lab.textContent;
    /* 模拟在列表里选了另一个模型：宿主改了 title 并重渲染文案 */
    btn.setAttribute('title', 'hy3-WorkBuddy · Max');
    lab.textContent = 'hy3-WorkBuddy';
    eff.textContent = 'Max';
    lib.relabelTrigger();
    const afterLabel = lab.textContent;
    const afterEff = eff.textContent;
    /* 再模拟滑杆页 → 收起，验证两个方向都正确 */
    document.getElementById('host').innerHTML =
      '<div role="menu">' + ['Off','Low','High','Max'].map((l,i) =>
        '<button role="menuitemradio" aria-checked="' + (i===2) + '">' + l + '</button>').join('') + '</div>';
    const menu = document.getElementById('host').firstElementChild;
    menu.classList.add('dshp-levelPage');
    lib.relabelTrigger();
    const onLevel = lab.textContent;
    menu.classList.remove('dshp-levelPage');
    lib.relabelTrigger();
    return { before: before, afterLabel: afterLabel, afterEff: afterEff,
             onLevel: onLevel, backLabel: lab.textContent, backEff: eff.textContent };
  }, SRC);
  check('初始是原模型名', res.before === 'DeepSeek-V41-Flash', String(res.before));
  check('★ 换模型后名称更新', res.afterLabel === 'hy3-WorkBuddy', String(res.afterLabel));
  check('★ 换模型后档位更新', res.afterEff === 'Max', String(res.afterEff));
  check('滑杆页显示「选择强度」', res.onLevel === '选择强度', String(res.onLevel));
  check('★ 收起后是新模型名（不是旧的）', res.backLabel === 'hy3-WorkBuddy', String(res.backLabel));
  check('收起后是新档位名', res.backEff === 'Max', String(res.backEff));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close();
}

console.log('C. 收起后文字不塌陷（宽度正常）');
{
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(SHELL());
  const res = await page.evaluate(src => {
    const lib = new Function(src + 'return { relabelTrigger: relabelTrigger };')();
    lib.relabelTrigger();
    const lab = document.querySelector("[class*='triggerLabel']");
    const r = lab.getBoundingClientRect();
    const cs = getComputedStyle(lab);
    return { w: r.width, h: r.height, writingMode: cs.writingMode, transform: cs.transform,
             display: cs.display, whiteSpace: cs.whiteSpace };
  }, SRC);
  /* 截图里的症状：文字被压成竖条 → 宽度远小于内容、writing-mode 被改 */
  check('★ 标签宽度正常（未塌陷）', res.w > 40, 'width=' + Math.round(res.w) + 'px');
  check('高度正常', res.h > 4 && res.h < 60, 'h=' + Math.round(res.h));
  check('writing-mode 未被改', res.writingMode === 'horizontal-tb', res.writingMode);
  check('无 transform 挤压', res.transform === 'none' || res.transform === 'matrix(1, 0, 0, 1, 0, 0)', res.transform);
  await page.close();
}

await browser.close();
console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
process.exit(failures === 0 ? 0 : 1);

