import { generationModelText } from './runtime.js'
import { CONFIG_FIELDS, configValue, draftOf, fieldValue, configLabel } from './config-state.js'
import { callRpc } from './rpc.js'
export function createSettings(React, { noteLine, useLifetime, useActionFocus }) {
  const h = React.createElement
  function ConfigForm(props) {
    const state = props.state
    const draft = state.draft ?? draftOf(null)
    const disabled = state.phase !== 'ready' || state.busy
    function control(key, unit) {
      const spec = CONFIG_FIELDS.find(field => field.key === key)
      const fieldDisabled = disabled || (props.locked && ['group', 'intervalSec'].includes(spec.key))
      const id = `popo-config-${key}`
      if (spec.type === 'checkbox') return h('input', {
        id, type: 'checkbox', 'data-field': key, checked: draft[key] === true, disabled: fieldDisabled,
        onChange: event => props.onChange(key, event.target.checked === true),
      })
      const inactive = spec.enabledBy && draft[spec.enabledBy] !== true
      const error = state.phase === 'ready' ? props.errors[key] : null
      const input = {
        id, className: 'dsh-popo-input', 'data-field': key,
        'aria-label': key === 'hourlyCapMax' ? spec.label : undefined,
        value: String(draft[key] ?? ''),
        disabled: Boolean(fieldDisabled || inactive),
        'aria-invalid': Boolean(error),
        'aria-describedby': [unit && `popo-unit-${key}`, error && `popo-error-${key}`].filter(Boolean).join(' ') || undefined,
        onChange: event => props.onChange(key, String(event.target.value)),
      }
      if (spec.type === 'textarea') return h('textarea', { ...input, rows: 3, maxLength: 200 })
      const field = h('input', { ...input, type: spec.type, min: spec.min, max: spec.max, step: spec.type === 'number' ? 'any' : undefined })
      return unit ? h('div', { className: 'dsh-popo-setting-input' }, [
        field,
        h('span', { className: 'dsh-popo-setting-unit', id: `popo-unit-${key}` }, unit),
      ]) : field
    }
    function errorLine(key) {
      const error = state.phase === 'ready' ? props.errors[key] : null
      return error ? h('span', { className: 'dsh-popo-err', id: `popo-error-${key}` }, error) : null
    }
    function row(key, label, unit) {
      return h('div', { className: 'dsh-popo-setting-row', key }, [
        h('label', { htmlFor: `popo-config-${key}` }, label),
        h('div', { className: 'dsh-popo-setting-control' }, control(key, unit)),
        errorLine(key),
      ])
    }
    function group(key, title, rows) {
      return h('section', { className: 'dsh-popo-setting-group', key, 'aria-labelledby': `popo-settings-${key}` }, [
        h('h4', { className: 'dsh-popo-title', id: `popo-settings-${key}` }, title),
        ...rows,
      ])
    }
    return h('section', { className: 'dsh-popo-card dsh-popo-section', 'aria-label': '监控与自动发送设置' }, [
      h('div', { className: 'dsh-popo-head', key: 'head' }, [
        h('h3', { className: 'dsh-popo-title' }, '监控与自动发送'),
        h('span', { className: 'dsh-popo-note' }, configLabel(state, props.dirty)),
      ]),
      props.locked ? h('p', { className: 'dsh-popo-note', key: 'lock' }, '群 ID 与轮询间隔在监控期间锁定，请先停止再修改。') : null,
      state.phase === 'error' ? h('div', { className: 'dsh-popo-notice', key: 'error' }, [
        h('p', { className: 'dsh-popo-err' }, '配置读取失败，保存已禁用。修复配置或连接后重新读取。'),
        h('button', { type: 'button', className: 'dsh-popo-btn', 'data-action': '重新读取配置', onClick: props.onReload }, '重新读取配置'),
      ]) : null,
      h('div', { className: 'dsh-popo-settings', key: 'form' }, [
        group('monitor', '监控参数', [
          row('group', '群 ID'),
          row('intervalSec', '轮询间隔', '秒'),
          row('windowHours', '默认时长', '小时'),
        ]),
        group('sending', '自动发送', [
          row('minGapSec', '最小间隔', '秒'),
          row('maxChars', '长度提醒', '字'),
          row('hardMaxChars', '长度上限', '字'),
          row('dryRun', '仅演练'),
          row('judgeEnabled', '使用 TypeSafe 判读'),
          h('p', { className: 'dsh-popo-note', key: 'judge-mode' }, draft.judgeEnabled
            ? '判读不确定时，由生成模型复核是否值得回复。'
            : '由生成模型自行判断是否回复；没有合适内容时保持安静。'),
          h('div', { className: 'dsh-popo-setting-row', key: 'hourlyCap' }, [
            h('label', { htmlFor: 'popo-config-hourlyCapEnabled' }, '限制每小时条数'),
            h('div', { className: 'dsh-popo-setting-control' }, [control('hourlyCapMax', '条/小时'), control('hourlyCapEnabled')]),
            errorLine('hourlyCapMax'),
          ]),
        ]),
        group('opening', '开场白', [
          row('openingEnabled', '开始监控后自动打招呼'),
          h('div', { className: 'dsh-popo-field', key: 'openingText', hidden: draft.openingEnabled !== true }, [
            h('label', { className: 'dsh-popo-sr', htmlFor: 'popo-config-openingText' }, '开场白内容'),
            control('openingText'),
            errorLine('openingText'),
          ]),
        ]),
      ]),
      Array.isArray(state.warnings) && state.warnings.length ? h('details', { className: 'dsh-popo-details', key: 'warnings' }, [
        h('summary', null, `配置详情（${state.warnings.length} 条）`),
        h('p', { className: 'dsh-popo-note' }, state.warnings.join('\n')),
      ]) : null,
    ])
  }

  function ModelSettings(props) {
    const { state, models } = props
    const draft = state.draft ?? draftOf(null)
    const disabled = state.phase !== 'ready' || state.busy
    const loading = models.llm.phase === 'loading' || models.judge.phase === 'loading'
    const providers = models.llm.value?.providers ?? []
    const judgeModels = models.judge.value?.models ?? []
    const selection = (provider, model) => provider === '' && model === '' ? '' : JSON.stringify([provider, model])
    const selected = selection(draft.llmProvider, draft.llmModel)
    const found = providers.some(provider => provider.id === draft.llmProvider && provider.models.some(model => model.id === draft.llmModel))
    const judgeFound = judgeModels.some(model => model.id === draft.judgeModel)
    const defaultModel = models.llm.value?.defaultSelection
    const currentLabel = phase => phase === 'idle' || phase === 'loading' ? '当前配置' : '当前配置，列表未返回'
    function selectGeneration(event) {
      if (disabled || models.llm.phase !== 'ready') return
      const value = String(event.target.value)
      if (value === '') return props.onGenerationChange('', '')
      for (const provider of providers) {
        const model = provider.models.find(model => selection(provider.id, model.id) === value)
        if (model) { props.onGenerationChange(provider.id, model.id); return }
      }
    }
    return h('section', { className: 'dsh-popo-card dsh-popo-section', 'aria-label': '模型设置' }, [
      h('div', { className: 'dsh-popo-head', key: 'head' }, [
        h('h3', { className: 'dsh-popo-title' }, '模型设置'),
        h('button', { className: 'dsh-popo-btn dsh-popo-btn-compact', type: 'button', 'data-action': '刷新模型列表', disabled: loading || state.busy,
          onClick: () => { if (!loading && !state.busy) props.onRefresh() } }, loading ? '读取模型中…' : '刷新模型列表'),
      ]),
      h('div', { className: 'dsh-popo-form', key: 'fields' }, [
        h('label', { className: 'dsh-popo-field dsh-popo-wide', key: 'llm' }, [
          h('span', { className: 'dsh-popo-k' }, '生成回复模型'),
          h('select', { className: 'dsh-popo-input', 'data-field': 'llmSelection', value: selected,
            disabled: disabled || models.llm.phase !== 'ready', onChange: selectGeneration }, [
            h('option', { value: '', key: 'default' }, `跟随宿主默认${defaultModel ? `（${defaultModel.provider} / ${defaultModel.model}）` : ''}`),
            selected && !found ? h('option', { value: selected, disabled: true, key: 'current' }, `${draft.llmProvider} / ${draft.llmModel}（${currentLabel(models.llm.phase)}）`) : null,
            ...providers.map(provider => h('optgroup', { label: provider.name, key: provider.id }, provider.models.map(model => h('option', {
              value: selection(provider.id, model.id), key: model.id,
            }, model.name === model.id ? model.id : `${model.name}（${model.id}）`)))),
          ]),
          h('span', { className: 'dsh-popo-note' }, `已生效：${generationModelText(props.snapshot.value?.llm ?? state.baseline?.llm)}`),
          h('span', { className: 'dsh-popo-note' }, '使用宿主模型上限，插件不设置 token 预算或推理总时限。'),
          models.llm.error ? h('span', { className: 'dsh-popo-err', role: 'status' }, models.llm.error) : null,
          ...providers.filter(provider => provider.error).map(provider => h('span', { className: 'dsh-popo-err', key: provider.id }, `${provider.name}：${provider.error}`)),
          models.llm.phase === 'ready' && !providers.some(provider => provider.models.length)
            ? h('span', { className: 'dsh-popo-note' }, '目录中没有可选生成模型，可在宿主模型设置中配置后刷新。') : null,
        ]),
        h('label', { className: 'dsh-popo-field dsh-popo-wide', key: 'judge' }, [
          h('span', { className: 'dsh-popo-k' }, 'TypeSafe 判读模型'),
          h('select', { className: 'dsh-popo-input', 'data-field': 'judgeModel', value: draft.judgeModel,
            disabled: disabled || models.judge.phase !== 'ready' || judgeModels.length === 0,
            onChange: event => {
              if (!disabled && models.judge.phase === 'ready' && judgeModels.some(model => model.id === event.target.value)) props.onChange('judgeModel', event.target.value)
            } }, [
            !judgeFound ? h('option', { value: draft.judgeModel, disabled: true, key: 'current' }, draft.judgeModel ? `${draft.judgeModel}（${currentLabel(models.judge.phase)}）` : '请选择判读模型') : null,
            ...judgeModels.map(model => h('option', { value: model.id, key: model.id }, model.name)),
          ]),
          h('span', { className: 'dsh-popo-note' }, state.baseline?.judge?.enabled === false
            ? 'TypeSafe 判读已停用，由生成模型自行判断。' : `已生效：${state.baseline?.judge?.model || '未提供模型'}`),
          models.judge.error ? h('span', { className: 'dsh-popo-err', role: 'status' }, models.judge.error) : null,
          models.judge.phase === 'ready' && judgeModels.length === 0 ? h('span', { className: 'dsh-popo-note' }, 'TypeSafe 未返回可选模型。') : null,
        ]),
      ]),
      h('p', { className: 'dsh-popo-note', key: 'note' }, '选择后点击底部“保存配置”。后续新请求使用新模型，正在进行的请求继续完成。'),
    ])
  }

  function keySourceText(source) {
    if (source === 'file') return '设置页'
    if (source === 'env') return '环境变量'
    if (source === 'user-env') return '用户环境变量'
    if (source === 'explicit') return '调用方传入'
    return '未配置'
  }

  function KeyForm(props) {
    const connection = props.connection
    const onDone = props.onDone
    const [state, setState] = React.useState({ phase: 'loading', status: null, note: null, busy: false })
    const [draft, setDraft] = React.useState('')
    const life = useLifetime(connection)

    React.useEffect(() => {
      let alive = true
      setDraft('')
      setState({ phase: 'loading', status: null, note: null, busy: false })
      void (async () => {
        const result = await callRpc(connection, 'key.status', {})
        if (!alive) return
        if (result.ok !== true) {
          setState({ phase: 'error', status: null, note: { tone: 'bad', text: `读取 key 状态失败：${result.text}` }, busy: false })
          return
        }
        setState({ phase: 'ready', status: result.value ?? {}, note: null, busy: false })
      })()
      return () => { alive = false }
    }, [connection])

    async function save() {
      const token = life.current
      if (!token?.active || token.busy || draft.trim() === '') return
      token.busy = true
      setState((prev) => ({ ...prev, busy: true, note: null }))
      const result = await callRpc(connection, 'key.set', { key: draft })
      if (!token.active) return
      token.busy = false
      if (result.ok !== true) {
        setState((prev) => ({ ...prev, busy: false, note: { tone: 'bad', text: `保存失败：${result.text}` } }))
        return
      }
      // 存完立刻把输入框里的明文清掉：页面上不再留 key。
      setDraft('')
      setState({
        phase: 'ready',
        status: { configured: result.value?.configured === true, source: result.value?.source ?? 'file', stored: true },
        note: { tone: 'ok', text: '已保存（页面不会再显示它）' },
        busy: false,
      })
      if (typeof onDone === 'function') onDone()
    }

    async function clear() {
      const token = life.current
      if (!token?.active || token.busy || state.status?.stored !== true) return
      token.busy = true
      setState((prev) => ({ ...prev, busy: true, note: null }))
      const result = await callRpc(connection, 'key.clear', {})
      if (!token.active) return
      token.busy = false
      if (result.ok !== true) {
        setState((prev) => ({ ...prev, busy: false, note: { tone: 'bad', text: `清除失败：${result.text}` } }))
        return
      }
      const value = result.value ?? {}
      setState({
        phase: 'ready',
        status: value,
        note: {
          tone: 'ok',
          text: value.configured === true
            ? `已清除本地凭证（仍配置了${keySourceText(value.source)}来源）`
            : '已清除，当前未配置凭证',
        },
        busy: false,
      })
      if (typeof onDone === 'function') onDone()
    }

    const status = state.status
    const statusText = status === null
      ? (state.phase === 'loading' ? '读取中…' : '—')
      : status.configured === true
        ? `已配置（来源：${keySourceText(status.source)}）`
        : '未配置'

    return h('section', { className: 'dsh-popo-card dsh-popo-section', 'aria-label': '判读凭证' }, [
      h('div', { className: 'dsh-popo-head', key: 'head' }, [
        h('h3', { className: 'dsh-popo-title', key: 'title' }, '判读凭证'),
        h('span', { className: 'dsh-popo-badge', 'data-tone': status?.configured === true ? 'ok' : 'warn', key: 'badge' }, statusText),
      ]),
      h('label', { className: 'dsh-popo-field', key: 'key' }, [
        h('span', { className: 'dsh-popo-k' }, '本地凭证（保存到本机，不回显）'),
        h('input', {
          className: 'dsh-popo-input',
          'data-field': 'judge-key',
          type: 'password',
          autoComplete: 'off',
          value: draft,
          disabled: state.busy,
          onChange: (event) => setDraft(String(event?.target?.value ?? '')),
        }),
      ]),
      h('div', { className: 'dsh-popo-actions', key: 'actions' }, [
        h('button', {
          className: 'dsh-popo-btn',
          type: 'button',
          'data-action': '保存 key',
          disabled: state.busy === true || draft.trim() === '',
          onClick: () => { void save() },
        }, state.busy === true ? '处理中…' : '保存本地凭证'),
        h('button', {
          className: 'dsh-popo-btn',
          type: 'button',
          'data-action': '清除 key',
          disabled: state.busy === true || status?.stored !== true,
          onClick: () => { void clear() },
        }, '清除本地凭证'),
      ]),
      noteLine(state.note),
      h('p', { className: 'dsh-popo-note', key: 'verified' }, '已配置仅表示找到凭证，不代表已验证服务可用。'),
      h('p', { className: 'dsh-popo-note', key: 'tip' }, '本地副本保存在 <数据根>/secret.json；清除本地凭证不会删除环境变量。'),
    ])
  }

  function ImportCard(props) {
    const connection = props.connection
    const onDone = props.onDone
    const [from, setFrom] = React.useState('')
    const [state, setState] = React.useState({ busy: false, note: null })
    const life = useLifetime(connection)
    React.useEffect(() => { setState({ busy: false, note: null }) }, [connection])

    async function run() {
      const token = life.current
      if (!token?.active || token.busy || from.trim() === '') return
      token.busy = true
      setState({ busy: true, note: null })
      const result = await callRpc(connection, 'importLegacy', { from })
      if (!token.active) return
      token.busy = false
      if (result.ok !== true) {
        setState({ busy: false, note: { tone: 'bad', text: `导入失败：${result.text}` } })
        return
      }
      const value = result.value ?? {}
      const imported = Object.keys(value.imported ?? {})
      const skipped = Object.entries(value.skipped ?? {})
      const parts = [`导入完成（源：${value.from ?? from}）`]
      parts.push(imported.length > 0 ? `已补：${imported.join('、')}` : '已补：无')
      if (skipped.length > 0) parts.push(`跳过：${skipped.map(([key, why]) => `${key}（${why}）`).join('；')}`)
      setState({ busy: false, note: { tone: skipped.length > 0 ? 'warn' : 'ok', text: parts.join('｜') } })
      if (typeof onDone === 'function') onDone()
    }

    return h('section', { className: 'dsh-popo-card dsh-popo-section', 'aria-label': '历史数据导入' }, [
      h('div', { className: 'dsh-popo-head', key: 'head' }, [
        h('h3', { className: 'dsh-popo-title', key: 'title' }, '历史数据导入'),
        h('span', { className: 'dsh-popo-badge', key: 'badge' }, '只补缺，不覆盖'),
      ]),
      h('label', { className: 'dsh-popo-field', key: 'from' }, [
        h('span', { className: 'dsh-popo-k' }, '来源目录'),
        h('input', {
          className: 'dsh-popo-input',
          'data-field': 'legacy-from',
          type: 'text',
          value: from,
          disabled: state.busy,
          onChange: (event) => setFrom(String(event?.target?.value ?? '')),
        }),
      ]),
      h('div', { className: 'dsh-popo-actions', key: 'actions' }, h('button', {
        className: 'dsh-popo-btn',
        type: 'button',
        'data-action': '导入历史',
        disabled: state.busy === true || from.trim() === '',
        onClick: () => { void run() },
      }, state.busy === true ? '导入中…' : '导入历史')),
      noteLine(state.note),
      h('p', { className: 'dsh-popo-note', key: 'tip' }, '导入不会开始监控；完成后在概览中手动开始。'),
    ])
  }
  return { ConfigForm, ModelSettings, KeyForm, ImportCard }
}
