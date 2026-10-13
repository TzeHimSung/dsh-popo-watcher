import { POLL_MS } from './constants.js'
import { callRpc } from './rpc.js'
import { draftOf, patchOf, validateDraft } from './config-state.js'
export function createPanelState(React, { useLifetime }) {
  return function usePanelState(connection) {
    const [tab, setTab] = React.useState('overview')
    const [snapshot, setSnapshot] = React.useState({ phase: 'loading', value: null, error: null, at: null })
    const [settings, setSettings] = React.useState({ phase: 'loading', baseline: null, draft: null, configState: undefined, warnings: [], busy: false, note: null })
    const [models, setModels] = React.useState({ llm: { phase: 'idle', value: null, error: null }, judge: { phase: 'idle', value: null, error: null } })
    const modelRead = React.useRef({ llm: 0, judge: 0 })
    const modelsLoaded = React.useRef(false)
    const refresh = React.useRef(() => {})
    const configRead = React.useRef(0)
    const saving = React.useRef(false)
    const life = useLifetime(connection)

    React.useEffect(() => {
      let active = true
      let pending = null
      let refreshQueued = false
      setSnapshot({ phase: 'loading', value: null, error: null, at: null })
      function tick(force = false) {
        if (!active) return
        if (pending) {
          if (force) refreshQueued = true
          return pending
        }
        pending = (async () => {
          do {
            refreshQueued = false
            const result = await callRpc(connection, 'status', {})
            if (active && !refreshQueued) {
              const valid = result.ok && result.value && typeof result.value === 'object' && !Array.isArray(result.value)
                && typeof result.value.phase === 'string' && result.value.window && typeof result.value.window === 'object'
                && result.value.poll && typeof result.value.poll === 'object'
              setSnapshot(previous => valid
                ? { phase: 'ready', value: result.value, error: null, at: new Date().toLocaleTimeString() }
                : { ...previous, phase: 'error', error: result.ok ? '宿主未返回有效状态' : result.text })
            }
          } while (active && refreshQueued)
        })().finally(() => { pending = null })
        return pending
      }
      refresh.current = () => tick(true)
      void tick()
      const timer = setInterval(() => { void tick() }, POLL_MS)
      return () => { active = false; clearInterval(timer) }
    }, [connection])

    async function loadConfig(reload = false) {
      const token = life.current
      if (!token?.active || saving.current) return
      const request = ++configRead.current
      setSettings(previous => ({ ...previous, phase: 'loading', note: null }))
      const result = await callRpc(connection, 'config.get', reload ? { reload: true } : {})
      if (!token.active || request !== configRead.current) return
      const value = result.value ?? {}
      if (!result.ok || !value.config || typeof value.config !== 'object' || Array.isArray(value.config)) {
        setSettings(previous => ({ ...previous, phase: 'error', busy: false, note: { tone: 'bad', text: `读取配置失败：${result.ok ? '宿主未返回有效配置' : result.text}` } }))
        return
      }
      setSettings({
        phase: value.configState === 'error' ? 'error' : 'ready',
        baseline: value.config,
        draft: draftOf(value.config),
        configState: value.configState,
        warnings: Array.isArray(value.warnings) ? value.warnings : [],
        busy: false,
        note: null,
      })
      setSnapshot(previous => previous.value ? { ...previous, value: { ...previous.value, group: value.config.group } } : previous)
      if (reload) refresh.current()
    }

    React.useEffect(() => {
      saving.current = false
      setSettings({ phase: 'loading', baseline: null, draft: null, configState: undefined, warnings: [], busy: false, note: null })
      void loadConfig()
    }, [connection])

    async function loadModels(scope = 'all') {
      const token = life.current
      if (!token?.active) return
      const kinds = scope === 'judge' ? ['judge'] : ['llm', 'judge']
      const requests = Object.fromEntries(kinds.map(kind => [kind, ++modelRead.current[kind]]))
      setModels(previous => ({ ...previous, ...Object.fromEntries(kinds.map(kind => [kind, { ...previous[kind], phase: 'loading', error: null }])) }))
      const result = await callRpc(connection, 'models.list', scope === 'judge' ? { scope: 'judge' } : {})
      if (!token.active) return
      setModels(previous => {
        const next = { ...previous }
        for (const kind of kinds) {
          if (requests[kind] !== modelRead.current[kind]) continue
          const value = result.value?.[kind]
          const entries = kind === 'llm' ? value?.providers : value?.models
          const valid = Array.isArray(entries) && entries.every(entry => entry && typeof entry.id === 'string' && entry.id.trim() && typeof entry.name === 'string' && entry.name.trim()
            && (kind !== 'llm' || Array.isArray(entry.models) && entry.models.every(model => model && typeof model.id === 'string' && model.id.trim() && typeof model.name === 'string' && model.name.trim())))
          next[kind] = result.ok && value?.ok === true && valid
            ? { phase: 'ready', value, error: null }
            : { ...previous[kind], phase: 'error', error: !result.ok ? result.text : String(value?.error ?? '宿主未返回有效模型列表') }
        }
        return next
      })
    }

    React.useEffect(() => {
      modelsLoaded.current = false
      setModels({ llm: { phase: 'idle', value: null, error: null }, judge: { phase: 'idle', value: null, error: null } })
    }, [connection])
    React.useEffect(() => {
      if (tab === 'settings' && !modelsLoaded.current) {
        modelsLoaded.current = true
        void loadModels()
      }
    }, [tab, connection])

    const win = snapshot.value?.window ?? {}
    const locked = snapshot.phase !== 'ready' || snapshot.value?.poll?.running === true || (win.active === true && win.stopped !== true)
    const patch = settings.baseline && settings.draft ? patchOf(settings.draft, settings.baseline) : {}
    const dirty = Object.keys(patch).length > 0
    const errors = settings.draft ? validateDraft(settings.draft) : {}
    const invalid = Object.keys(errors).length > 0
    const hasUnpersisted = settings.configState === 'unsaved'
    const configChangedWhileLocked = locked && (Object.hasOwn(patch, 'group') || Object.hasOwn(patch, 'intervalSec'))
    const blocked = settings.phase !== 'ready'
      ? '请先在设置中完成配置读取。'
      : settings.busy ? '配置正在保存，请稍候。'
      : hasUnpersisted ? '配置仅临时生效，请先重试保存。'
      : dirty ? '有未保存的参数，请先保存或撤销修改。'
      : invalid ? '请先修正设置中的无效参数。'
      : snapshot.value?.configState === 'error' ? '宿主配置读取异常，请在设置中重新读取。'
      : ''
    const canSave = settings.phase === 'ready' && !settings.busy && !invalid && !configChangedWhileLocked
      && (dirty || settings.configState !== 'saved')
    const savedNote = settings.configState === 'saved' && !dirty && !settings.busy && settings.note?.tone !== 'bad' ? settings.note : null

    function changeField(key, value) {
      if (locked && ['group', 'intervalSec'].includes(key)) return
      setSettings(previous => previous.phase !== 'ready' || previous.busy ? previous : {
        ...previous, draft: { ...previous.draft, [key]: value }, note: null,
      })
    }

    function changeGeneration(provider, model) {
      setSettings(previous => previous.phase !== 'ready' || previous.busy ? previous : {
        ...previous, draft: { ...previous.draft, llmProvider: provider, llmModel: model }, note: null,
      })
    }

    async function saveConfig(mentionValue) {
      const token = life.current
      const mentionOnly = typeof mentionValue === 'boolean'
      if (!token?.active || saving.current || (mentionOnly ? settings.phase !== 'ready' || settings.busy : !canSave)) return
      saving.current = true
      setSettings(previous => ({ ...previous, busy: true, note: null }))
      const result = await callRpc(connection, 'config.set', { patch: mentionOnly ? { replyOnlyWhenMentioned: mentionValue } : patch })
      if (!token.active) return
      saving.current = false
      const value = result.value ?? {}
      if (!result.ok || !value.config || typeof value.config !== 'object' || Array.isArray(value.config)
        || (mentionOnly && typeof value.config.replyOnlyWhenMentioned !== 'boolean')) {
        setSettings(previous => ({ ...previous, busy: false, note: { scope: mentionOnly ? 'mentions' : 'settings', tone: 'bad', text: `保存失败：${result.ok ? '宿主未返回有效配置' : result.text}` } }))
        return
      }
      const written = value.written
      setSettings(previous => ({
        ...previous,
        baseline: value.config,
        draft: !mentionOnly && written === true ? draftOf(value.config) : previous.draft,
        configState: written === true ? 'saved' : written === false ? 'unsaved' : undefined,
        warnings: Array.isArray(value.warnings) ? value.warnings : [],
        busy: false,
        note: {
          scope: mentionOnly ? 'mentions' : 'settings',
          tone: written === true ? (value.warnings?.length ? 'warn' : 'ok') : 'warn',
          text: written === true ? '配置已保存' : written === false ? '仅临时生效，尚未保存。请重试保存。' : '宿主未确认持久化状态，请重新保存确认。',
        },
      }))
      setSnapshot(previous => previous.value ? { ...previous, value: { ...previous.value, group: value.config.group, replyOnlyWhenMentioned: value.config.replyOnlyWhenMentioned === true } } : previous)
      refresh.current()
    }

    return { tab, setTab, snapshot, settings, models, refresh, loadConfig, loadModels, dirty, errors, locked, blocked, canSave, savedNote, changeField, changeGeneration, saveConfig, setSettings, hasUnpersisted, configChangedWhileLocked }
  }
}
