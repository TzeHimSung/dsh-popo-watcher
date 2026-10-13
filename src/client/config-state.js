export const CONFIG_FIELDS = [
  { key: 'group', path: 'group', label: '群 ID', type: 'text' },
  { key: 'intervalSec', path: 'intervalSec', label: '轮询间隔（秒）', type: 'number', min: 5, max: 600 },
  { key: 'windowHours', path: 'windowHours', label: '默认时长（小时）', type: 'number', min: 1, max: 720 },
  { key: 'minGapSec', path: 'minGapSec', label: '自动发送最小间隔（秒）', type: 'number', min: 5, max: 3600 },
  { key: 'maxChars', path: 'maxChars', label: '自动发送长度提醒（字）', type: 'number', min: 10, max: 500 },
  { key: 'hardMaxChars', path: 'hardMaxChars', label: '自动发送长度上限（字）', type: 'number', min: 20, max: 1000 },
  { key: 'dryRun', path: 'dryRun', label: '自动发送仅演练', type: 'checkbox' },
  { key: 'judgeEnabled', path: 'judge.enabled', label: '使用 TypeSafe 判读', type: 'checkbox' },
  { key: 'hourlyCapEnabled', path: 'hourlyCap.enabled', label: '限制自动发送每小时条数', type: 'checkbox' },
  { key: 'hourlyCapMax', path: 'hourlyCap.max', label: '自动发送每小时最多条数', type: 'number', min: 1, max: 60, enabledBy: 'hourlyCapEnabled' },
  { key: 'openingEnabled', path: 'opening.enabled', label: '开始监控后自动打招呼', type: 'checkbox' },
  { key: 'openingText', path: 'opening.text', label: '开场白', type: 'textarea', enabledBy: 'openingEnabled' },
  { key: 'llmProvider', path: 'llm.provider', type: 'model' },
  { key: 'llmModel', path: 'llm.model', type: 'model' },
  { key: 'judgeModel', path: 'judge.model', type: 'model' },
]

export function configValue(config, path) {
  return path.split('.').reduce((value, key) => value?.[key], config)
}

export function draftOf(config) {
  return Object.fromEntries(CONFIG_FIELDS.map(spec => {
    const value = configValue(config, spec.path)
    return [spec.key, spec.type === 'checkbox' ? value === true : String(value ?? '')]
  }))
}

export function fieldValue(spec, draft) {
  const value = draft[spec.key]
  if (spec.type === 'checkbox') return value === true
  if (spec.type === 'number') return String(value ?? '').trim() === '' ? '' : Number(value)
  return spec.key === 'group' ? String(value ?? '').trim() : String(value ?? '')
}

export function patchOf(draft, baseline) {
  const patch = {}
  for (const spec of CONFIG_FIELDS) {
    if (spec.key === 'llmProvider' || spec.key === 'llmModel') continue
    // 关闭开关仅提交开关，服务端原有的文案、上限值会保留。
    if (spec.enabledBy && draft[spec.enabledBy] !== true) continue
    const value = fieldValue(spec, draft)
    const before = configValue(baseline, spec.path)
    if (Object.is(value, spec.type === 'model' ? String(before ?? '') : before)) continue
    const [parent, child] = spec.path.split('.')
    if (child) {
      patch[parent] ??= {}
      patch[parent][child] = value
    } else patch[parent] = value
  }
  // 提供方和模型是同一项选择，更新或恢复默认时始终成对提交。
  if (draft.llmProvider !== String(baseline?.llm?.provider ?? '') || draft.llmModel !== String(baseline?.llm?.model ?? '')) {
    patch.llm = { provider: draft.llmProvider, model: draft.llmModel }
  }
  return patch
}

export function validateDraft(draft) {
  const errors = {}
  for (const spec of CONFIG_FIELDS) {
    if (spec.enabledBy && draft[spec.enabledBy] !== true) continue
    const value = fieldValue(spec, draft)
    if (spec.type === 'number' && (value === '' || !Number.isFinite(value) || value < spec.min || value > spec.max)) errors[spec.key] = `请输入 ${spec.min}–${spec.max} 之间的数值。`
    if (spec.key === 'group' && !/^\d{3,20}$/.test(value)) errors.group = '请输入 3–20 位数字群 ID。'
    if (spec.type === 'textarea' && (value.trim() === '' || value.length > 200)) errors[spec.key] = '开场白需为 1–200 字。'
  }
  return errors
}

export function configLabel(state, dirty) {
  if (state.phase === 'loading') return '读取中…'
  if (state.phase === 'error') return '配置读取失败'
  if (state.busy) return '保存中…'
  if (state.configState === 'unsaved') return '仅临时生效，尚未保存'
  if (dirty) return '有修改尚未保存'
  if (state.configState === 'default') return '配置缺失，当前使用默认值'
  if (state.configState === 'saved') return '已保存'
  return '保存状态未知'
}
