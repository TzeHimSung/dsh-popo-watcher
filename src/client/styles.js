const CSS = `
  .dsh-popo-root{container:popo / inline-size;min-width:0;width:100%;font-size:14px;line-height:22px;--popo-text:var(--dsw-alias-label-primary,#0f1115);--popo-surface:var(--dsw-alias-bg-layer-2,#fff);--popo-line:var(--dsw-alias-border-l2,#0000001a);--popo-muted:var(--dsw-alias-label-secondary,#61666b);--popo-primary:var(--dsw-alias-button-primary-fill,#0f1115);--popo-danger:var(--dsw-alias-state-error-primary,#ec1313);--popo-success:var(--dsw-alias-state-success-primary,#22c55e);--popo-warn:var(--dsw-alias-state-warn-primary,#f59e0b);--popo-panel:color-mix(in srgb,var(--popo-text) 2%,var(--popo-surface));--popo-shadow:0 1px 2px rgba(15,17,21,.04),0 4px 12px rgba(15,17,21,.03);color:var(--popo-text)}
  body[data-ds-dark-theme] .dsh-popo-root{--popo-shadow:none}
  .dsh-popo-root *{box-sizing:border-box;min-width:0}
  .dsh-popo-root [hidden]{display:none!important}
  .dsh-popo-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
  .dsh-popo-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
  .dsh-popo-page-head{justify-content:flex-start;align-items:baseline;gap:4px 12px}
  .dsh-popo-title{font-size:14px;line-height:22px;font-weight:600;margin:0}
  .dsh-popo-heading{font-size:16px;line-height:24px;font-weight:600;margin:0}
  .dsh-popo-tabs{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:20px;padding:8px 0 0;border-bottom:1px solid var(--popo-line);background:var(--popo-surface)}
  .dsh-popo-tab{min-height:40px;border:0;border-bottom:2px solid transparent;background:transparent;padding:8px 0;font:inherit;color:var(--popo-muted);cursor:pointer;transition:color .12s ease,border-color .12s ease}
  .dsh-popo-tab[aria-selected="true"]{border-bottom-color:var(--popo-text);color:var(--popo-text)}
  .dsh-popo-panel{padding-top:16px;display:flex;flex-direction:column;gap:16px}
  .dsh-popo-card{display:flex;flex-direction:column;gap:12px}
  .dsh-popo-monitor{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--popo-line);border-radius:12px;background:var(--popo-panel);box-shadow:var(--popo-shadow)}
  .dsh-popo-monitor-heading{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
  .dsh-popo-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;padding:2px 8px;border-radius:6px;--popo-tone:var(--popo-muted);background:color-mix(in srgb,var(--popo-tone) 8%,var(--popo-surface));color:var(--popo-text);overflow-wrap:anywhere}
  .dsh-popo-badge::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--popo-tone)}
  .dsh-popo-root [data-tone="ok"]{--popo-tone:var(--popo-success)}
  .dsh-popo-root [data-tone="warn"]{--popo-tone:var(--popo-warn)}
  .dsh-popo-root [data-tone="bad"]{--popo-tone:var(--popo-danger)}
  .dsh-popo-k{color:var(--popo-muted)}
  .dsh-popo-v{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
  .dsh-popo-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-areas:"collection updated sends";gap:12px 16px;margin:0;border-top:1px solid var(--popo-line);padding-top:12px}
  .dsh-popo-summary>div{display:flex;flex-direction:column;align-items:flex-start;gap:4px}
  .dsh-popo-summary [data-stat="collection"]{grid-area:collection}
  .dsh-popo-summary [data-stat="updated"]{grid-area:updated}
  .dsh-popo-summary [data-stat="sends"]{grid-area:sends}
  .dsh-popo-summary dt{font-size:12px;line-height:18px}
  .dsh-popo-summary dd{font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}
  .dsh-popo-summary [data-stat="updated"] dd{font-size:14px;line-height:20px;font-weight:400}
  .dsh-popo-note,.dsh-popo-err{margin:0;font-size:12px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap}
  .dsh-popo-note{color:var(--popo-muted)}
  .dsh-popo-err{color:color-mix(in srgb,var(--popo-danger) 75%,var(--popo-text))}
  .dsh-popo-notice,.dsh-popo-note:is([data-tone="ok"],[data-tone="warn"],[data-tone="bad"]){padding:8px 12px;border-radius:8px;border-left:2px solid var(--popo-tone,var(--popo-line));background:color-mix(in srgb,var(--popo-tone,var(--popo-muted)) 8%,var(--popo-surface));color:var(--popo-text)}
  .dsh-popo-notice>summary{cursor:pointer;overflow-wrap:anywhere}
  .dsh-popo-notice[open]>summary{margin-bottom:8px}
  .dsh-popo-btn{display:inline-flex;align-items:center;justify-content:center;align-self:auto;min-height:36px;padding:6px 12px;border:1px solid var(--popo-line);border-radius:8px;background:var(--popo-surface);color:inherit;font:inherit;cursor:pointer;transition:background-color .12s ease,border-color .12s ease,color .12s ease}
  .dsh-popo-btn[data-primary="true"]{background:var(--popo-primary);border-color:var(--popo-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}
  .dsh-popo-btn[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-active,#e8ecf5);border-color:var(--popo-primary)}
  .dsh-popo-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,#2631480f)}
  .dsh-popo-btn[data-primary="true"]:hover:enabled{background:var(--dsw-alias-button-primary-hover,#43454a)}
  .dsh-popo-monitor-toggle{display:flex;align-items:center;gap:8px;min-height:32px}
  .dsh-popo-switch{position:relative;display:inline-flex;flex:0 0 52px;width:52px;height:32px;padding:3px;border:0;border-radius:999px;background:color-mix(in srgb,var(--popo-text) 22%,var(--popo-surface));appearance:none;cursor:pointer;transition:background-color .12s ease}
  .dsh-popo-switch[aria-checked="true"]{background:#16a34a}
  .dsh-popo-switch:is([data-unknown="true"],[data-tone="warn"],[data-tone="bad"]){background:color-mix(in srgb,var(--popo-text) 22%,var(--popo-surface))}
  .dsh-popo-switch-thumb{display:block;width:26px;height:26px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0003;transform:translateX(0);transition:transform .18s ease}
  .dsh-popo-switch[aria-checked="true"] .dsh-popo-switch-thumb{transform:translateX(20px)}
  @media(prefers-reduced-motion:reduce){.dsh-popo-root *{transition:none!important}}
  .dsh-popo-btn:disabled,.dsh-popo-switch:disabled,.dsh-popo-input:disabled,.dsh-popo-check:has(input:disabled){opacity:.55;cursor:default}
  .dsh-popo-root :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px}
  .dsh-popo-actions{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px}
  .dsh-popo-duration{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 12px}
  .dsh-popo-hours{display:flex;align-items:center;gap:8px}
  .dsh-popo-hours .dsh-popo-input{width:72px}
  .dsh-popo-remaining{font-variant-numeric:tabular-nums}
  .dsh-popo-form{display:grid;grid-template-columns:minmax(0,1fr);gap:14px 16px}
  .dsh-popo-field{display:flex;flex-direction:column;gap:6px}
  .dsh-popo-wide{grid-column:1 / -1}
  .dsh-popo-check{display:flex;align-items:center;gap:8px}
  .dsh-popo-check input{flex:none;accent-color:var(--popo-primary)}
  .dsh-popo-input{padding:6px 8px;min-height:36px;border:1px solid var(--dsw-alias-border-l4,#00000029);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;width:100%;transition:border-color .12s ease}
  .dsh-popo-input::placeholder{color:var(--popo-muted);opacity:1}
  select.dsh-popo-input{max-width:100%;text-overflow:ellipsis}
  textarea.dsh-popo-input{resize:vertical}
  .dsh-popo-input[aria-invalid="true"]{border-color:var(--popo-danger)}
  .dsh-popo-section,.dsh-popo-details{border-top:1px solid var(--popo-line);padding-top:14px}
  .dsh-popo-details{padding-top:0}
  .dsh-popo-details>summary{min-height:44px;padding:11px 0;cursor:pointer;overflow-wrap:anywhere}
  .dsh-popo-details[open]>summary{margin-bottom:4px}
  .dsh-popo-detail-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
  .dsh-popo-detail-card,.dsh-popo-diagnostic-tools{padding:14px;border-radius:12px;background:color-mix(in srgb,var(--popo-text) 4%,var(--popo-surface))}
  .dsh-popo-detail-card .dsh-popo-title,.dsh-popo-diagnostic-action .dsh-popo-title{font-size:13px;line-height:20px}
  .dsh-popo-detail-fields{display:grid;gap:12px;margin:0;font-size:13px;line-height:20px}
  .dsh-popo-detail-fields dt{margin-bottom:2px;font-size:12px;line-height:18px}
  .dsh-popo-detail-card[data-section="activity"] .dsh-popo-detail-field{display:grid;grid-template-columns:78px minmax(0,1fr);gap:8px;align-items:start}
  .dsh-popo-diagnostic-tools{padding:0 14px}
  .dsh-popo-diagnostic-tool{display:flex;flex-direction:column;gap:10px;padding:14px 0}
  .dsh-popo-diagnostic-tool+.dsh-popo-diagnostic-tool{border-top:1px solid var(--popo-line)}
  .dsh-popo-diagnostic-action{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .dsh-popo-diagnostic-action .dsh-popo-note{margin-top:2px}
  .dsh-popo-diagnostic-action .dsh-popo-btn{flex:none}
  .dsh-popo-cli-result{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--popo-tone) 8%,var(--popo-surface))}
  .dsh-popo-cli-result-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:4px 12px;font-size:12px;line-height:18px}
  .dsh-popo-cli-result-head time{color:var(--popo-muted);font-variant-numeric:tabular-nums}
  .dsh-popo-cli-result>.dsh-popo-note{padding:0;border:0;border-radius:0;background:transparent;color:var(--popo-text)}
  .dsh-popo-manual-text{height:84px;min-height:84px;padding:8px 12px}
  .dsh-popo-sendbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .dsh-popo-sendbar .dsh-popo-btn{flex:none;min-width:72px}
  .dsh-popo-refresh{display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px 12px;margin-top:-8px;font-variant-numeric:tabular-nums}
  /* 宿主设置区底部留白为 24px；保存栏背景覆盖该留白，避免下方字段透出。 */
  .dsh-popo-savebar{position:sticky;bottom:-24px;z-index:1;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;background:var(--popo-surface);border-top:1px solid var(--popo-line);padding:12px 0 36px;margin-bottom:-24px}
  .dsh-popo-savebar>.dsh-popo-actions{justify-self:end;flex-wrap:nowrap}
  .dsh-popo-savebar>:is(.dsh-popo-err,[data-dsh-popo-note]){grid-column:1 / -1}
  .dsh-popo-lines{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:20px}
  .dsh-popo-line{white-space:pre-wrap;overflow-wrap:anywhere;border-bottom:1px solid var(--popo-line);padding-bottom:12px}
  .dsh-popo-empty{padding:32px 0;text-align:center}
  @container popo (min-width:520px){.dsh-popo-form,.dsh-popo-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @container popo (width < 520px){.dsh-popo-monitor{padding:12px}.dsh-popo-summary{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-areas:"collection sends" "updated updated"}.dsh-popo-detail-field{display:grid;grid-template-columns:78px minmax(0,1fr);gap:8px;align-items:start}}
  @container popo (width < 400px){.dsh-popo-sendbar{flex-direction:column;align-items:stretch;gap:8px}.dsh-popo-sendbar .dsh-popo-btn{align-self:flex-end}.dsh-popo-diagnostic-action{flex-wrap:wrap}.dsh-popo-diagnostic-action .dsh-popo-btn{margin-left:auto}}
`

/**
 * 注入样式，返回清理函数。
 * 用引用计数共享同一个 `<style>`：HMR / connection 变化会重跑 apply，若"新 apply 先于旧 dispose"，
 * 无脑共享会让旧 dispose 把新页面正在用的标签删掉（整块丢样式）。
 */
let styleRefs = 0
function installStyles() {
  if (typeof document === 'undefined') return () => {}
  let tag = document.querySelector('style[data-dsh-popo-css]')
  if (tag === null) {
    tag = document.createElement('style')
    tag.dataset.dshPopoCss = ''
    tag.textContent = CSS
    document.head.append(tag)
  }
  styleRefs += 1
  return () => {
    styleRefs = Math.max(0, styleRefs - 1)
    if (styleRefs === 0) tag.remove()
  }
}

export { installStyles }
