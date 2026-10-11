import { SECTION_LABEL } from './constants.js'
import { runtimeView } from './runtime.js'
import { draftOf, configLabel } from './config-state.js'
import { createUiHelpers } from './ui-helpers.js'
import { createOverview } from './overview.js'
import { createSettings } from './settings.js'
import { createRecords } from './records.js'
import { createPanelState } from './panel-state.js'

export function createUi(React) {
  const h = React.createElement
  const helpers = createUiHelpers(React)
  const { noteLine } = helpers
  const { StatusCard, RuntimeDetails, Controls, ManualSend } = createOverview(React, helpers)
  const { ConfigForm, ModelSettings, KeyForm, ImportCard } = createSettings(React, helpers)
  const { Stream } = createRecords(React, helpers)
  const usePanelState = createPanelState(React, helpers)
  class Boundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { message: null, attempt: 0 }
    }

    static getDerivedStateFromError(error) {
      return { message: error instanceof Error ? error.message : String(error) }
    }

    render() {
      if (this.state.message !== null) {
        return h('div', { className: 'dsh-popo-root' }, [
          h('div', { className: 'dsh-popo-card', key: 'card' }, [
            h('div', { className: 'dsh-popo-head', key: 'head' }, [
              h('span', { className: 'dsh-popo-title', key: 'title' }, SECTION_LABEL),
              h('span', { className: 'dsh-popo-badge', 'data-tone': 'bad', key: 'badge' }, '页面异常'),
            ]),
            h('p', { className: 'dsh-popo-err', key: 'err' }, `页面渲染失败：${this.state.message}`),
            h('button', {
              className: 'dsh-popo-btn',
              type: 'button',
              key: 'retry',
              onClick: () => this.setState((prev) => ({ message: null, attempt: prev.attempt + 1 })),
            }, '重试'),
          ]),
        ])
      }
      return h('div', { key: `body-${this.state.attempt}` }, this.props.children)
    }
  }
  function Panel({ connection }) {
    const { tab, setTab, snapshot, settings, models, refresh, loadConfig, loadModels, dirty, errors, locked, blocked, canSave, savedNote, changeField, changeGeneration, saveConfig, setSettings, hasUnpersisted, configChangedWhileLocked } = usePanelState(connection)
    const tabs = [['overview', '概览'], ['settings', '设置'], ['records', '记录']]
    function navigate(event, index) {
      const key = event.key
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return
      event.preventDefault()
      const next = key === 'Home' ? 0 : key === 'End' ? tabs.length - 1 : (index + (key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      setTab(tabs[next][0])
      event.currentTarget.parentElement?.querySelector(`[data-tab="${tabs[next][0]}"]`)?.focus()
    }
    const done = () => refresh.current()
    const view = runtimeView(snapshot)
    const group = snapshot.value?.group ?? settings.baseline?.group
    return h('div', { className: 'dsh-popo-root' }, [
      h('div', { className: 'dsh-popo-head dsh-popo-page-head', key: 'head' }, [
        h('h2', { className: 'dsh-popo-heading' }, SECTION_LABEL),
      ]),
      h('div', { className: 'dsh-popo-tabs', role: 'tablist', 'aria-label': 'POPO 插件页面', key: 'tabs' }, tabs.map(([id, label], index) => h('button', {
        className: 'dsh-popo-tab', type: 'button', role: 'tab', id: `popo-tab-${id}`, key: id,
        'data-tab': id, 'aria-controls': `popo-panel-${id}`, 'aria-selected': tab === id, tabIndex: tab === id ? 0 : -1,
        onClick: () => setTab(id), onKeyDown: event => navigate(event, index),
      }, `${label}${id === 'settings' && (dirty || hasUnpersisted) ? ' · 未保存' : ''}`))),
      h('section', { className: 'dsh-popo-panel', id: 'popo-panel-overview', role: 'tabpanel', 'aria-labelledby': 'popo-tab-overview', hidden: tab !== 'overview', key: 'overview' }, [
        h('section', { className: 'dsh-popo-monitor', 'aria-label': '自动监控', key: 'monitor' }, [
          h(Controls, { key: 'controls', connection, onDone: done, snapshot, view, blocked, defaultHours: settings.baseline?.windowHours, openingEnabled: settings.baseline?.opening?.enabled === true, configState: settings.configState }),
          h(StatusCard, { key: 'status', snapshot, view, onRefresh: done }),
        ]),
        h(ManualSend, { key: 'manual', connection, onDone: done, group }),
        h(RuntimeDetails, { key: 'details', connection, snapshot, view }),
        h('p', { className: 'dsh-popo-note dsh-popo-refresh', key: 'time' }, [
          h('span', { key: 'last' }, `最后成功刷新：${snapshot.at ?? '—'}${snapshot.phase === 'error' ? ' · 当前显示缓存' : ''}`),
          h('span', { key: 'interval' }, '每 2 秒刷新'),
        ]),
      ]),
      h('section', { className: 'dsh-popo-panel', id: 'popo-panel-settings', role: 'tabpanel', 'aria-labelledby': 'popo-tab-settings', hidden: tab !== 'settings', key: 'settings' }, [
        h(ConfigForm, { key: 'config', state: settings, dirty, errors, locked, onChange: changeField, onReload: () => { void loadConfig(true) } }),
        h(ModelSettings, { key: 'models', state: settings, models, snapshot, onChange: changeField, onGenerationChange: changeGeneration, onRefresh: () => { void loadModels() } }),
        h(KeyForm, { key: 'key', connection, onDone: () => { done(); void loadModels('judge') } }),
        h(ImportCard, { key: 'import', connection, onDone: done }),
        h('div', { className: 'dsh-popo-savebar', key: 'save' }, [
          h('span', { className: 'dsh-popo-note', role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, savedNote
            ? (savedNote.tone === 'warn' ? '已保存（有提示）' : '✓ 配置已保存')
            : configLabel(settings, dirty)),
          h('div', { className: 'dsh-popo-actions' }, [
            h('button', { className: 'dsh-popo-btn', type: 'button', 'data-action': '撤销修改', disabled: !dirty || settings.busy || settings.phase !== 'ready', onClick: () => setSettings(previous => ({ ...previous, draft: draftOf(previous.baseline), note: null })) }, '撤销修改'),
            h('button', { className: 'dsh-popo-btn', type: 'button', 'data-action': '保存', 'data-primary': true, disabled: !canSave, onClick: () => { void saveConfig() } }, settings.busy ? '保存中…' : hasUnpersisted ? '重试保存' : settings.configState === 'default' && !dirty ? '保存默认配置' : '保存配置'),
          ]),
          configChangedWhileLocked ? h('p', { className: 'dsh-popo-err', key: 'locked' }, '群或间隔有未保存修改，请先停止监控再保存。') : null,
          savedNote ? null : noteLine(settings.note),
        ]),
      ]),
      h('section', { className: 'dsh-popo-panel', id: 'popo-panel-records', role: 'tabpanel', 'aria-labelledby': 'popo-tab-records', hidden: tab !== 'records', key: 'records' }, h(Stream, { connection, group, active: tab === 'records' })),
    ])
  }
  function Page(props) {
    return h(Boundary, null, h(Panel, { connection: props.connection }))
  }
  return { Page }
}
