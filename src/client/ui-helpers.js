import { clip } from './runtime.js'
export function createUiHelpers(React) {
  const h = React.createElement
  function noteLine(note) {
    if (note === null || note === undefined || note.text === '') return null
    if ((['bad', 'warn'].includes(note.tone) || note.collapsible === true) && note.text.length > 180) {
      return h('details', { className: 'dsh-popo-note dsh-popo-notice', key: note.key ?? 'note', role: note.tone === 'bad' ? 'alert' : 'status', 'data-tone': note.tone, 'data-dsh-popo-note': '' }, [
        h('summary', null, `${clip(note.text.split('\n')[0], 100)} · 查看完整信息`),
        h('p', { className: 'dsh-popo-note' }, note.text),
      ])
    }
    return h('p', { className: 'dsh-popo-note', key: note.key ?? 'note', role: note.tone === 'bad' ? 'alert' : 'status', 'aria-live': 'polite', 'data-tone': note.tone ?? 'neutral', 'data-dsh-popo-note': '' }, note.text)
  }

  function useLifetime(connection, identity) {
    const ref = React.useRef(null)
    React.useEffect(() => {
      const token = { active: true, busy: false }
      ref.current = token
      return () => { token.active = false }
    }, [connection, identity])
    return ref
  }

  function useActionFocus(busy, connection) {
    const target = React.useRef(null)
    React.useEffect(() => { target.current = null }, [connection])
    React.useEffect(() => {
      if (busy) return
      const button = target.current
      target.current = null
      if (button?.isConnected && document.activeElement === document.body) button.focus()
    }, [busy])
    return event => {
      const button = event?.currentTarget
      target.current = button && document.activeElement === button ? button : null
    }
  }
  return { noteLine, useLifetime, useActionFocus }
}
