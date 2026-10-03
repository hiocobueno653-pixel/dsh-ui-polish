/**
 * 宿主半（空实现）：只为让本插件在 Cordis Loader / profile 里占一行。
 *
 * 打磨层完全活在浏览器半（lib/client.js）：它只注入一份样式表，
 * 修的是宿主渲染出来的界面材质，不注册服务、不碰会话数据。
 */
export const name = 'ui-polish';
export const inject = [];

export function apply() {
  /* 纯 UI 插件：无需宿主侧行为。 */
}

export default { name, inject, apply };
