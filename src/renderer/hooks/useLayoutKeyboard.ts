import { ReactNode, useEffect, useState, useCallback, useRef } from 'react'
import { PANEL_IDS, MAX_SHORTCUT_PANELS } from '../panels'

interface UseLayoutKeyboardParams {
  toolbarPanels: string[]
  isPanelVisible: (panelId: string) => boolean
  panels: Record<string, ReactNode>
  handleToggle: (panelId: string) => void
  onSearchFiles?: () => void
  onNewSession?: () => void
  onNextSession?: () => void
  onPrevSession?: () => void
  onFocusSessionList?: () => void
  onFocusSessionSearch?: () => void
  onArchiveSession?: () => void
  onToggleSettings?: () => void
  onShowShortcuts?: () => void
}

/** Build a normalized shortcut key for matching, e.g. "shift+mod:f" or "alt:arrowdown". */
function shortcutKey(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  return `${parts.join('+')}:${e.key.toLowerCase()}`
}

/** Like shortcutKey but ignores Shift, for shortcuts that accept both upper/lowercase. */
function shortcutKeyNoShift(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.altKey) parts.push('alt')
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  return `${parts.join('+')}:${e.key.toLowerCase()}`
}

export function useLayoutKeyboard({
  toolbarPanels,
  isPanelVisible,
  panels,
  handleToggle,
  onSearchFiles,
  onNewSession,
  onNextSession,
  onPrevSession,
  onFocusSessionList,
  onFocusSessionSearch,
  onArchiveSession,
  onToggleSettings,
  onShowShortcuts,
}: UseLayoutKeyboardParams) {
  const [flashedPanel, setFlashedPanel] = useState<string | null>(null)
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Panel navigation helpers
  const focusPanel = useCallback((panelId: string) => {
    const container = document.querySelector(`[data-panel-id="${panelId}"]`)
    if (!container) return

    const xtermTextarea = container.querySelector<HTMLElement>('.xterm-helper-textarea')
    if (xtermTextarea) { xtermTextarea.focus(); return }

    const monacoTextarea = container.querySelector<HTMLElement>('textarea.inputarea')
    if (monacoTextarea) { monacoTextarea.focus(); return }

    const focusable = container.querySelector<HTMLElement>('input, textarea, button, [tabindex]')
    if (focusable) { focusable.focus(); return }

    ;(container as HTMLElement).focus()
  }, [])

  const getCurrentPanel = useCallback((): string | null => {
    const activeEl = document.activeElement
    if (!activeEl) return null
    const panelEl = activeEl.closest('[data-panel-id]')
    return panelEl?.getAttribute('data-panel-id') ?? null
  }, [])

  const lastCyclePanelRef = useRef<string | null>(null)

  const handleCyclePanel = useCallback((reverse: boolean) => {
    const visiblePanels = toolbarPanels.filter(id => {
      if (!isPanelVisible(id)) return false
      if (id === PANEL_IDS.SETTINGS) return false
      return !!panels[id]
    })

    if (visiblePanels.length === 0) return

    const current = getCurrentPanel() || lastCyclePanelRef.current
    const currentIndex = current ? visiblePanels.indexOf(current) : -1

    let nextIndex: number
    if (currentIndex === -1) {
      nextIndex = reverse ? visiblePanels.length - 1 : 0
    } else if (reverse) {
      nextIndex = (currentIndex - 1 + visiblePanels.length) % visiblePanels.length
    } else {
      nextIndex = (currentIndex + 1) % visiblePanels.length
    }

    const targetPanel = visiblePanels[nextIndex]
    lastCyclePanelRef.current = targetPanel
    focusPanel(targetPanel)

    setFlashedPanel(targetPanel)
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    flashTimeoutRef.current = setTimeout(() => setFlashedPanel(null), 250)
  }, [toolbarPanels, isPanelVisible, panels, getCurrentPanel, focusPanel])

  const handleToggleByKey = useCallback((key: string) => {
    const index = parseInt(key, 10) - 1
    if (index >= 0 && index < toolbarPanels.length && index < MAX_SHORTCUT_PANELS) {
      const panelId = toolbarPanels[index]
      handleToggle(panelId)
    }
  }, [toolbarPanels, handleToggle])

  useEffect(() => {
    // App-wide shortcuts: exact match (including shift state)
    const appWideShortcuts = new Map<string, () => void>()
    if (onNewSession) appWideShortcuts.set('mod:n', onNewSession)
    if (onFocusSessionList) appWideShortcuts.set('mod:j', onFocusSessionList)
    if (onFocusSessionSearch) appWideShortcuts.set('shift+mod:f', onFocusSessionSearch)
    if (onArchiveSession) appWideShortcuts.set('shift+mod:a', onArchiveSession)
    if (onToggleSettings) appWideShortcuts.set('mod:,', onToggleSettings)
    if (onShowShortcuts) appWideShortcuts.set('mod:/', onShowShortcuts)
    if (onPrevSession) appWideShortcuts.set('alt:arrowup', onPrevSession)
    if (onNextSession) appWideShortcuts.set('alt:arrowdown', onNextSession)

    // Shift-insensitive shortcuts (Cmd+P works as Cmd+Shift+P too)
    const shiftInsensitiveShortcuts = new Map<string, () => void>()
    if (onSearchFiles) shiftInsensitiveShortcuts.set('mod:p', onSearchFiles)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        e.stopImmediatePropagation()
        handleCyclePanel(e.shiftKey)
        return
      }

      // Check exact-match app-wide shortcuts
      const key = shortcutKey(e)
      const appAction = appWideShortcuts.get(key)
      if (appAction) {
        e.preventDefault()
        e.stopImmediatePropagation()
        appAction()
        return
      }

      // Check shift-insensitive shortcuts
      const noShiftKey = shortcutKeyNoShift(e)
      const shiftInsensitiveAction = shiftInsensitiveShortcuts.get(noShiftKey)
      if (shiftInsensitiveAction) {
        e.preventDefault()
        e.stopImmediatePropagation()
        shiftInsensitiveAction()
        return
      }

      // Below here: skip if in input/textarea, require Cmd/Ctrl
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (['1', '2', '3', '4', '5', '6'].includes(e.key)) {
        e.preventDefault()
        e.stopPropagation()
        handleToggleByKey(e.key)
      }
    }

    // Custom events from Terminal (xterm may block normal event bubbling)
    const handleCustomToggle = (e: Event) => {
      const customEvent = e as CustomEvent<{ key: string }>
      handleToggleByKey(customEvent.detail.key)
    }

    const handleCustomNewSession = () => onNewSession?.()
    const handleCustomNextSession = () => onNextSession?.()
    const handleCustomPrevSession = () => onPrevSession?.()
    const handleCustomFocusSessions = () => onFocusSessionList?.()
    const handleCustomFocusSessionSearch = () => onFocusSessionSearch?.()
    const handleCustomArchiveSession = () => onArchiveSession?.()
    const handleCustomToggleSettings = () => onToggleSettings?.()
    const handleCustomShowShortcuts = () => onShowShortcuts?.()

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('app:toggle-panel', handleCustomToggle)
    window.addEventListener('app:new-session', handleCustomNewSession)
    window.addEventListener('app:next-session', handleCustomNextSession)
    window.addEventListener('app:prev-session', handleCustomPrevSession)
    window.addEventListener('app:focus-sessions', handleCustomFocusSessions)
    window.addEventListener('app:focus-session-search', handleCustomFocusSessionSearch)
    window.addEventListener('app:archive-session', handleCustomArchiveSession)
    window.addEventListener('app:toggle-settings', handleCustomToggleSettings)
    window.addEventListener('app:show-shortcuts', handleCustomShowShortcuts)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('app:toggle-panel', handleCustomToggle)
      window.removeEventListener('app:new-session', handleCustomNewSession)
      window.removeEventListener('app:next-session', handleCustomNextSession)
      window.removeEventListener('app:prev-session', handleCustomPrevSession)
      window.removeEventListener('app:focus-sessions', handleCustomFocusSessions)
      window.removeEventListener('app:focus-session-search', handleCustomFocusSessionSearch)
      window.removeEventListener('app:archive-session', handleCustomArchiveSession)
      window.removeEventListener('app:toggle-settings', handleCustomToggleSettings)
      window.removeEventListener('app:show-shortcuts', handleCustomShowShortcuts)
    }
  }, [handleToggleByKey, handleCyclePanel, onSearchFiles, onNewSession, onNextSession, onPrevSession, onFocusSessionList, onFocusSessionSearch, onArchiveSession, onToggleSettings, onShowShortcuts])

  return {
    flashedPanel,
  }
}
