import { MESSAGE_POLL_MS } from './constants.js'
import { callRpc } from './rpc.js'
export function createRecords(React, { noteLine, useLifetime }) {
  const h = React.createElement
  function Stream(props) {
    const connection = props.connection
    const group = typeof props.group === 'string' ? props.group : ''
    const [kind, setKind] = React.useState('messages')
    const [views, setViews] = React.useState({})
    const [busy, setBusy] = React.useState(false)
    const life = useLifetime(connection, group)
    React.useEffect(() => { setKind('messages'); setViews({}); setBusy(false) }, [connection, group])
    const labels = { messages: '群消息', sends: '已发送', log: '判读日志' }
    const view = views[kind] ?? { phase: 'initial', rows: [], at: null, note: null }

    async function load(next) {
      const token = life.current
      if (!token?.active || token.busy) return
      if (next === 'messages' && group === '') return
      token.busy = true
      setBusy(true)
      setKind(next)
      setViews(previous => ({ ...previous, [next]: { ...(previous[next] ?? { rows: [], at: null }), phase: 'loading', note: null } }))
      const result = await callRpc(connection, next, { limit: 30 })
      if (!token.active) return
      token.busy = false
      setBusy(false)
      const rows = next === 'log' ? result.value?.lines : result.value?.rows
      const valid = Array.isArray(rows) && (next !== 'messages'
        || result.value?.group === group && typeof result.value?.fetchedAt === 'string' && result.value.fetchedAt !== '')
      if (!result.ok || !valid) {
        setViews(previous => ({ ...previous, [next]: { ...previous[next], phase: 'error', note: { tone: 'bad', text: `读取失败：${result.ok ? '宿主未返回当前群的有效记录，请刷新或重新加载插件' : result.text}` } } }))
      } else {
        setViews(previous => ({ ...previous, [next]: { phase: 'ready', rows, at: next === 'messages' ? result.value.fetchedAt : new Date().toLocaleTimeString(), note: null } }))
      }
    }

    React.useEffect(() => {
      if (!props.active || kind !== 'messages' || group === '') return
      const refresh = () => { if (!document.hidden) void load('messages') }
      refresh()
      const timer = setInterval(refresh, MESSAGE_POLL_MS)
      document.addEventListener?.('visibilitychange', refresh)
      return () => {
        clearInterval(timer)
        document.removeEventListener?.('visibilitychange', refresh)
      }
    }, [connection, group, props.active, kind])

    const lines = view.rows.map(row => kind === 'log'
      ? String(row ?? '')
      : kind === 'sends' ? `${row?.at ?? ''} ${row?.opening === true ? '[开场白] ' : ''}${row?.content ?? ''}`
      : `${row?.time ?? ''} ${row?.name ?? row?.from ?? ''}：${row?.content ?? ''}`)
    const empty = view.phase === 'initial' ? `尚未加载${labels[kind]}`
      : view.phase === 'loading' ? '正在读取…'
      : view.phase === 'error' ? '记录读取失败，可重试刷新。'
      : `暂无${labels[kind]}记录`
    return h('section', { className: 'dsh-popo-card', 'aria-label': '最近记录' }, [
      h('div', { className: 'dsh-popo-head', key: 'head' }, [
        h('h3', { className: 'dsh-popo-title' }, '最近记录'),
        h('button', { className: 'dsh-popo-btn', type: 'button', 'data-action': '刷新记录', disabled: busy, onClick: () => { void load(kind) } }, busy ? '读取中…' : '刷新'),
      ]),
      h('div', { className: 'dsh-popo-actions', 'aria-label': '记录类型', key: 'tabs' }, Object.entries(labels).map(([key, label]) => h('button', {
        className: 'dsh-popo-btn', type: 'button', key, 'data-stream': key, 'aria-pressed': kind === key,
        disabled: busy, onClick: () => { void load(key) },
      }, label))),
      h('p', { className: 'dsh-popo-note', key: 'at' }, kind === 'messages'
        ? (view.at ? `最近 ${lines.length} 条 · 最近成功获取：${view.at}${view.phase === 'error' ? '（缓存结果，刷新失败）' : ''}` : '获取服务端最近 30 条')
        : view.at ? `最近 ${lines.length} 条 · 最后成功加载 ${view.at}${view.phase === 'error' ? '（缓存结果）' : ''}` : '按需读取最近 30 条'),
      kind === 'messages' ? h('p', { className: 'dsh-popo-note', key: 'latest' }, `最新消息：${view.rows[0]?.time || '—'} · 最新在前 · 每 20 秒自动刷新`) : null,
      lines.length === 0
        ? h('p', { className: 'dsh-popo-note dsh-popo-empty', role: 'status', key: 'empty' }, empty)
        : h('div', { className: 'dsh-popo-lines', key: 'lines', 'aria-busy': busy }, lines.map((line, index) => h('div', { className: 'dsh-popo-line', key: index }, line))),
      noteLine(view.note),
    ])
  }
  return { Stream }
}
