/**
 * 回归验证：填色特效（config: fx）。
 *
 * 守的四件事：
 *   A. 流动粒子**只沿水平方向**：关键帧里没有任何纵向位移，终点贴着填色右端；
 *   B. 绽放只在「拖进最高档」那一刻播**一次**（不是循环），且带着 MC 颜色状态；
 *   C. 滑钮自己的动效不能碰 transform —— 位移仍归 CSS 过渡管，否则拖动会瞬移
 *      （之前反复修过）；
 *   D. 光标：平时箭头，按住/拖动变成抓握拳头。
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
const buildCssFn = new Function(defaultsSrc + '\n' + grabFunction('readConfig') + '\n' +
  grabFunction('buildCss') + '\nreturn buildCss;')();
const readConfigFn = new Function(defaultsSrc + '\n' + grabFunction('readConfig') + '\nreturn readConfig;')();

const CHROME = process.env.DSHP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME });
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' - ' + detail));
  if (!ok) failures++;
};

const LEVELS = ['Off', 'Low', 'High', 'Max'];
/* 桌面端同一个 _mods 字典会被连续 mount 复用，样式表是同一份；
   夹具刻意不塞 <style>，避免 concerns 假阳性。 */
/* ⚠️ 夹具不塞 <style>：样式必须来自插件 ensure() 注入的那一份，
   否则 setFx 只更新了插件那份，夹具那份还在生效，测出假阳性（真机只有一份）。 */
const SHELL = `<!doctype html><html><head><style>
  :root{--dsw-alias-state-business-primary:#3b82f6;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#ececf0;}
  body{margin:24px;font:14px system-ui}
  [role='menuitemradio']{display:flex;width:220px;padding:8px 10px;border:0;background:none;border-radius:8px;cursor:pointer;font:inherit;text-align:left}
  </style></head><body>
  <div data-slot="conversation.input.model"><button title="M · High"><span class="_triggerLabel_">M</span><span class="_triggerEffort_">High</span></button></div>
  <div id="host"></div></body></html>`;

async function mount(opts = {}) {
  const levels = opts.levels || LEVELS;
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 },
    reducedMotion: opts.reducedMotion });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 160)));
  await page.setContent(SHELL);
  await page.evaluate(src => {
    window.__ModuleLoader__ = { _mods: {}, load(m) { this._mods[m.id] = m; } };
    (0, eval)(src);
  }, source);
  await page.evaluate(cfg => {
    window.__ModuleLoader__._mods['dsh-ui-polish'].factory().apply({ config: cfg });
  }, Object.assign({ enabled: true, glass: true, slider: true }, opts.config || {}));
  await page.evaluate(({ levels, current }) => {
    const host = document.getElementById('host');
    host.innerHTML = '<div role="menu">' + levels.map((l, i) =>
      '<button type="button" role="menuitemradio" aria-checked="' + (i === current) +
      '"><span class="optionCopy"><span class="modelName">' + l + '</span></span></button>').join('') + '</div>';
    window.dshUiPolish.enhanceMenu(host.firstElementChild);
  }, { levels: levels, current: opts.current === undefined ? 1 : opts.current });
  await page.waitForTimeout(600);
  return { page, ctx, errors };
}

