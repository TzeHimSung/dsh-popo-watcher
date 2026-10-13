import { clip, generationModelText, replyStatusText } from './runtime.js'
import { callRpc } from './rpc.js'
export function createOverview(React, { noteLine, useLifetime, useActionFocus }) {
  const h = React.createElement
  function StatusCard(props) {
    const state = props.snapshot
    const value = state.value ?? {}
    const poll = value.poll ?? {}
    const sends = value.sends ?? {}
    const collectionError = props.view.collectionError
    // 只拆分显示，不解析时区，也不省略日期，避免昨天的采集看起来像刚刚发生。
    const updatedAt = typeof poll.updatedAt === 'string'
      ? poll.updatedAt.replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/, '$1\n$2') : '暂无记录'
    const summary = [
      ['collection', '采集状态', props.view.collectionStatus],
      ['updated', '最近采集', updatedAt],
      ['sends', '累计发言', sends.count === undefined ? '—' : `${sends.count} 条`],
    ]
    return h('section', { className: 'dsh-popo-card', 'aria-label': '运行状态' }, [
      state.phase === 'error' ? h('div', { className: 'dsh-popo-notice dsh-popo-card', 'data-tone': 'bad', key: 'stale' }, [
        h('p', { className: 'dsh-popo-note', role: 'alert' }, state.value ? '连接异常：以下为最后成功快照，可能已过期。' : '运行状态不可用。'),
        h('details', { key: 'detail' }, [h('summary', null, '错误详情'), h('p', { className: 'dsh-popo-note' }, state.error)]),
        h('div', { className: 'dsh-popo-actions' }, h('button', { className: 'dsh-popo-btn', type: 'button', onClick: props.onRefresh }, '重试读取状态')),
      ]) : null,
      h('dl', { className: 'dsh-popo-summary', key: 'summary', 'aria-label': state.phase === 'error' ? '运行摘要（缓存）' : '运行摘要' }, summary.map(([id, label, text]) => h('div', { key: id, 'data-stat': id }, [h('dt', { className: 'dsh-popo-k' }, label), h('dd', { className: 'dsh-popo-v' }, text)]))),
      props.view.retryText ? h('p', { className: 'dsh-popo-note', key: 'retry-at' }, props.view.retryText) : null,
      state.value ? h('p', { className: 'dsh-popo-note', key: 'reply-status', role: 'status', 'aria-label': '自动回复状态' }, replyStatusText(value)) : null,
      collectionError ? noteLine({ key: 'collection-error', tone: props.view.recovering ? 'warn' : 'bad', text: collectionError }) : null,
      state.value && !value.selfUid ? h('p', { className: 'dsh-popo-note', key: 'identity' }, '尚未识别本账号，自动发言暂不可用。') : null,
    ])
  }

  function RuntimeDetails(props) {
    const value = props.snapshot.value ?? {}
    const win = value.window ?? {}
    const poll = value.poll ?? {}
    const sends = value.sends ?? {}
    const judge = value.judge ?? {}
    const llm = value.llm ?? {}
    const activity = [
      ['上次发言', sends.lastSendAt ?? '—'],
      ['上次内容', clip(sends.lastSendContent, 120)],
    ]
    if (win.stopped === true && win.stoppedReason) activity.push(['停止原因', win.stoppedReason])
    if (value.round) activity.push(['最近判读', `${value.round.at ?? '—'} ${replyStatusText({ round: value.round })}`])
    if (value.round?.decisionSource) activity.push(['判断来源', value.round.decisionSource === 'llm' ? '生成模型自行判断' : 'TypeSafe'])
    if (value.round?.model) activity.push(['本轮生成模型', value.round.model])
    if (value.round?.finishReason) activity.push(['生成结束原因', value.round.finishReason])
    if (Array.isArray(value.errors) && value.errors.length) activity.push(['最近错误', value.errors.map(entry => `${entry?.at ?? ''} ${entry?.message ?? ''}`).join('\n')])
    const groups = [
      ['runtime', '运行信息', [
        ['群 ID', value.group ?? '—'],
        ['本账号', value.selfUid || '尚未识别'],
        ['窗口截止', win.endsAt ?? '—'],
        ['轮询', `${poll.intervalSec ?? '—'} 秒/次 · 累计采集 ${poll.watchedMsgs ?? '—'} 条\n滞后 ${poll.lagSec ?? '—'} 秒`],
        ['待判消息', value.pendingRound ? `${value.pendingRound.count} 条` : '—'],
        ['传输', value.transport?.ok === true ? '可用' : `不可用：${value.transport?.error ?? '未接入'}`],
      ]],
      ['models', '模型与发送', [
        ['判读', judge.enabled === true ? `${judge.model ?? '—'}\n不确定时交给生成模型复核；不可用时${judge.unavailablePolicy === 'llm' ? '交给模型' : '保持静默'}` : '由生成模型自行判断'],
        ['生成模型', generationModelText(llm)],
        ['生成上限', '使用宿主模型上限'],
        ['自动发送演练', value.dryRun === true ? '已开启，自动消息不发送' : '未开启'],
        ['持久化', value.persistence?.ok === false ? value.persistence.error || '异常，自动监控已暂停' : '正常'],
      ]],
      ['activity', '最近活动', activity],
    ]
    return h('details', { className: 'dsh-popo-details', 'aria-label': '运行详情与诊断' }, [
      h('summary', null, '运行详情与诊断'),
      h('div', { className: 'dsh-popo-card' }, [
        props.snapshot.phase === 'error' ? h('p', { className: 'dsh-popo-note', key: 'cache' }, '以下详情为缓存，可能已过期。') : null,
        props.view?.collectionError ? noteLine({ key: 'collection-error', tone: props.view.recovering ? 'warn' : 'bad', text: `采集异常：${props.view.collectionError}` }) : null,
        props.view?.historicalCollectionError ? noteLine({ key: 'collection-history', tone: 'neutral', collapsible: true,
          text: `上次采集故障（历史记录，${win.stoppedAt ?? '时间未知'}）：${props.view.historicalCollectionError}` }) : null,
        h('div', { className: 'dsh-popo-detail-grid', key: 'groups' }, groups.map(([id, title, rows]) => h('section', {
          className: `dsh-popo-card dsh-popo-detail-card${id === 'activity' ? ' dsh-popo-wide' : ''}`, 'data-section': id, 'aria-label': title, key: id,
        }, [
          h('h3', { className: 'dsh-popo-title', key: 'title' }, title),
          h('dl', { className: 'dsh-popo-detail-fields', key: 'fields' }, rows.map(([label, text]) => h('div', { className: 'dsh-popo-detail-field', key: label }, [
            h('dt', { className: 'dsh-popo-k' }, label), h('dd', { className: 'dsh-popo-v' }, String(text)),
          ]))),
        ]))),
        h('div', { className: 'dsh-popo-diagnostic-tools', key: 'tools', 'aria-label': '诊断工具' }, [
          h(CliCheck, { key: value.transport?.cliPath || 'cli-check', connection: props.connection }),
          h(JudgeControl, { key: 'judge', connection: props.connection }),
        ]),
      ]),
    ])
  }

  function CliCheck({ connection }) {
    const [busy, setBusy] = React.useState(false)
    const [note, setNote] = React.useState(null)
    const life = useLifetime(connection)
    const rememberFocus = useActionFocus(busy, connection)
    React.useEffect(() => { setBusy(false); setNote(null) }, [connection])

    async function check(event) {
      const token = life.current
      if (!token?.active || token.busy) return
      rememberFocus(event)
      token.busy = true
      setBusy(true)
      setNote(null)
      const result = await callRpc(connection, 'cli.check', {})
      if (!token.active) return
      token.busy = false
      setBusy(false)
      const value = result.value
      const at = new Date().toLocaleTimeString()
      if (!result.ok || typeof value?.healthy !== 'boolean' || typeof value?.message !== 'string' || !value.message.trim()) {
        setNote({ tone: 'bad', title: '检查失败', at, text: `检查失败：${result.ok ? '宿主未返回有效检查结果' : result.text}` })
        return
      }
      setNote({ tone: value.healthy ? 'ok' : 'bad', title: value.healthy ? 'CLI 启动、登录正常' : 'CLI 检查异常', at, text: value.message })
    }

    return h('section', { className: 'dsh-popo-diagnostic-tool', 'aria-label': 'POPO CLI 检查', 'aria-busy': busy }, [
      h('div', { className: 'dsh-popo-diagnostic-action', key: 'action' }, [
        h('div', { key: 'description' }, [h('h3', { className: 'dsh-popo-title' }, 'POPO CLI'), h('p', { className: 'dsh-popo-note' }, '检查启动与登录状态')]),
        h('button', { className: 'dsh-popo-btn', type: 'button', 'data-action': '检查 POPO CLI', disabled: busy, onClick: event => { void check(event) } }, busy ? '检查中…' : '检查 POPO CLI'),
      ]),
      note ? h('div', { className: 'dsh-popo-cli-result', key: 'result', 'data-tone': note.tone }, [
        h('div', { className: 'dsh-popo-cli-result-head', key: 'head' }, [h('span', null, note.title), h('time', null, `检查于 ${note.at}`)]),
        noteLine({ ...note, collapsible: true }),
      ]) : null,
    ])
  }

  function Controls(props) {
    const connection = props.connection
    const onDone = props.onDone
    const [hoursOverride, setHours] = React.useState(null)
    const [busy, setBusy] = React.useState(null)
    const [note, setNote] = React.useState(null)
    const life = useLifetime(connection)
    const focusAfterAction = React.useRef(null)
    const mentionSettings = props.settings
    const mentionChecked = mentionSettings.baseline?.replyOnlyWhenMentioned === true
    const mentionBusy = mentionSettings.busy
    const mentionDisabled = mentionSettings.phase !== 'ready' || mentionBusy || props.snapshot.value?.phase === 'disposed'
    const rememberMentionFocus = useActionFocus(mentionBusy, connection)
    const hours = hoursOverride ?? (props.defaultHours == null ? '' : String(props.defaultHours))
    const snapshot = props.snapshot
    const win = snapshot.value?.window ?? {}
    const poll = snapshot.value?.poll ?? {}
    const view = props.view
    const duplicateCollectionError = snapshot.phase === 'ready' && Boolean(view.collectionError)
      && (note?.errorText === view.collectionError || note?.errorText === `采集失败，已自动停止：${view.collectionError}`)
    const validHours = hours.trim() !== '' && Number.isFinite(Number(hours)) && Number(hours) >= 1 && Number(hours) <= 720
    const blocked = props.blocked || (snapshot.phase !== 'ready' ? '请先确认运行状态。' : '')
    const monitoring = poll.running === true || (win.active === true && win.stopped !== true)
    const shouldStop = snapshot.phase === 'error' || monitoring
    const checked = monitoring && snapshot.value?.phase !== 'disposed'
    const label = shouldStop ? '停止' : '开始'
    const switchState = busy !== null ? `${busy}中…` : snapshot.phase === 'loading' ? '读取中…'
      : snapshot.phase === 'error' ? '状态未知' : checked ? '已开启' : '已关闭'
    const disabled = snapshot.phase === 'loading' || snapshot.value?.phase === 'disposed'
      || (!shouldStop && (Boolean(blocked) || !validHours))
    const hint = snapshot.phase === 'error' ? '状态未知，可尝试停止监控。'
      : view.persistenceError ? `${view.persistenceError}；修复后可重新开启监控，已确认消息不会重发。`
      : view.collectionError && !monitoring ? '采集异常，监控已关闭；排查后可重新开启。'
      : view.historicalCollectionError ? '当前未采集；上次停止原因见运行详情。'
      : view.recovering ? '采集异常，正在自动重试；自动发言暂停。'
      : win.stopped === true && poll.running === true ? '采集继续，自动发言暂停。'
      : monitoring ? '停止会同时停止采集和自动发言。'
      : `${hoursOverride === null ? (props.configState === 'saved' ? '使用已保存默认时长' : '使用当前默认时长') : '本次临时时长，不修改默认配置'} · ${props.openingEnabled ? '开始时自动打招呼' : '自动打招呼已关闭'}`

    React.useEffect(() => { focusAfterAction.current = null; setHours(null); setBusy(null); setNote(null) }, [connection])
    React.useEffect(() => {
      // 状态区接管同一错误后清掉临时反馈，避免采集恢复后旧错误再次出现。
      if (duplicateCollectionError) setNote(null)
    }, [duplicateCollectionError])
    React.useEffect(() => {
      if (busy !== null) return
      const button = focusAfterAction.current
      focusAfterAction.current = null
      if (button?.isConnected && document.activeElement === document.body) button.focus()
    }, [busy])

    async function act(event) {
      const token = life.current
      if (!token?.active || token.busy || disabled) return
      const button = event?.currentTarget
      focusAfterAction.current = button && document.activeElement === button ? button : null
      const endpoint = shouldStop ? 'stop' : 'start'
      const payload = shouldStop ? { mode: 'stop', reason: '设置页手动停止' } : { hours: Number(hours) }
      token.busy = true
      setBusy(label)
      setNote(null)
      const result = await callRpc(connection, endpoint, payload)
      if (!token.active) return
      if (result.ok !== true) {
        token.busy = false
        setBusy(null)
        setNote({ tone: 'bad', text: `${label}失败：${result.text}`, errorText: result.text })
        onDone?.()
        return
      }
      const value = result.value ?? {}
      let text = `${label}成功`
      let tone = 'ok'
      if (endpoint === 'start') {
        const opening = value.opening
        text = value.recovering === true
          ? `监控已开启，采集正在重试；窗口到 ${value.window?.endsAt ?? '—'}`
          : `窗口已开启，窗口到 ${value.window?.endsAt ?? '—'}；${value.polling === true ? '采集循环已启动，结果请查看最近采集' : '采集未启动'}`
        if (value.polling !== true || value.recovering === true) tone = 'warn'
        if (opening != null) {
          text += opening.ok === true
            ? (opening.dryRun === true ? '；开场白演练通过，未发送' : '；开场白已发')
            : `；开场白未发（${opening.reason ?? '未说明'}）`
          if (opening.ok !== true) tone = 'warn'
        } else {
          text += '；未启用开场白'
        }
      } else if (endpoint === 'stop') {
        text = `${label}成功：${value.stoppedAt ?? '—'}`
      }
      setNote({ tone, text, recovering: endpoint === 'start' && value.recovering === true })
      // 状态刷新完成前仍锁住按钮，避免旧快照再次提交同一个动作。
      if (typeof onDone === 'function') await onDone()
      if (!token.active) return
      token.busy = false
      setBusy(null)
    }

    return h('div', { className: 'dsh-popo-card' }, [
      h('div', { className: 'dsh-popo-head', key: 'head' }, [
        h('div', { className: 'dsh-popo-monitor-heading', key: 'heading' }, [
          h('h3', { className: 'dsh-popo-title', key: 'title' }, '自动监控'),
          h('span', { className: 'dsh-popo-badge', 'data-tone': view.tone, key: 'badge', role: 'status' }, busy !== null ? `${busy}中…` : view.text),
        ]),
        h('div', { className: 'dsh-popo-monitor-toggle', key: 'monitor-toggle' }, [
          h('button', {
            className: 'dsh-popo-switch',
            type: 'button',
            role: 'switch',
            'aria-label': '监控',
            'aria-checked': checked,
            'aria-busy': busy !== null,
            'aria-describedby': 'popo-monitor-state',
            'data-action': label,
            'data-unknown': snapshot.phase === 'error',
            'data-tone': view.recovering ? 'ok' : view.tone,
            title: snapshot.phase === 'error' ? '状态未知，点击尝试停止监控' : `${label}监控`,
            disabled: busy !== null || disabled,
            onClick: (event) => { void act(event) },
          }, h('span', { className: 'dsh-popo-switch-thumb', 'aria-hidden': true })),
          h('span', { className: 'dsh-popo-sr', id: 'popo-monitor-state' }, `${switchState}。停止会同时停止采集和自动发言。`),
        ]),
      ]),
      h('div', { className: 'dsh-popo-mention-control', key: 'mentions' }, [
        h('div', { className: 'dsh-popo-head', key: 'head' }, [
          h('span', { className: 'dsh-popo-k', id: 'popo-mention-label' }, '只回复 @ 我的消息'),
          h('button', {
            className: 'dsh-popo-switch', type: 'button', role: 'switch',
            'aria-label': '只回复 @ 我的消息', 'aria-checked': mentionChecked, 'aria-busy': mentionBusy,
            'aria-describedby': 'popo-mention-hint', 'data-action': '切换仅回复@我',
            disabled: mentionDisabled,
            onClick: event => {
              if (mentionDisabled) return
              rememberMentionFocus(event)
              void props.onMentionChange(!mentionChecked)
            },
          }, h('span', { className: 'dsh-popo-switch-thumb', 'aria-hidden': true })),
        ]),
        h('p', { className: 'dsh-popo-note', id: 'popo-mention-hint', key: 'hint' }, mentionBusy ? '正在保存回复范围…'
          : '仅直接 @ 我时考虑自动回复；单独 @所有人不触发。开场白和手动发送不受影响。'),
        mentionSettings.note?.scope === 'mentions' && (mentionSettings.note.tone === 'bad' || mentionSettings.configState !== 'saved') ? noteLine(mentionSettings.note) : null,
        mentionSettings.configState === 'unsaved' ? h('button', {
          className: 'dsh-popo-btn', type: 'button', 'data-action': '重试保存回复范围', disabled: mentionDisabled,
          onClick: event => {
            if (mentionDisabled) return
            rememberMentionFocus(event)
            void props.onMentionChange(mentionChecked)
          },
        }, '重试保存') : null,
      ]),
      h('div', { className: 'dsh-popo-duration', key: 'duration' }, [
        h('label', { className: 'dsh-popo-hours', key: 'hours' }, [
          h('span', { className: 'dsh-popo-k' }, '本次时长'),
          h('input', {
            className: 'dsh-popo-input',
            'data-field': 'hours',
            type: 'number',
            min: '1',
            max: '720',
            step: 'any',
            value: hours,
            disabled: busy !== null,
            'aria-invalid': !validHours && hoursOverride !== null,
            onChange: (event) => setHours(String(event?.target?.value ?? '')),
          }),
          h('span', { className: 'dsh-popo-k' }, '小时'),
        ]),
        h('p', { className: 'dsh-popo-note dsh-popo-remaining', 'aria-label': '本轮时间' }, view.remaining),
      ]),
      h('p', { className: 'dsh-popo-note', key: 'tip' }, hint),
      duplicateCollectionError || (note?.recovering && !view.recovering) || (view.collectionError && note?.tone !== 'bad' && !note?.recovering) ? null : noteLine(note),
      blocked && !shouldStop ? h('p', { className: 'dsh-popo-note', key: 'blocked' }, blocked) : null,
      !validHours && hoursOverride !== null ? h('p', { className: 'dsh-popo-err', role: 'alert', key: 'invalid' }, '本次时长需在 1–720 小时之间。') : null,
    ])
  }

  function JudgeControl(props) {
    const [busy, setBusy] = React.useState(false)
    const [note, setNote] = React.useState(null)
    const life = useLifetime(props.connection)
    const rememberFocus = useActionFocus(busy, props.connection)
    React.useEffect(() => { setBusy(false); setNote(null) }, [props.connection])
    async function run(event) {
      const token = life.current
      if (!token?.active || token.busy) return
      rememberFocus(event)
      token.busy = true
      setBusy(true)
      const result = await callRpc(props.connection, 'judge.now', {})
      if (!token.active) return
      token.busy = false
      setBusy(false)
      const view = result.value?.view ?? {}
      setNote(result.ok ? {
        tone: view.judgeError ? 'warn' : 'neutral',
        text: `判读结论：${view.verdict ?? '—'}；阻止原因：${Array.isArray(view.blockers) && view.blockers.length ? view.blockers.join('、') : '无'}${view.nextStep ? `；${view.nextStep}` : ''}${view.judgeError ? `；${view.judgeError}` : ''}`,
      } : { tone: 'bad', text: `判读失败：${result.text}` })
    }
    return h('section', { className: 'dsh-popo-diagnostic-tool', 'aria-label': '单次判读', 'aria-busy': busy }, [
      h('div', { className: 'dsh-popo-diagnostic-action', key: 'action' }, [
        h('div', { key: 'description' }, [h('h3', { className: 'dsh-popo-title' }, '单次判读'), h('p', { className: 'dsh-popo-note' }, '使用当前已生效配置，仅判读，不发送消息。')]),
        h('button', { className: 'dsh-popo-btn', type: 'button', 'data-action': '仅判读一次', disabled: busy, onClick: event => { void run(event) } }, busy ? '判读中…' : '仅判读一次'),
      ]),
      note ? noteLine({ ...note, collapsible: true }) : null,
    ])
  }

  function ManualSend(props) {
    const connection = props.connection
    const onDone = props.onDone
    const [text, setText] = React.useState('')
    const [note, setNote] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const life = useLifetime(connection)
    const group = typeof props.group === 'string' ? props.group : ''
    const blocked = /^\d{3,20}$/.test(group) ? '' : '尚未读取有效目标群，请检查群配置。'
    React.useEffect(() => { setText(''); setBusy(false); setNote(null) }, [connection])

    async function send() {
      const token = life.current
      if (!token?.active || token.busy || blocked || text.trim() === '') return
      token.busy = true
      setBusy(true)
      setNote(null)
      const result = await callRpc(connection, 'send.now', { text })
      if (!token.active) return
      token.busy = false
      setBusy(false)
      if (result.ok !== true) {
        setNote({ tone: 'bad', text: `未发出：${result.text}` })
        return
      }
      const value = result.value ?? {}
      const warnings = Array.isArray(value.warnings) ? value.warnings.filter(item => typeof item === 'string') : []
      const accountingFailed = value.stateWritten === false || warnings.some(item => item.startsWith('已发出，记账失败'))
      setNote({
        tone: accountingFailed || warnings.length ? 'warn' : 'ok',
        text: `${value.dryRun === true ? '演练通过，未发送消息' : `${accountingFailed ? '已发出，记账失败' : '已发出'}（msgId=${value.msgId || '—'}）`}${warnings.length ? `；${warnings.map(item => item.replace(/^已发出，记账失败：/, '')).join('；')}` : ''}`,
      })
      setText('')
      if (typeof onDone === 'function') onDone()
    }

    return h('section', { className: 'dsh-popo-card', 'aria-label': '手动发言' }, [
      h('h3', { className: 'dsh-popo-title', key: 'title' }, '手动发言'),
      blocked ? h('p', { className: 'dsh-popo-err', role: 'alert', key: 'blocked' }, blocked) : null,
      h('label', { className: 'dsh-popo-field', key: 'text' }, [
        h('span', { className: 'dsh-popo-sr' }, '消息内容'),
        h('textarea', {
          className: 'dsh-popo-input dsh-popo-manual-text',
          'data-field': 'manual-text',
          rows: 3,
          placeholder: '输入要发送的内容…',
          value: text,
          disabled: busy,
          onChange: (event) => setText(String(event?.target?.value ?? '')),
        }),
      ]),
      h('div', { className: 'dsh-popo-sendbar', key: 'actions' }, [
        h('p', { className: 'dsh-popo-note', key: 'reason' }, '手动内容直接发送，不受自动规则或演练模式影响。'),
        h('button', {
          className: 'dsh-popo-btn',
          type: 'button',
          'data-action': '发送',
          'data-primary': true,
          disabled: busy === true || text.trim() === '' || Boolean(blocked),
          onClick: () => { void send() },
        }, busy === true ? '发送中…' : '发送'),
      ]),
      noteLine(note),
    ])
  }
  return { StatusCard, RuntimeDetails, CliCheck, Controls, JudgeControl, ManualSend }
}
