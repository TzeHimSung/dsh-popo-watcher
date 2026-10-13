export function formatRemaining(seconds) {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) return '—'
  if (seconds <= 0) return '已过期'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分 ${total % 60} 秒`
}

export function runtimeView(snapshot) {
  const value = snapshot.value
  const win = value?.window ?? {}
  const poll = value?.poll ?? {}
  const persistenceError = value?.persistence?.ok === false ? value.persistence.error || '持久化失败' : ''
  // lastError:null 是本实例尚无采集故障；已停止窗口里的错误仅为历史，不重复报当前异常。
  const historicalCollectionError = value?.phase !== 'disposed' && win.stopped === true && poll.running !== true && poll.lastError === null
    ? win.collectionError || '' : ''
  const collectionError = value?.phase === 'disposed' || historicalCollectionError || persistenceError ? '' : win.collectionError || (poll.consecutiveFailures > 0
    ? (poll.lastError || value?.degraded?.reason || '采集失败')
    : value?.degraded?.active === true ? (value.degraded.reason || '采集失败') : '')
  const failureLimit = poll.failureLimit ?? 5
  const recovering = poll.running === true && poll.recovering === true && !(win.remainingSec <= 0 && win.remainingSec != null)
  const limitReached = poll.running !== true && collectionError && poll.consecutiveFailures >= failureLimit
  const collectionStatus = recovering ? `采集重试中（${poll.consecutiveFailures}/${failureLimit}）`
    : limitReached ? `连续失败 ${failureLimit} 次，已停止`
    : collectionError ? (poll.running === true ? '采集失败' : '采集失败，已停止')
    : poll.running === true ? '运行中' : poll.running === false ? (win.stopped === true ? '已停止' : '未运行') : '—'
  const retryText = !recovering ? '' : Number.isFinite(poll.nextRetryAt)
    ? `下次重试：${new Date(poll.nextRetryAt).toLocaleString('zh-CN', { hour12: false })}` : '正在重试…'
  let view = { text: '未开始', tone: 'neutral' }
  if (!value || typeof value.phase !== 'string') view = { text: '状态未知', tone: 'neutral' }
  else if (value.phase === 'disposed') view = { text: '已卸载', tone: 'neutral' }
  else if (persistenceError) view = { text: '记账或存储异常，已暂停', tone: 'bad' }
  else if (win.stopped === true) view = poll.running === true
    ? { text: '已静音', tone: 'warn' } : { text: limitReached ? collectionStatus : collectionError ? '采集异常，已停止' : '已停止', tone: collectionError ? 'bad' : 'neutral' }
  else if (typeof win.remainingSec === 'number' && win.remainingSec <= 0) view = { text: '已到期', tone: 'neutral' }
  else if (recovering) view = { text: collectionStatus, tone: 'warn' }
  else if (collectionError || value.degraded?.active === true || value.phase === 'degraded') view = { text: '采集异常', tone: 'bad' }
  else if (poll.running === true) view = { text: '监控中', tone: 'ok' }
  else if (win.active === true || value.phase === 'running') view = { text: '采集未启动', tone: 'warn' }
  else if (win.startedAt) view = { text: '已停止', tone: 'neutral' }
  const stopped = win.stopped === true && poll.running !== true
  let remaining = stopped ? '已停止' : ['已停止', '已到期', '已卸载', '未开始'].includes(view.text) ? view.text : '—'
  if (!stopped && win.active === true && Number.isFinite(win.remainingSec) && win.remainingSec > 0 && !['已停止', '已卸载'].includes(view.text)) {
    remaining = `剩余 ${formatRemaining(win.remainingSec)}`
  }
  if (snapshot.phase !== 'ready') {
    view = { text: snapshot.phase === 'loading' ? '读取中…' : '连接异常', tone: snapshot.phase === 'error' ? 'bad' : 'neutral' }
    remaining = '—'
  }
  return { ...view, remaining, collectionError, persistenceError, historicalCollectionError, collectionStatus, recovering, retryText }
}

export function clip(text, max) {
  if (typeof text !== 'string' || text === '') return '—'
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function generationModelText(llm) {
  const resolved = llm?.resolved
  if (resolved) {
    const label = resolved.source === 'plugin' ? '插件指定' : '跟随宿主默认'
    return resolved.provider && resolved.model ? `${label}：${resolved.provider} / ${resolved.model}` : `${label}（未提供模型）`
  }
  return llm?.provider && llm?.model ? `插件指定：${llm.provider} / ${llm.model}` : '跟随宿主默认（实际型号待宿主返回）'
}

export function replyStatusText(value = {}) {
  if (value.phase === 'disposed' || value.window?.stopped === true) return '自动回复已停止'
  if (typeof value.window?.remainingSec === 'number' && value.window.remainingSec <= 0) return '自动回复窗口已到期'
  const pending = value.pendingRound
  if (pending?.count > 0) {
    return Number.isFinite(pending.retryAtMs)
      ? `等待冷却：${pending.count} 条待判消息；最早 ${new Date(pending.retryAtMs).toLocaleString('zh-CN', { hour12: false })} 后成功采集时重新判断。`
      : `${pending.count} 条消息待判，将在下一次成功采集后处理。`
  }
  const round = value.round
  if (!round) return '等待新消息'
  if (round.verdict === 'send-blocked') return `发送被拒绝：${round.sendReason || round.reason || '发送条件未满足'}`
  if (round.verdict === 'cancelled') return '本轮已取消'
  if (round.reason === 'model said SKIP') return '模型选择不回复（SKIP）'
  if (String(round.reason).startsWith('draft unavailable:')) return `生成失败：${round.reason.slice('draft unavailable:'.length).trim()}`
  if (round.reason === 'draft empty') return '生成失败：模型没有返回正文'
  if (round.verdict === 'sent') return '本轮回复已发送'
  if (round.verdict === 'dry') return '演练完成，未发送'
  return `本轮不回复：${round.reason || round.verdict || '暂无详情'}`
}