console.log('A. 流动粒子：只沿水平方向，贴在填色里');
{
  const { page, ctx, errors } = await mount({ current: 1 });
  const info = await page.evaluate(() => {
    const pclip = document.querySelector('.dshp-pclip');
    const ps = Array.from(document.querySelectorAll('.dshp-p'));
    const cs = ps.length ? getComputedStyle(ps[0]) : null;
    /* keyframes 规则可能带供应商前缀（-webkit-），按前缀无关的方式找 dshpFlow */
    let kf = null;
    for (const st of Array.from(document.styleSheets)) {
      let rules; try { rules = st.cssRules; } catch (e) { continue; }
      for (const r of Array.from(rules || [])) {
        if (!r || typeof r.name !== 'string') continue;
        const nm = r.name.replace(/^-(webkit|moz|ms)-/i, '');
        if (nm !== 'dshpFlow') continue;
        kf = Array.from(r.cssRules || []).map(kr => {
          const st2 = kr.style || {}; const props = [];
          for (let i = 0; i < st2.length; i++) props.push(st2[i]);
          return { key: kr.keyText, props, transform: st2.transform };
        });
      }
    }
    return {
      count: ps.length,
      overflow: pclip ? getComputedStyle(pclip).overflow : 'none',
      topVarying: new Set(ps.map(p => getComputedStyle(p).top)).size,
      fillW: pclip ? pclip.getBoundingClientRect().width : 0,
      /* 轨道只有 20px 高，百分比换算成 px 会被四舍五入 —— 直接比较内联值更可靠 */
      rawTops: Array.from(new Set(ps.map(p2 => p2.style.getPropertyValue('--y')))),
      firstAnim: cs ? cs.animationName : null,
      iterations: cs ? cs.animationIterationCount : null,
      kf,
    };
  });
  console.log('  ' + JSON.stringify({ count: info.count, overflow: info.overflow, topVarying: info.topVarying, iter: info.iterations }));
  check('★ 填色里有多个流动小点', info.count >= 6, 'count=' + info.count);
  check('★ 小点被裁剪在填色盒子里（overflow:hidden）', info.overflow === 'hidden', info.overflow);
  check('★ 小点纵向位置铺开（不是排成一列）', info.rawTops.length >= 4, 'distinct --y=' + info.rawTops.length);
  check('★ 关键帧只声明 transform 与 opacity（纯合成）',
    !!info.kf && info.kf.every(k => k.props.every(p => p === 'transform' || p === 'opacity')),
    JSON.stringify(info.kf && info.kf.map(k => k.props)));
  /* 关键帧里每一步的 translate 第二分量必须为 0 —— 即完全没有纵向运动。
     只看带位移的关键帧（0% 那步只有平地 git�় translate3d(0px,0px,0px)，同样合法）。 */
  const ys = (info.kf || []).filter(k => k.transform).map(k => k.transform);
  /* ⚠️ translate3d(X,Y,Z) 的 X 可能是 calc(var(...) * .2)，里面自带逗号 ——
     必须先把嵌套的 calc()/var() 整体当成一段，再取第二个顶层分量来判断 Y。 */
  const splitTop = (expr) => {
    const inner = expr.slice(expr.indexOf('(') + 1, expr.lastIndexOf(')'));
    const parts = []; let depth = 0, cur = '';
    for (const ch of inner) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur);
    return parts.map(v => v.trim());
  };
  const hasY = ys.some(tr => {
    const t3 = (tr || '').replace(/scale\([^)]*\)/g, '').trim();
    if (!t3.startsWith('translate3d(')) return false;
    const parts = splitTop(t3);
    if (parts.length < 2) return false;
    const yv = parts[1].replace(/px$/, '');
    if (/^calc\(/.test(yv) || /var\(/.test(yv)) return true;   /* Y 里含计算式 = 有可能纵向动 */
    return parseFloat(yv) !== 0;      /* Y 不为 0 = 会从上/下钻出来 */
  });
  check('★ 关键帧没有任何纵向位移（只左右走，不会从上下进出）', !hasY, JSON.stringify(ys));
  check('★ 终点位移 = 恒定的 --dshp-trackW（不随拖动时的填色变化）',
    ys.some(tr => tr && tr.includes('--dshp-trackW')) &&
    !ys.some(tr => tr && tr.includes('--dshp-fillW')), JSON.stringify(ys));
  const tip = await page.evaluate(() => {
    const t = document.querySelector('.dshp-sliderTrack').getBoundingClientRect();
    const f = document.querySelector('.dshp-sliderFill').getBoundingClientRect();
    const k = document.querySelector('.dshp-sliderKnob').getBoundingClientRect();
    return { fillRight: f.right, knobRight: k.right, knobCenter: k.left + k.width / 2, trackRight: t.right };
  });
  check('★ 粒子可见范围（=填色）右端落在滑钮圆心、不越出轨道',
    Math.abs(tip.fillRight - tip.knobCenter) < 1.5 && tip.fillRight <= tip.trackRight + 0.6, JSON.stringify(tip));
  /* 亮度层次：--o 分三档，才不会整条轨道九个点一样亮 */
  const tone = await page.evaluate(() => {
    const ps = Array.from(document.querySelectorAll('.dshp-p'));
    const os = Array.from(new Set(ps.map(p => p.style.getPropertyValue('--o')))).sort();
    return { os, count: ps.length };
  });
  console.log('  ' + JSON.stringify(tone));
  check('★ 粒子有明暗层次（三档 --o，不是九个一样的白点）',
    tone.os.length === 3 && tone.os.every(v => parseFloat(v) > 0 && parseFloat(v) <= 1), JSON.stringify(tone));
  /* 淡入要到 20%、尾段留 15%：缺少任一段就会有"啪一下出现/消失"的观感 */
  const curve = await page.evaluate(() => {
    for (const st of Array.from(document.styleSheets)) {
      let rules; try { rules = st.cssRules; } catch (e) { continue; }
      for (const r of Array.from(rules || [])) {
        if (!r || typeof r.name !== 'string') continue;
        if (r.name.replace(/^-(webkit|moz|ms)-/i, '') !== 'dshpFlow') continue;
        return Array.from(r.cssRules || []).map(kr => ({ key: kr.keyText, op: kr.style.opacity, tf: kr.style.transform }));
      }
    }
    return null;
  });
  console.log('  ' + JSON.stringify(curve));
  check('★ 淡入渐起（20% 处是中间亮度）且尾段留余光（100% 不为 0）',
    !!curve && curve.some(k => k.key === '20%' && /calc\(.*\* *\.\d+\)/.test(k.op || '')) &&
    curve.some(k => k.key === '100%' && /calc\(.*\* *\.\d+\)/.test(k.op || '')), JSON.stringify(curve));
  check('★ 入场/出场改变大小（呼吸感），且每个有 transform 的帧结构一致',
    !!curve && (() => {
      const tf = curve.filter(k => k.tf).map(k => k.tf);
      if (tf.length < 3) return false;
      const scales = tf.map(t => {
        const m = /scale\(([\d.]+)\)/.exec(t || '');
        return m ? parseFloat(m[1]) : null;
      });
      const allTranslate3d = tf.every(t => /^translate3d\(/.test(t || ''));
      const distinctScales = new Set(scales.filter(v => v !== null)).size;
      return allTranslate3d && distinctScales >= 3;
    })(), JSON.stringify(curve));
  /* 粒子行程必须绑**恒定量**：绑 --dshp-fillW 会让粒子随拖动跟着跳（用户反馈）。 */
  const anchor = await page.evaluate(() => {
    const sl = document.querySelector('.dshp-slider');
    return { trackW: sl.style.getPropertyValue('--dshp-trackW'),
      kfEnd: (() => {
        for (const st of Array.from(document.styleSheets)) {
          let rules; try { rules = st.cssRules; } catch (e) { continue; }
          for (const r of Array.from(rules || [])) {
            if (!r || typeof r.name !== 'string') continue;
            if (r.name.replace(/^-(webkit|moz|ms)-/i, '') !== 'dshpFlow') continue;
            return Array.from(r.cssRules || [])
              .map(kr => kr.style.transform)
              .filter(Boolean).join(' | ');
          }
        }
        return '';
      })() };
  });
  console.log('  ' + JSON.stringify(anchor));
  check('★ 位移绑恒定的 --dshp-trackW（不绑每帧变化的 --dshp-fillW）',
    /--dshp-trackW/.test(anchor.kfEnd) && !/--dshp-fillW/.test(anchor.kfEnd) && !!anchor.trackW,
    JSON.stringify(anchor));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('B. 绽放：只在「拖进最高档」那一刻播一次');
{
  const { page, ctx, errors } = await mount({ current: 1 });
  const rings = await page.evaluate(() => ({
    n: document.querySelectorAll('.dshp-burst,.dshp-burst2').length,
    hidden: Array.from(document.querySelectorAll('.dshp-burst')).every(b => +getComputedStyle(b).opacity === 0),
  }));
  check('★ 滑钮里挂着两层绽放环，平时完全不可见', rings.n === 2 && rings.hidden, JSON.stringify(rings));

  /* 拖到最高档：数一下播放期间有多少个动画对象 */
  const box = await page.$eval('.dshp-sliderTrack', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + box.w * 0.2, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.99, box.y + box.h / 2, { steps: 8 });
  let seen = 0;
  for (let i = 0; i < 6; i++) {
    const n = await page.evaluate(() => document.getAnimations().filter(a => {
      const t = a.effect && a.effect.target;
      return t && /dshp-burst/.test(t.className || '');
    }).length);
    if (n > 0) seen = n;
    await page.waitForTimeout(50);
  }
  await page.mouse.up();
  await page.waitForTimeout(1200);   /* 等它播完 */
  const after = await page.evaluate(() => ({
    running: document.getAnimations().filter(a => {
      const t = a.effect && a.effect.target;
      return t && /dshp-burst/.test(t.className || '');
    }).length,
    hasMaxClass: document.querySelector('.dshp-slider').classList.contains('dshp-sliderMax'),
    /* ⚠️ 这个夹具没有 React fiber，提交走的是 radio.click() 退路，
       宿主的 aria-checked 不会自己变 —— 所以读滑杆自己的 aria 状态，
       那才是插件负责的部分。 */
    now: document.querySelector('.dshp-slider').getAttribute('aria-valuenow'),
    text: document.querySelector('.dshp-slider').getAttribute('aria-valuetext'),
  }));
  console.log('  ' + JSON.stringify({ seen, after }));
  check('★ 拖进最高档：两层环都播了一遍', seen === 2, 'seen=' + seen);
  check('★ 播完就停，不再循环（running=0）', after.running === 0, JSON.stringify(after));
  check('★ 停在最高档且滑杆读数是 Max', after.hasMaxClass && after.now === '3' && after.text === 'Max', JSON.stringify(after));

  /* 已经在最高档时再拖：不应该再爆（没有「进入」这个动作） */
  await page.mouse.move(box.x + box.w * 0.99, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.99, box.y + box.h / 2, { steps: 3 });
  let again = 0;
  for (let i = 0; i < 6; i++) {
    const n = await page.evaluate(() => document.getAnimations().filter(a => {
      const t = a.effect && a.effect.target;
      return t && /dshp-burst/.test(t.className || '');
    }).length);
    if (n > again) again = n;
    await page.waitForTimeout(50);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  check('★ 已经在最高档再拖：不会再放一次（只认「进入」那一瞬）', again === 0, 'again=' + again);
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('C. 打开时本来就在最高档：不该开场就爆');
{
  const { page, ctx, errors } = await mount({ current: 3 });
  const hasClass = await page.evaluate(() => document.querySelector('.dshp-slider').classList.contains('dshp-sliderMax'));
  const ran = await page.evaluate(() => document.getAnimations().filter(a => {
    const t = a.effect && a.effect.target;
    return t && /dshp-burst/.test(t.className || '') && a.playState === 'running';
  }).length);
  check('★ 打开就是最高档：紫色状态照常给出', hasClass, 'class=' + hasClass);
  check('★ 但没有自动绽放（避免每次开菜单都闪一下）', ran === 0, 'running=' + ran);
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('D. 滑钮动效不碰 transform：位移仍归 CSS 过渡，拖动不瞬移');
{
  const { page, ctx, errors } = await mount({ current: 1 });
  /* 键盘到最高档也会触发 fireBurst。动画只有 640ms，等跑完就查不到了 ——
     必须在按键**之后立刻**取样。 */
  const during = await page.evaluate(async () => {
    const slider = document.querySelector('.dshp-slider');
    slider.focus();
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await new Promise(r => requestAnimationFrame(r));
    const k = document.querySelector('.dshp-sliderKnob');
    /* ⚠️ 位移过渡是 CSS transition（CSSTransition 实例），它是**应该**存在的：
       滑钮正是靠它平滑滑到最高档。要排除掉它，只看 fireBurst 用 WAAPI 发起的动画。 */
    const onKnob = document.getAnimations()
      .filter(a => a.effect && a.effect.target === k)
      .filter(a => a.constructor && a.constructor.name !== 'CSSTransition');
    const props = onKnob.map(a => Array.from(a.effect.getKeyframes())
      .flatMap(f => Object.keys(f))
      .filter(p => !['offset', 'computedOffset', 'easing', 'composite'].includes(p)));
    return { n: onKnob.length, props: Array.from(new Set(props.flat())),
      all: document.getAnimations().filter(a => a.effect && a.effect.target === k).length };
  });
  check('★ 滑钮上的动画只碰 box-shadow，不含 transform（不会劫持位移）',
    during.n > 0 && during.props.length > 0 && during.props.every(p => p === 'boxShadow'), JSON.stringify(during));
  /* 位移过渡没被阻断的最高证据：等落位动画跑完，滑钮真的贴到了轨道右端。 */
  await page.waitForTimeout(700);
  const pos = await page.evaluate(() => {
    const t = document.querySelector('.dshp-sliderTrack').getBoundingClientRect();
    const k = document.querySelector('.dshp-sliderKnob').getBoundingClientRect();
    return { knobRight: k.right, trackRight: t.right,
      x: document.querySelector('.dshp-slider').style.getPropertyValue('--dshp-x'),
      travel: document.querySelector('.dshp-slider').style.getPropertyValue('--dshp-travel') };
  });
  check('★ 最高档时滑钮右缘贴到轨道右端', Math.abs(pos.knobRight - pos.trackRight) < 1.5, JSON.stringify(pos));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('E. 光标：平时/按住箭头，按住+移动才变拳头');
{
  const { page, ctx, errors } = await mount({ current: 1 });
  const idle = await page.$eval('.dshp-slider', el => getComputedStyle(el).cursor);
  const box = await page.$eval('.dshp-sliderTrack', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + box.w * 0.4, box.y + box.h / 2);
  await page.mouse.down();
  await page.waitForTimeout(60);
  const pressed = await page.$eval('.dshp-slider', el => getComputedStyle(el).cursor);
  await page.mouse.move(box.x + box.w * 0.6, box.y + box.h / 2, { steps: 3 });
  const dragging = await page.$eval('.dshp-slider', el => getComputedStyle(el).cursor);
  await page.mouse.up();
  await page.waitForTimeout(60);
  const back = await page.$eval('.dshp-slider', el => getComputedStyle(el).cursor);
  console.log('  ' + JSON.stringify({ idle, pressed, dragging, back }));
  check('★ 平时是普通箭头（图一）', idle === 'default', idle);
  /* 用户要求：「按住并移动」两个条件同时成立才变拳头 —— 只按不动仍是箭头。 */
  check('★ 只按住不动：还是普通箭头', pressed === 'default', pressed);
  check('★ 拖动中保持拳头', dragging === 'grabbing', dragging);
  check('★ 松手回到箭头', back === 'default', back);
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('F. 关掉 fx：一行样式都不注入');
{
  const off = buildCssFn({ enabled: true, glass: true, tintAlpha: 0.76, blurPx: 40, slider: true, fx: false });
  const on = buildCssFn({ enabled: true, glass: true, tintAlpha: 0.76, blurPx: 40, slider: true, fx: true });
  const noSlider = buildCssFn({ enabled: true, glass: true, tintAlpha: 0.76, blurPx: 40, slider: false, fx: true });
  /* 触发器箭头的抗闪烁规则属于滑杆段：slider 开着才注入，跟着 slider 开关走。 */
  check('★ 常驻箭头规则随滑杆开关注入/撤掉',
    /conversation\.input\.model'\] button::after/.test(on) &&
    !/conversation\.input\.model'\] button::after/.test(noSlider), '');
  check('★ 配置 fx:false 解析生效', readConfigFn({ config: { fx: false } }).fx === false, '');
  check('★ 默认开着', readConfigFn({}).fx === true, '');
  check('★ 关掉后样式表里没有粒子/绽放/渐变，开着时有',
    !/dshp-p\{|dshp-burst|dshpFlow/.test(off) && /dshp-p\{|dshpFlow/.test(on), '');
  check('★ 滑杆整段关掉时特效段也不注入', !/dshpFlow/.test(noSlider), '');

  const { page, ctx, errors } = await mount({ current: 1, config: { fx: false } });
  const dom = await page.evaluate(() => ({
    particles: document.querySelectorAll('.dshp-p').length,
    bursts: document.querySelectorAll('.dshp-burst,.dshp-burst2').length,
  }));
  check('★ fx:false 时一个粒子/绽放节点都不造', dom.particles === 0 && dom.bursts === 0, JSON.stringify(dom));

  /* 运行时开关：只换样式表，不重建滑杆 DOM */
  const rt = await page.evaluate(() => {
    const knobBefore = document.querySelector('.dshp-sliderKnob');
    const offState = window.dshUiPolish.setFx(false);
    const offCount = document.querySelectorAll('.dshp-p').length;
    const onState = window.dshUiPolish.setFx(true);
    return { offState, onState, offCount, sameKnob: knobBefore === document.querySelector('.dshp-sliderKnob') };
  });
  check('★ setFx(false)/setFx(true) 返回正确且不重建 DOM',
    rt.offState === false && rt.onState === true && rt.sameKnob, JSON.stringify(rt));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();

  const rm = await mount({ current: 1, reducedMotion: 'reduce' });
  const rmState = await rm.page.evaluate(() => {
    const p = document.querySelector('.dshp-p');
    const b = document.querySelector('.dshp-burst');
    return { pAnim: p ? getComputedStyle(p).animationName : 'none',
      bDisplay: b ? getComputedStyle(b).display : 'none' };
  });
  check('★ prefers-reduced-motion：粒子停下、绽放撤掉',
    rmState.pAnim === 'none' && rmState.bDisplay === 'none', JSON.stringify(rmState));
  await rm.page.close(); await rm.ctx.close();
}

console.log('G. 触发器常驻箭头：宿主可替换图标全隐藏，箭头由 ::after 绘制');
{
  const { page, ctx, errors } = await mount({ current: 1 });
  const g = await page.evaluate(async () => {
    const btn = document.querySelector("[data-slot='conversation.input.model'] button");
    /* 模拟宿主两态：空闲时箭头 svg、提交档位时换成 StateDot 转圈 svg。
       两者都必须被藏掉 —— 否则卸载/重挂那一下就是用户反馈的「小箭头会闪」。 */
    const ns = 'http://www.w3.org/2000/svg';
    const chev = document.createElementNS(ns, 'svg');
    chev.setAttribute('class', 'wq12jW_chevron');
    const dot = document.createElementNS(ns, 'svg');
    dot.setAttribute('data-state', 'ongoing');
    btn.appendChild(chev); btn.appendChild(dot);
    const after = getComputedStyle(btn, '::after');
    const closedTransform = after.transform;
    btn.setAttribute('aria-expanded', 'true');
    await new Promise(r => setTimeout(r, 200));  /* 等 120ms 过渡跑完再读 */
    const openTransform = getComputedStyle(btn, '::after').transform;
    btn.disabled = true;
    const disabledOpacity = getComputedStyle(btn, '::after').opacity;
    return {
      chevHidden: getComputedStyle(chev).display === 'none',
      dotHidden: getComputedStyle(dot).display === 'none',
      arrowDrawn: after.width === '7px' && after.position === 'absolute' &&
        after.borderRightWidth === '1px',
      /* 常驻箭头仍跟随开合状态换朝向（观感与宿主原生一致）。 */
      rotates: closedTransform !== openTransform &&
        /matrix/.test(closedTransform) && /matrix/.test(openTransform),
      disabledFade: parseFloat(disabledOpacity) < 1,
    };
  });
  check('★ 箭头 svg 与转圈 svg 都被隐藏（闪烁根源消掉）', g.chevHidden && g.dotHidden, JSON.stringify(g));
  check('★ 常驻箭头由 ::after 画出来', g.arrowDrawn, JSON.stringify(g));
  check('★ 开合朝向跟随 aria-expanded', g.rotates, JSON.stringify(g));
  check('★ 按钮禁用时箭头跟着变淡', g.disabledFade, JSON.stringify(g));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('H. 弹窗淡入淡出：入场淡入 + 关闭残影');
{
  /* 贴近宿主真结构：MenuSurface 根带 data-menu-material，档位页时它自己
     就是 role=menu；触发器按钮的 aria-controls 指向根的 id —— 插件按这个精确认领。 */
  const openMenuSrc = () => {
    document.getElementById('host').innerHTML =
      '<div role="menu" id="menu-x" data-menu-material="translucent">' +
      ['Off', 'Low', 'High', 'Max'].map((l, i) =>
        '<button type="button" role="menuitemradio" aria-checked="' + (i === 2) + '">' +
        '<span class="optionCopy"><span class="modelName">' + l + '</span></span></button>').join('') +
      '</div>';
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  };
  const { page, ctx, errors } = await mount({ current: 2 });
  await page.evaluate(({ openSrc }) => {
    /* 重开一扇门：按钮补上 aria-controls（宿主挂载时两件事同一棵子树）。 */
    const btn = document.querySelector("[data-slot='conversation.input.model'] button");
    btn.setAttribute('aria-controls', 'menu-x');
    btn.setAttribute('aria-expanded', 'true');
    eval('(' + openSrc + ')')();
  }, { openSrc: String(openMenuSrc) });
  await page.waitForTimeout(60);   /* arm → rAF 补扫 → 认领 + 挂入场类 */
  const inState = await page.evaluate(() => {
    const surf = document.getElementById('menu-x');
    if (!surf) return { missing: true };
    const cs = getComputedStyle(surf);
    return {
      claimed: surf.dataset.dshpModelMenu === '1',
      cls: surf.classList.contains('dshp-menuIn'),
      anim: cs.animationName,
      dur: cs.animationDuration,
    };
  });
  check('★ 入场：模型菜单挂上 dshp-menuIn，动画真的在跑', 
    inState.claimed && inState.cls && inState.anim === 'dshpMenuIn', JSON.stringify(inState));
  await page.waitForTimeout(350);  /* 等入场动画结束：animationend 补记静止矩形 */
  const rectState = await page.evaluate(() => {
    const surf = document.getElementById('menu-x');
    const r = surf && surf.__dshpRect;
    return { has: !!(r && r.width > 0 && r.height > 0) };
  });
  check('★ 动画跑完后记下了静止矩形（残影钉回原位有依据）', rectState.has, JSON.stringify(rectState));
  /* 模拟 React 卸载：整扇门从文档里摘掉。观察器回调里应放出残影。 */
  await page.evaluate(() => { document.getElementById('host').innerHTML = ''; });
  await page.waitForTimeout(30);   /* 微任务回调 + 挂上残影 */
  const ghostState = await page.evaluate(() => {
    const g = document.querySelector('.dshp-ghost');
    if (!g) return { missing: true };
    const cs = getComputedStyle(g);
    return {
      anim: cs.animationName,
      role: g.getAttribute('role'),
      hasMenuIn: g.classList.contains('dshp-menuIn'),
      pos: g.style.position,
      left: g.style.left,
      z: g.style.zIndex,
      material: g.hasAttribute('data-menu-material'),
      anyRoleMenu: !!g.querySelector("[role='menu']"),
    };
  });
  check('★ 关闭：放出淡出残影（dshpMenuOut）', ghostState.anim === 'dshpMenuOut', JSON.stringify(ghostState));
  check('★ 残影去角色、不带入场类（扫描/动画都不会撞车）',
    ghostState.role === null && !ghostState.hasMenuIn && !ghostState.anyRoleMenu, JSON.stringify(ghostState));
  check('★ 残影钉回原位（fixed + 矩形兜正 + 层级压真菜单一头）',
    ghostState.pos === 'fixed' && /px$/.test(ghostState.left) && ghostState.z === '1099', JSON.stringify(ghostState));
  check('★ 残影留着材质属性（淡出期间毛玻璃不断）', ghostState.material === true, JSON.stringify(ghostState));
  await page.waitForTimeout(220);  /* 180ms 后 JS 自动清除 */
  const cleared = await page.evaluate(() => !document.querySelector('.dshp-ghost'));
  check('★ 残影动画跑完即清除，不残留', cleared === true, String(cleared));
  /* 遮罩闸门：导航换页（dshp-navBusy）期间整扇门关掉，不该把中间页淡出来。 */
  await page.evaluate(({ openSrc }) => {
    eval('(' + openSrc + ')')();
  }, { openSrc: String(openMenuSrc) });
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const surf = document.getElementById('menu-x');
    surf.classList.add('dshp-navBusy');
    document.getElementById('host').innerHTML = '';
  });
  await page.waitForTimeout(30);
  const veiled = await page.evaluate(() => !document.querySelector('.dshp-ghost'));
  check('★ 遮罩期关闭不放残影（不淡出用户不该看到的中间页）', veiled === true, String(veiled));
  /* 别人的门：有材质、没认领的菜单被关，一律不碰。 */
  await page.evaluate(() => {
    document.getElementById('host').innerHTML =
      '<div role="menu" id="other-menu" data-menu-material="translucent">' +
      '<button role="menuitem">权限 A</button><button role="menuitem">权限 B</button></div>';
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await page.evaluate(() => { document.getElementById('host').innerHTML = ''; });
  await page.waitForTimeout(30);
  const foreign = await page.evaluate(() => !document.querySelector('.dshp-ghost'));
  check('★ 非模型菜单（权限/右键）关闭不被加戏', foreign === true, String(foreign));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('I. 只有 Max 档是紫色：顶档叫 xHigh 也不许变紫（用户要求）');
{
  /* 真机有一批模型的档位是 Off/Low/High/xHigh —— xHigh 是顶档但不是 Max。
     特效（紫渐变/紫字/粒子提速/绽放）以前按"列表最后一项"判定，
     xHigh 就跟着全套变紫。现在按档位名判定。 */
  const { page, ctx, errors } = await mount({ levels: ['Off', 'Low', 'High', 'xHigh'], current: 1 });
  check('★ 顶档是 xHigh 时滑杆照常装上（xHigh 必须在档位词表里，否则整页不被认成档位页）',
    await page.evaluate(() => !!document.querySelector('.dshp-slider')));
  const atTop = await page.evaluate(async () => {
    const s = document.querySelector('.dshp-slider');
    s.focus();
    s.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 700));
    const label = document.querySelector('.dshp-levelLabel');
    return {
      top: label && label.textContent,
      labelColor: label && getComputedStyle(label).color,
      sliderMax: s.classList.contains('dshp-sliderMax'),
      grad: getComputedStyle(document.querySelector('.dshp-sliderFill'), '::before').opacity,
      burst: document.getAnimations().filter(a => {
        const t = a.effect && a.effect.target;
        return t && /dshp-burst/.test(t.className || '');
      }).length,
      knobShadow: getComputedStyle(document.querySelector('.dshp-sliderKnob')).boxShadow,
    };
  });
  check('★ xHigh 顶档：不带 Max 特效（无紫色类）', atTop.sliderMax === false, JSON.stringify(atTop));
  check('★ xHigh 顶档：档位名仍是主题蓝，不是紫',
    /59, 130, 246/.test(atTop.labelColor || ''), atTop.labelColor);
  check('★ xHigh 顶档：紫色渐变不亮、滑钮无紫晕、不绽放',
    atTop.grad === '0' && !/139, 92, 246/.test(atTop.knobShadow) && atTop.burst === 0,
    JSON.stringify({ grad: atTop.grad, shadow: atTop.knobShadow, burst: atTop.burst }));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('I-2. 真 Max 档：紫色特效齐全（顶部档位名是滑杆的兄弟节点，靠 :has 连上）');
{
  const { page, ctx, errors } = await mount({ current: 1 });
  const atMax = await page.evaluate(async () => {
    const s = document.querySelector('.dshp-slider');
    s.focus();
    s.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 700));
    const label = document.querySelector('.dshp-levelLabel');
    return {
      top: label && label.textContent,
      labelColor: label && getComputedStyle(label).color,
      sliderMax: s.classList.contains('dshp-sliderMax'),
      grad: getComputedStyle(document.querySelector('.dshp-sliderFill'), '::before').opacity,
    };
  });
  check('★ Max 顶档：紫色类 + 渐变 + 档位名变紫',
    atMax.sliderMax === true && atMax.grad === '1' && /139, 92, 246/.test(atMax.labelColor || ''),
    JSON.stringify(atMax));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('I-3. 中文档位「最大」同样认作 Max');
{
  const { page, ctx, errors } = await mount({ levels: ['关闭', '低', '中', '最大'], current: 1 });
  const atMax = await page.evaluate(async () => {
    const s = document.querySelector('.dshp-slider');
    if (!s) return { missing: true };
    s.focus();
    s.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 700));
    const label = document.querySelector('.dshp-levelLabel');
    return {
      sliderMax: s.classList.contains('dshp-sliderMax'),
      labelColor: label && getComputedStyle(label).color,
    };
  });
  check('★ 「最大」被认成 Max 档（紫色类 + 紫字）',
    atMax.sliderMax === true && /139, 92, 246/.test(atMax.labelColor || ''),
    JSON.stringify(atMax));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('I-4. 换模型复用同一菜单节点：滑杆按新档位重装（Max 特效不跟着旧模型留）');
{
  /* 宿主换模型常常**复用同一个菜单节点**：React 只改行里的文字。
     旧版那份"已接线"滑杆留着上一个模型的闭包（labels/maxIndex/刻点），
     于是上一个模型有 Max、这一个顶档是 xHigh 时，xHigh 照样变紫。
     现在档位签名变了就拆掉重装。 */
  const { page, ctx, errors } = await mount({ current: 3 });
  const before = await page.evaluate(() => {
    const s = document.querySelector('.dshp-slider');
    return { sig: s && s.dataset.dshpSig, max: s && s.classList.contains('dshp-sliderMax') };
  });
  check('★ 装好时记下档位签名，Max 顶档带紫色类',
    before.max === true && /Max$/.test(before.sig || ''), JSON.stringify(before));
  /* 原地把档位换成 xHigh 顶档（同一批 DOM 节点，只是文字变了）→ 触发一轮扫描。 */
  const after = await page.evaluate(async () => {
    const menu = document.querySelector('[role=menu]');
    const radios = Array.from(menu.querySelectorAll('[role=menuitemradio]'));
    const names = ['Off', 'Low', 'High', 'xHigh'];
    radios.forEach((r, i) => {
      const nm = r.querySelector('.modelName');
      if (nm) nm.textContent = names[i];
    });
    /* 第 3 档（新集合的顶档）设为选中，模拟换模型后的真实档位 */
    radios.forEach((r, i) => r.setAttribute('aria-checked', String(i === 3)));
    window.dshUiPolish.enhanceMenu(menu);
    await new Promise(r => setTimeout(r, 250));
    const s = document.querySelector('.dshp-slider');
    const label = document.querySelector('.dshp-levelLabel');
    return {
      exists: !!s,
      sig: s && s.dataset.dshpSig,
      max: s && s.classList.contains('dshp-sliderMax'),
      dots: s ? s.querySelectorAll('.dshp-sliderDot').length : 0,
      top: label && label.textContent,
      labelColor: label && getComputedStyle(label).color,
    };
  });
  check('★ 换档后滑杆重装（签名跟着新档位）',
    after.exists === true && /xHigh$/.test(after.sig || ''), JSON.stringify(after));
  check('★ 顶档 xHigh 不再残留 Max 紫（紫色类已摘、档位名仍是蓝）',
    after.max === false && /59, 130, 246/.test(after.labelColor || '') && after.top === 'xHigh',
    JSON.stringify(after));
  /* 档位数变了（4 → 3）：刻点必须重生成，不能留 4 个点。 */
  const countChange = await page.evaluate(async () => {
    const menu = document.querySelector('[role=menu]');
    const radios = Array.from(menu.querySelectorAll('[role=menuitemradio]'));
    radios[3].remove();
    window.dshUiPolish.enhanceMenu(menu);
    await new Promise(r => setTimeout(r, 250));
    const s = document.querySelector('.dshp-slider');
    return {
      sig: s && s.dataset.dshpSig,
      dots: s ? s.querySelectorAll('.dshp-sliderDot').length : 0,
      max: s && s.classList.contains('dshp-sliderMax'),
      valuemax: s && s.getAttribute('aria-valuemax'),
    };
  });
  check('★ 档位数变化时刻点与行程上限一起重算（3 档）',
    countChange.dots === 3 && countChange.valuemax === '2' && countChange.max === false,
    JSON.stringify(countChange));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('J. 选完一档后 3 秒窗口内再次滑动：扫描不许把滑钮拽回档位刻度（闪烁）');
{
  /* 真机时序：拖到 Max 松手提交 → pickedIndex=3、3 秒窗口开启（重开菜单时
     用它顶住宿主默认档）。窗口内用户**再次滑动**：拖动中 pickedIndex 跟着
     手指换档，而宿主 aria-checked 还是旧档 → 扫描轮以为"滑杆停错了"，
     调 applyPicked 把滑杆 paint 回 pickedIndex（吸附到刻度）。
     拖动每跨一档就写 data-dshp-target → MutationObserver → 补扫 →
     又被吸附：滑钮在"手指位置"和"最近刻度"之间来回跳 —— 按钮闪烁。 */
  const { page, ctx, errors } = await mount({ current: 2 });
  const res = await page.evaluate(async () => {
    const menu = document.querySelector('[role=menu]');
    const radios = Array.from(menu.querySelectorAll('[role=menuitemradio]'));
    /* 模拟宿主的**异步**提交：aria-checked 30ms 后才落地（真机是一个往返）。 */
    menu.addEventListener('click', (ev) => {
      const r = ev.target.closest('[role=menuitemradio]');
      if (!r) return;
      const idx = radios.indexOf(r);
      setTimeout(() => {
        radios.forEach((x, i) => x.setAttribute('aria-checked', String(i === idx)));
      }, 30);
    });
    const s = document.querySelector('.dshp-slider');
    const track = s.querySelector('.dshp-sliderTrack');
    const knob = s.querySelector('.dshp-sliderKnob');
    const rect = track.getBoundingClientRect();
    const kw = knob.offsetWidth || 22;
    const travel = rect.width - kw;
    const y = rect.top + rect.height / 2;
    const at = (t) => ({ clientX: rect.left + kw / 2 + travel * t, clientY: y });
    const pev = (type, t) => new PointerEvent(type, Object.assign(
      { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true }, at(t)));
    /* ① 先选一档：拖到 Max 松手提交，等宿主状态落地（aria-checked=3）。 */
    track.dispatchEvent(pev('pointerdown', 1));
    track.dispatchEvent(pev('pointerup', 1));
    await new Promise(r2 => setTimeout(r2, 150));
    /* ② 3 秒窗口内再次滑动：拖到 0.4（跨到第 1 档），中途插一轮扫描
       （模拟 MutationObserver 补扫），再拖到 0.45、再扫一轮。 */
    const seq = [];
    const readT = () => parseFloat(s.style.getPropertyValue('--dshp-t'));
    track.dispatchEvent(pev('pointerdown', 1));
    track.dispatchEvent(pev('pointermove', 0.4));
    seq.push(readT());
    window.dshUiPolish.enhanceMenu(menu);
    seq.push(readT());
    track.dispatchEvent(pev('pointermove', 0.45));
    seq.push(readT());
    window.dshUiPolish.enhanceMenu(menu);
    seq.push(readT());
    /* ③ 松手在 0.4 → 应提交第 1 档（Low），一切落定。 */
    track.dispatchEvent(pev('pointerup', 0.4));
    await new Promise(r2 => setTimeout(r2, 500));
    const tFinal = readT();
    const checked = radios.map(r2 => r2.getAttribute('aria-checked') === 'true');
    return {
      seq,
      tFinal,
      checkedCount: checked.filter(Boolean).length,
      checkedIdx: checked.indexOf(true),
      pressed: s.classList.contains('dshp-sliderPressed') || s.classList.contains('dshp-sliderActive'),
    };
  });
  check('★ 拖动中扫描不吸附：位置始终停在手指上（0.4/0.45，不许跳到 1/3 刻度）',
    Math.abs(res.seq[0] - 0.4) < 0.02 && Math.abs(res.seq[1] - 0.4) < 0.02 &&
    Math.abs(res.seq[2] - 0.45) < 0.02 && Math.abs(res.seq[3] - 0.45) < 0.02,
    JSON.stringify(res.seq));
  check('★ 松手后正常提交到手指所在档（Low）',
    Math.abs(res.tFinal - 1 / 3) < 0.03 && res.checkedIdx === 1 && res.checkedCount === 1,
    JSON.stringify(res));
  check('★ 手势状态已复位（无残留按下/拖动类）', res.pressed === false, JSON.stringify(res));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('J-2. 跨多档连续拖动 + 每帧间插扫描（真机 150ms 自检节律）：全程不许吸附刻度');
{
  const { page, ctx, errors } = await mount({ current: 0 });
  const res = await page.evaluate(async () => {
    const menu = document.querySelector('[role=menu]');
    const radios = Array.from(menu.querySelectorAll('[role=menuitemradio]'));
    /* 宿主异步提交：aria-checked 30ms 后才落地 */
    menu.addEventListener('click', (ev) => {
      const r = ev.target.closest('[role=menuitemradio]');
      if (!r) return;
      const idx = radios.indexOf(r);
      setTimeout(() => {
        radios.forEach((x, i) => x.setAttribute('aria-checked', String(i === idx)));
      }, 30);
    });
    const s = document.querySelector('.dshp-slider');
    const track = s.querySelector('.dshp-sliderTrack');
    const knob = s.querySelector('.dshp-sliderKnob');
    const rect = track.getBoundingClientRect();
    const kw = knob.offsetWidth || 22;
    const travel = rect.width - kw;
    const y = rect.top + rect.height / 2;
    const at = (t) => ({ clientX: rect.left + kw / 2 + travel * t, clientY: y });
    const pev = (type, t) => new PointerEvent(type, Object.assign(
      { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true }, at(t)));
    const readT = () => parseFloat(s.style.getPropertyValue('--dshp-t'));
    /* 先在档位 0 原地提交一次（模拟"点选了一档"）：按下在最左端、松手 →
       target(0) === index(0) → 走"原地松手"分支续窗。 */
    track.dispatchEvent(pev('pointerdown', 0));
    track.dispatchEvent(pev('pointerup', 0));
    await new Promise(r2 => setTimeout(r2, 120));
    /* 窗口开着，跨档慢拖：0.1 → 0.9，每动一步插一轮扫描。
       有吸附 bug 时，每个扫描点都会被拽到最近刻度（0.333/0.667）。 */
    const steps = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.95];
    const pairs = [];
    track.dispatchEvent(pev('pointerdown', 0));
    for (const t of steps) {
      track.dispatchEvent(pev('pointermove', t));
      const a = readT();
      window.dshUiPolish.enhanceMenu(menu);
      pairs.push([t, a, readT()]);
    }
    track.dispatchEvent(pev('pointerup', 0.95));
    await new Promise(r2 => setTimeout(r2, 500));
    return {
      pairs,
      finalT: readT(),
      checkedIdx: radios.map(r2 => r2.getAttribute('aria-checked') === 'true').indexOf(true),
      valuenow: s.getAttribute('aria-valuenow'),
    };
  });
  const drift = res.pairs.map(p => Math.abs(p[2] - p[0])).filter(d => d > 0.02);
  check('★ 七步慢拖全程跟手：扫描后位置仍在手指上（不许跳到刻度）',
    drift.length === 0, JSON.stringify(res.pairs));
  check('★ 松手提交落在手指档位（Max），宿主状态同步',
    Math.abs(res.finalT - 1) < 0.02 && res.checkedIdx === 3 && res.valuenow === '3',
    JSON.stringify(res));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('K. 「重开顶住宿主默认档」的 3 秒窗口仍然有效（J 的改动不许把它削掉）');
{
  /* commit 之后宿主要重渲染，那一两轮里 aria-checked 可能还是**换模型前的默认档**。
     窗口内的扫描必须以用户刚提交的档位为准，不能把滑杆拽回宿主默认值。
     按下关窗（J 的修法）只该关掉「手势期间」的吸附，不该破坏这个语义。 */
  const { page, ctx, errors } = await mount({ current: 1 });
  const res = await page.evaluate(async () => {
    const menu = document.querySelector('[role=menu]');
    const radios = Array.from(menu.querySelectorAll('[role=menuitemradio]'));
    const s = document.querySelector('.dshp-slider');
    const track = s.querySelector('.dshp-sliderTrack');
    const knob = s.querySelector('.dshp-sliderKnob');
    const rect = track.getBoundingClientRect();
    const kw = knob.offsetWidth || 22;
    const travel = rect.width - kw;
    const y = rect.top + rect.height / 2;
    const at = (t) => ({ clientX: rect.left + kw / 2 + travel * t, clientY: y });
    const pev = (type, t) => new PointerEvent(type, Object.assign(
      { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true }, at(t)));
    /* 拖到 Max 提交（夹具没有 React select → 走 radio.click 退路）。 */
    track.dispatchEvent(pev('pointerdown', 1));
    track.dispatchEvent(pev('pointerup', 1));
    await new Promise(r2 => setTimeout(r2, 120));
    /* 模拟宿主重渲染把状态打回默认档（第 1 档 Low）。 */
    radios.forEach((x, i) => x.setAttribute('aria-checked', String(i === 1)));
    window.dshUiPolish.enhanceMenu(menu);
    await new Promise(r2 => setTimeout(r2, 80));
    const label = document.querySelector('.dshp-levelLabel');
    const held = {
      t: parseFloat(s.style.getPropertyValue('--dshp-t')),
      valuenow: s.getAttribute('aria-valuenow'),
      top: label && label.textContent,
    };
    /* 窗口过期后（把 pickedUntil 视为已过：等 3.2s 太久，这里直接验证
       「原地松手续窗」也成立：轻点同一档不提交，但窗口要续上，
       随后宿主状态被重渲染打回默认档时滑杆仍停在原档）。 */
    track.dispatchEvent(pev('pointerdown', 1));
    track.dispatchEvent(pev('pointerup', 1));   /* 原地松手（Max）→ 续窗 */
    radios.forEach((x, i) => x.setAttribute('aria-checked', String(i === 1)));
    window.dshUiPolish.enhanceMenu(menu);
    await new Promise(r2 => setTimeout(r2, 80));
    const again = {
      t: parseFloat(s.style.getPropertyValue('--dshp-t')),
      valuenow: s.getAttribute('aria-valuenow'),
    };
    return { held, again };
  });
  check('★ 提交后宿主被打回默认档：窗口内滑杆仍停在 Max（不被拽回）',
    Math.abs(res.held.t - 1) < 0.02 && res.held.valuenow === '3' && res.held.top === 'Max',
    JSON.stringify(res.held));
  check('★ 原地松手续窗：轻点同一档后仍顶住宿主默认档',
    Math.abs(res.again.t - 1) < 0.02 && res.again.valuenow === '3',
    JSON.stringify(res.again));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('J-3. 手势被系统取消（pointercancel）后：滑杆不许被宿主的滞后状态来回拽');
{
  /* 按下即关窗（J 的修法）之后，若这次手势**没有提交**就结束，窗口必须按
     最后一次真实档位重新续上 —— 否则下一轮扫描一看 settled 就拿 aria-checked
     回写，而宿主这次往返还没落地（下面把延迟拉到 300ms 复刻真机），
     滑杆先被拽回旧档、宿主落地再被拽回来：同一种来回弹。 */
  const { page, ctx, errors } = await mount({ current: 1 });
  const res = await page.evaluate(async () => {
    const menu = document.querySelector('[role=menu]');
    const radios = Array.from(menu.querySelectorAll('[role=menuitemradio]'));
    menu.addEventListener('click', (ev) => {
      const r = ev.target.closest('[role=menuitemradio]');
      if (!r) return;
      const idx = radios.indexOf(r);
      setTimeout(() => {
        radios.forEach((x, i) => x.setAttribute('aria-checked', String(i === idx)));
      }, 300);   /* 宿主往返很慢 */
    });
    const s = document.querySelector('.dshp-slider');
    const track = s.querySelector('.dshp-sliderTrack');
    const knob = s.querySelector('.dshp-sliderKnob');
    const rect = track.getBoundingClientRect();
    const kw = knob.offsetWidth || 22;
    const travel = rect.width - kw;
    const y = rect.top + rect.height / 2;
    const at = (t) => ({ clientX: rect.left + kw / 2 + travel * t, clientY: y });
    const pev = (type, t) => new PointerEvent(type, Object.assign(
      { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true }, at(t)));
    const readT = () => parseFloat(s.style.getPropertyValue('--dshp-t'));
    /* ① 拖到 Max 松手提交（宿主 300ms 后才落地）。 */
    track.dispatchEvent(pev('pointerdown', 1));
    track.dispatchEvent(pev('pointerup', 1));
    /* ② 立刻再按一次，然后手势被系统取消（没有提交）。 */
    track.dispatchEvent(pev('pointerdown', 0.6));
    track.dispatchEvent(pev('pointercancel', 0.6));
    /* 取消后紧跟一轮扫描：真机必然发生（React 重渲染 + 150ms 自检）。 */
    window.dshUiPolish.enhanceMenu(menu);
    const tAfterCancel = readT();
    const valuenow = s.getAttribute('aria-valuenow');
    await new Promise(r2 => setTimeout(r2, 450));
    return { tAfterCancel, valuenow, tSettled: readT() };
  });
  check('★ 取消手势后扫描不把滑杆拽回旧档（仍在 Max，档位读数=3）',
    Math.abs(res.tAfterCancel - 1) < 0.02 && res.valuenow === '3',
    JSON.stringify(res));
  check('★ 宿主落地后位置一致（没有来回弹）',
    Math.abs(res.tSettled - 1) < 0.02, JSON.stringify(res));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

console.log('J-4. 指针中途被宿主抢走（lostpointercapture）：手势必须收尾，不许卡住');
{
  /* 按下时我们抓了指针（setPointerCapture）；宿主重排把我们摘下时浏览器只发
     lostpointercapture —— 以前没接它：dragging 和按压/抓握类名永远留着，滑钮卡在
     放大态、光标卡在抓握，滑杆签名重装也被类名护栏挡住（换模型会留着旧档位滑杆），
     扫描轮的 isDragging 护栏还会一直误判"用户正拖着"。 */
  const { page, ctx, errors } = await mount({ current: 1 });
  const res = await page.evaluate(async () => {
    const menu = document.querySelector('[role=menu]');
    const radios = Array.from(menu.querySelectorAll('[role=menuitemradio]'));
    menu.addEventListener('click', (ev) => {
      const r = ev.target.closest('[role=menuitemradio]');
      if (!r) return;
      const idx = radios.indexOf(r);
      setTimeout(() => {
        radios.forEach((x, i) => x.setAttribute('aria-checked', String(i === idx)));
      }, 300);   /* 宿主往返很慢 */
    });
    const s = document.querySelector('.dshp-slider');
    const track = s.querySelector('.dshp-sliderTrack');
    const knob = s.querySelector('.dshp-sliderKnob');
    const rect = track.getBoundingClientRect();
    const kw = knob.offsetWidth || 22;
    const travel = rect.width - kw;
    const y = rect.top + rect.height / 2;
    const at = (t) => ({ clientX: rect.left + kw / 2 + travel * t, clientY: y });
    const pev = (type, t) => new PointerEvent(type, Object.assign(
      { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true }, at(t)));
    const lost = () => track.dispatchEvent(new PointerEvent('lostpointercapture', Object.assign(
      { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }, at(0.5))));
    const readT = () => parseFloat(s.style.getPropertyValue('--dshp-t'));
    /* ① 先正常提交一档 Max（300ms 后宿主落地）。 */
    track.dispatchEvent(pev('pointerdown', 1));
    track.dispatchEvent(pev('pointerup', 1));
    await new Promise(r2 => setTimeout(r2, 400));
    /* ② 再次按下、真的拖起来（进入抓握态）。 */
    track.dispatchEvent(pev('pointerdown', 0.45));
    track.dispatchEvent(pev('pointermove', 0.5));
    const activeBefore = s.classList.contains('dshp-sliderActive');
    /* ③ 手势被宿主抢走：只有 lostpointercapture，没有 pointerup / pointercancel。 */
    lost();
    window.dshUiPolish.enhanceMenu(menu);
    const out = {
      activeBefore,
      activeAfter: s.classList.contains('dshp-sliderActive'),
      pressedAfter: s.classList.contains('dshp-sliderPressed'),
      tAfterLost: readT(),
      valuenow: s.getAttribute('aria-valuenow'),
    };
    await new Promise(r2 => setTimeout(r2, 450));
    /* 迟到的第二次 lostpointercapture（真实 pointerup 后浏览器也会补发一个）：
       dragging 已 false，必须空转，不许把滑杆或窗口状态再动一下。 */
    lost();
    window.dshUiPolish.enhanceMenu(menu);
    out.tSettled = readT();
    out.valuenowSettled = s.getAttribute('aria-valuenow');
    return out;
  });
  check('★ 前提成立：抢走时确实在抓握态', res.activeBefore === true, JSON.stringify(res));
  check('★ lostpointercapture 后彻底收尾（无残留按压/抓握类名）',
    res.activeAfter === false && res.pressedAfter === false, JSON.stringify(res));
  check('★ 被抢走的手势作废：滑杆回当前档 Max，档位读数=3',
    Math.abs(res.tAfterLost - 1) < 0.02 && res.valuenow === '3', JSON.stringify(res));
  check('★ 迟到的重复事件空转：位置与读数不动（来回弹消掉）',
    Math.abs(res.tSettled - 1) < 0.02 && res.valuenowSettled === '3', JSON.stringify(res));
  check('无页面报错', errors.length === 0, errors.join('|'));
  await page.close(); await ctx.close();
}

await browser.close();
console.log(failures ? '[fx] 失败 ' + failures + ' 项' : '[fx] 全部通过：粒子只横向流动，绽放拖到最高档才放一次，光标按图切换，触发器箭头不再闪，弹窗淡入淡出有残影兜底，只有 Max 变紫（含换模型复用节点）');
process.exit(failures ? 1 : 0);
