const CSS = `
  .dsh-popo-root{container:popo / inline-size;min-width:0;width:100%;font-size:14px;line-height:22px;--popo-text:var(--dsw-alias-label-primary,#0f1115);--popo-surface:var(--dsw-alias-bg-layer-2,#fff);--popo-line:var(--dsw-alias-border-l2,#0000001a);--popo-muted:var(--dsw-alias-label-secondary,#61666b);--popo-primary:var(--dsw-alias-button-primary-fill,#0f1115);--popo-danger:var(--dsw-alias-state-error-primary,#ec1313);--popo-success:var(--dsw-alias-state-success-primary,#22c55e);--popo-warn:var(--dsw-alias-state-warn-primary,#f59e0b);color:var(--popo-text)}
  .dsh-popo-root *{box-sizing:border-box;min-width:0}
  .dsh-popo-root [hidden]{display:none!important}
  .dsh-popo-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
  .dsh-popo-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
  .dsh-popo-page-head{justify-content:flex-start;align-items:baseline;gap:4px 12px}
  .dsh-popo-title{font-size:14px;line-height:22px;font-weight:600;margin:0}
  .dsh-popo-heading{font-size:16px;line-height:24px;font-weight:600;margin:0}
  .dsh-popo-tabs{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:20px;padding:8px 0 0;border-bottom:.5px solid var(--popo-line);background:var(--popo-surface)}
  .dsh-popo-tab{min-height:40px;border:0;border-bottom:2px solid transparent;background:transparent;padding:8px 0;font:inherit;color:var(--popo-muted);cursor:pointer;transition:color .12s ease,border-color .12s ease}
  .dsh-popo-tab[aria-selected="true"]{border-bottom-color:var(--popo-text);color:var(--popo-text)}
  .dsh-popo-panel{display:flex;flex-direction:column}
  .dsh-popo-card{display:flex;flex-direction:column;gap:12px}
  .dsh-popo-section{padding:20px 0}
  .dsh-popo-panel>.dsh-popo-section+.dsh-popo-section{border-top:.5px solid var(--popo-line)}
  .dsh-popo-section>.dsh-popo-head{min-height:28px}
  .dsh-popo-monitor{padding-top:0;gap:16px}
  .dsh-popo-monitor-heading{display:flex;align-items:center;flex-wrap:wrap;gap:12px}
  .dsh-popo-control-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px 24px;padding:14px 0;border-bottom:.5px solid var(--popo-line)}
  .dsh-popo-control-copy{display:flex;flex-direction:column;gap:4px}
  .dsh-popo-control-row>[data-dsh-popo-note],.dsh-popo-control-feedback{grid-column:1 / -1}
  .dsh-popo-control-feedback{justify-self:start}
  .dsh-popo-controls>[data-dsh-popo-note],.dsh-popo-controls>.dsh-popo-note,.dsh-popo-controls>.dsh-popo-err{margin-top:12px}
  .dsh-popo-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;--popo-tone:var(--popo-muted);color:var(--popo-muted);overflow-wrap:anywhere}
  .dsh-popo-badge::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--popo-tone)}
  .dsh-popo-root [data-tone="ok"]{--popo-tone:var(--popo-success)}
  .dsh-popo-root [data-tone="warn"]{--popo-tone:var(--popo-warn)}
  .dsh-popo-root [data-tone="bad"]{--popo-tone:var(--popo-danger)}
  .dsh-popo-k{color:var(--popo-muted)}
  .dsh-popo-v{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
  .dsh-popo-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-areas:"collection updated sends";margin:0}
  .dsh-popo-summary>div{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:0 16px}
  .dsh-popo-summary>div:first-child{padding-left:0}
  .dsh-popo-summary>div:last-child{padding-right:0}
  .dsh-popo-summary>div+div{border-left:.5px solid var(--popo-line)}
  .dsh-popo-summary [data-stat="collection"]{grid-area:collection}
  .dsh-popo-summary [data-stat="updated"]{grid-area:updated}
  .dsh-popo-summary [data-stat="sends"]{grid-area:sends}
  .dsh-popo-summary dt{font-size:12px;line-height:18px}
  .dsh-popo-summary dd{font-size:14px;line-height:20px;font-weight:500;font-variant-numeric:tabular-nums}
  .dsh-popo-summary [data-stat="updated"] dd{font-size:13px;font-weight:400;white-space:normal}
  .dsh-popo-note,.dsh-popo-err{margin:0;font-size:12px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap}
  .dsh-popo-note{color:var(--popo-muted)}
  .dsh-popo-err{color:color-mix(in srgb,var(--popo-danger) 75%,var(--popo-text))}
  .dsh-popo-notice,.dsh-popo-note:is([data-tone="ok"],[data-tone="warn"],[data-tone="bad"]){padding:4px 0 4px 10px;border-left:2px solid var(--popo-tone,var(--popo-line));color:var(--popo-text)}
  .dsh-popo-notice>summary{cursor:pointer;overflow-wrap:anywhere}
  .dsh-popo-notice[open]>summary{margin-bottom:8px}
  .dsh-popo-btn{display:inline-flex;align-items:center;justify-content:center;align-self:auto;min-height:32px;padding:4px 12px;border:.5px solid var(--dsw-alias-border-l4,#00000029);border-radius:var(--dsw-radius-md,8px);background:var(--popo-surface);color:inherit;font:inherit;font-weight:500;cursor:pointer;transition:background-color .12s ease,border-color .12s ease,color .12s ease}
  .dsh-popo-btn[data-primary="true"]{background:var(--popo-primary);border-color:var(--popo-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}
  .dsh-popo-btn[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-active,#e8ecf5);color:var(--popo-text)}
  .dsh-popo-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,#2631480f)}
  .dsh-popo-btn:active:enabled{background:var(--dsw-alias-interactive-bg-active,#e8ecf5)}
  .dsh-popo-btn[data-primary="true"]:hover:enabled{background:var(--dsw-alias-button-primary-hover,#43454a)}
  .dsh-popo-btn-compact{min-height:28px;padding:4px 10px;border-radius:var(--dsw-radius-sm,6px);font-size:12px;line-height:18px}
  .dsh-popo-btn[data-quiet="true"]{border-color:transparent;background:transparent;color:var(--popo-muted);font-weight:400}
  .dsh-popo-record-filters{align-self:flex-start;gap:2px;padding:3px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover,#2631480f)}
  .dsh-popo-filter{border-color:transparent;background:transparent;color:var(--popo-muted);font-weight:400}
  .dsh-popo-filter[aria-pressed="true"]{border-color:var(--popo-line);background:var(--popo-surface);color:var(--popo-text);font-weight:500}
  .dsh-popo-record-info{display:flex;flex-direction:column;gap:4px}
  .dsh-popo-monitor-toggle{display:flex;align-items:center;gap:8px;min-height:22px}
  .dsh-popo-switch{position:relative;display:inline-flex;flex:0 0 36px;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3,#bfc0c2);appearance:none;cursor:pointer;transition:background-color .12s ease}
  .dsh-popo-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,var(--popo-primary))}
  .dsh-popo-switch:is([data-unknown="true"],[data-tone="warn"],[data-tone="bad"]){background:var(--dsw-alias-border-l3,#bfc0c2)}
  .dsh-popo-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground,#fff);transform:translateX(0);transition:transform .12s ease}
  .dsh-popo-switch[aria-checked="false"] .dsh-popo-switch-thumb{background:var(--dsw-alias-switch-thumb,#fff)}
  .dsh-popo-switch[aria-checked="true"] .dsh-popo-switch-thumb{transform:translateX(16px)}
  .dsh-popo-switch:hover:enabled{filter:brightness(.96)}
  @media(prefers-reduced-motion:reduce){.dsh-popo-root *{transition:none!important}}
  .dsh-popo-btn:disabled,.dsh-popo-switch:disabled,.dsh-popo-input:disabled,.dsh-popo-check:has(input:disabled){opacity:.55;cursor:default}
  .dsh-popo-btn[data-primary="true"]:disabled{opacity:1;background:var(--dsw-alias-interactive-bg-active,#e9eaec);border-color:transparent;color:var(--popo-muted)}
  .dsh-popo-root :is(button,input,select,textarea,summary):focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}
  .dsh-popo-actions{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px}
  .dsh-popo-hours{display:flex;align-items:center;gap:8px}
  .dsh-popo-hours .dsh-popo-input{width:72px}
  .dsh-popo-remaining{font-variant-numeric:tabular-nums}
  .dsh-popo-form{display:grid;grid-template-columns:minmax(0,1fr);gap:14px 16px}
  .dsh-popo-field{display:flex;flex-direction:column;gap:6px}
  .dsh-popo-wide{grid-column:1 / -1}
  .dsh-popo-check{display:flex;align-items:center;gap:8px}
  .dsh-popo-check input{flex:none;accent-color:var(--popo-primary)}
  .dsh-popo-input{padding:4px 10px;min-height:32px;border:.5px solid var(--dsw-alias-border-l4,#00000029);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;width:100%;transition:border-color .12s ease,background-color .12s ease}
  .dsh-popo-input::placeholder{color:var(--popo-muted);opacity:1}
  .dsh-popo-input:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6)}
  .dsh-popo-input[type="number"]{font-variant-numeric:tabular-nums}
  .dsh-popo-input[readonly]{background:var(--dsw-alias-interactive-bg-hover,#2631480f)}
  select.dsh-popo-input{max-width:100%;text-overflow:ellipsis}
  textarea.dsh-popo-input{resize:vertical}
  .dsh-popo-input[aria-invalid="true"]{border-color:var(--popo-danger)}
  .dsh-popo-settings{display:flex;flex-direction:column;gap:20px}
  .dsh-popo-setting-group{display:flex;flex-direction:column}
  .dsh-popo-setting-group>.dsh-popo-title{padding-bottom:4px;font-size:12px;line-height:18px;font-weight:500;color:var(--popo-muted)}
  .dsh-popo-setting-row{display:grid;grid-template-columns:minmax(0,1fr) 192px;align-items:center;gap:4px 24px;min-height:52px;padding:10px 0}
  .dsh-popo-setting-group>.dsh-popo-note{margin-top:-4px;margin-bottom:4px}
  .dsh-popo-setting-row>label{display:flex;align-items:center;min-height:32px;overflow-wrap:anywhere;cursor:pointer}
  .dsh-popo-setting-row>.dsh-popo-err{grid-column:1 / -1}
  .dsh-popo-setting-control{display:flex;align-items:center;justify-content:flex-end;gap:12px}
  .dsh-popo-setting-control input[type="checkbox"]{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary,var(--popo-primary));cursor:pointer}
  .dsh-popo-setting-control input[type="checkbox"]:disabled{opacity:.55;cursor:default}
  .dsh-popo-setting-input{display:flex;flex:0 1 144px;align-items:center;width:144px;min-height:32px;border:.5px solid var(--dsw-alias-border-l4,#00000029);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);transition:border-color .12s ease}
  .dsh-popo-setting-input:focus-within{border-color:var(--dsw-alias-state-business-primary,#4176e6)}
  .dsh-popo-setting-input:has([aria-invalid="true"]){border-color:var(--popo-danger)}
  .dsh-popo-setting-input:has(:focus-visible){outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}
  .dsh-popo-setting-input>.dsh-popo-input{flex:1;width:0;min-height:30px;border:0;background:transparent;outline:none}
  .dsh-popo-setting-unit{flex:none;padding-right:10px;color:var(--popo-muted);font-size:12px;white-space:nowrap}
  .dsh-popo-setting-input:has(input:disabled){opacity:.55}
  .dsh-popo-setting-input input:disabled{opacity:1}
  .dsh-popo-details{border-top:.5px solid var(--popo-line)}
  .dsh-popo-details>summary{min-height:44px;padding:11px 0;cursor:pointer;overflow-wrap:anywhere}
  .dsh-popo-details[open]>summary{margin-bottom:4px}
  .dsh-popo-details.dsh-popo-section{padding:0}
  .dsh-popo-details.dsh-popo-section>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:54px;padding:16px 0;font-weight:500;list-style:none}
  .dsh-popo-details.dsh-popo-section>summary::-webkit-details-marker{display:none}
  .dsh-popo-details.dsh-popo-section>summary::after{content:"";flex:none;width:7px;height:7px;margin-right:3px;border-right:1.5px solid var(--popo-muted);border-bottom:1.5px solid var(--popo-muted);transform:rotate(45deg)}
  .dsh-popo-details.dsh-popo-section[open]{padding-bottom:24px}
  .dsh-popo-details.dsh-popo-section[open]>summary{margin-bottom:8px}
  .dsh-popo-details.dsh-popo-section[open]>summary::after{transform:rotate(225deg)}
  .dsh-popo-detail-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
  .dsh-popo-detail-card>.dsh-popo-title{padding-bottom:8px;border-bottom:.5px solid var(--popo-line)}
  .dsh-popo-detail-fields{display:grid;gap:12px;margin:0;font-size:13px;line-height:20px}
  .dsh-popo-detail-fields dt{margin-bottom:2px;font-size:12px;line-height:18px}
  .dsh-popo-detail-card[data-section="activity"] .dsh-popo-detail-field{display:grid;grid-template-columns:78px minmax(0,1fr);gap:8px;align-items:start}
  .dsh-popo-diagnostic-tools{border-top:.5px solid var(--popo-line)}
  .dsh-popo-diagnostic-tool{display:flex;flex-direction:column;gap:10px;padding:14px 0}
  .dsh-popo-diagnostic-tool+.dsh-popo-diagnostic-tool{border-top:.5px solid var(--popo-line)}
  .dsh-popo-diagnostic-action{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .dsh-popo-diagnostic-action .dsh-popo-note{margin-top:2px}
  .dsh-popo-diagnostic-action .dsh-popo-btn{flex:none}
  .dsh-popo-cli-result{display:flex;flex-direction:column;gap:6px;padding:4px 0 4px 10px;border-left:2px solid var(--popo-tone,var(--popo-line))}
  .dsh-popo-cli-result-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:4px 12px;font-size:12px;line-height:18px}
  .dsh-popo-cli-result-head time{color:var(--popo-muted);font-variant-numeric:tabular-nums}
  .dsh-popo-cli-result>.dsh-popo-note{padding:0;border:0;border-radius:0;background:transparent;color:var(--popo-text)}
  .dsh-popo-composer{border:.5px solid var(--dsw-alias-border-l4,#00000029);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);transition:border-color .12s ease}
  .dsh-popo-composer:focus-within{border-color:var(--dsw-alias-state-business-primary,#4176e6)}
  .dsh-popo-composer:has(textarea:focus-visible){outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}
  .dsh-popo-manual-text{display:block;height:80px;min-height:80px;padding:10px 12px;border:0;background:transparent}
  .dsh-popo-manual-text:focus-visible{outline:none}
  .dsh-popo-sendbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .dsh-popo-composer>.dsh-popo-sendbar{padding:4px 10px 10px}
  .dsh-popo-sendbar .dsh-popo-btn{flex:none;min-width:60px}
  .dsh-popo-refresh{display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px 12px;padding-top:16px;border-top:.5px solid var(--popo-line);font-variant-numeric:tabular-nums}
  /* 宿主设置区底部留白为 24px；保存栏背景覆盖该留白，避免下方字段透出。 */
  .dsh-popo-savebar{position:sticky;bottom:-24px;z-index:1;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;background:var(--popo-surface);border-top:.5px solid var(--popo-line);padding:12px 0 36px;margin-bottom:-24px}
  .dsh-popo-savebar>.dsh-popo-actions{justify-self:end;flex-wrap:nowrap}
  .dsh-popo-savebar>:is(.dsh-popo-err,[data-dsh-popo-note]){grid-column:1 / -1}
  .dsh-popo-lines{display:flex;flex-direction:column;gap:16px;border-top:.5px solid var(--popo-line);padding-top:16px;font-size:14px;line-height:22px}
  .dsh-popo-line{white-space:pre-wrap;overflow-wrap:anywhere;border-bottom:.5px solid var(--popo-line);padding-bottom:16px}
  .dsh-popo-line:last-child{border-bottom:0;padding-bottom:0}
  .dsh-popo-record-meta{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:4px 12px;margin-bottom:6px;font-size:12px;line-height:18px;color:var(--popo-muted)}
  .dsh-popo-record-author{font-weight:500;color:var(--popo-text)}
  .dsh-popo-record-meta time{font-variant-numeric:tabular-nums}
  .dsh-popo-record-content{margin:0}
  .dsh-popo-record-log{font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:20px}
  .dsh-popo-empty{border-top:.5px solid var(--popo-line);padding:32px 0;text-align:center}
  @container popo (min-width:520px){.dsh-popo-form,.dsh-popo-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @container popo (width < 520px){.dsh-popo-summary{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-areas:"collection sends" "updated updated";row-gap:16px}.dsh-popo-summary [data-stat="updated"]{flex-direction:row;align-items:baseline;gap:12px;border-left:0;border-top:.5px solid var(--popo-line);padding:12px 0 0}.dsh-popo-summary [data-stat="updated"] dd{white-space:normal}.dsh-popo-detail-field{display:grid;grid-template-columns:78px minmax(0,1fr);gap:8px;align-items:start}}
  @container popo (width < 400px){.dsh-popo-sendbar{flex-direction:column;align-items:stretch;gap:8px}.dsh-popo-sendbar .dsh-popo-btn{align-self:flex-end}.dsh-popo-diagnostic-action{flex-wrap:wrap}.dsh-popo-diagnostic-action .dsh-popo-btn{margin-left:auto}}
  @container popo (width < 400px){.dsh-popo-setting-row{grid-template-columns:minmax(0,1fr) min(144px,50%);column-gap:16px}.dsh-popo-control-row{column-gap:16px}}
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
