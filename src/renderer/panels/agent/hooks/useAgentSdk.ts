/**
 * Hook that connects the AgentChat UI to the Agent SDK IPC bridge.
 *
 * The main process uses the V1 query() API with `resume` for multi-turn
 * conversations.  First message triggers agentSdk:start; follow-ups use
 * agentSdk:send which creates a new query with resume — token-efficient,
 * no replayed history.
 */
import { useEffect, useCallback, useRef, useState } from 'react'
import { useAgentChatStore } from '../../../store/agentChat'
import { useSessionStore } from '../../../store/sessions'
import type { AgentSdkMessage } from '../../../../shared/agentSdkTypes'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let userMsgCounter = 0
function nextUserMsgId(): string {
  return `user-${String(++userMsgCounter)}-${String(Date.now())}`
}

/** Look up the persisted SDK session ID for a given Broomy session. */
function getStoredSdkSessionId(sessionId: string): string | undefined {
  return useSessionStore.getState().sessions.find(s => s.id === sessionId)?.sdkSessionId
}

/** Add a user-authored message to the chat store. */
function addUserMessage(sessionId: string, text: string, queued?: boolean): void {
  useAgentChatStore.getState().addMessage(sessionId, {
    id: nextUserMsgId(),
    type: 'text',
    timestamp: Date.now(),
    text,
    ...(queued ? { queued: true } : {}),
  })
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UseAgentSdkOptions {
  sessionId: string
  cwd: string
  sdkSessionId?: string
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'
  env?: Record<string, string>
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'max'
}

interface CommandInfo {
  name: string
  description: string
}

interface HistoryMeta {
  total: number
  loaded: number
}

interface UseAgentSdkReturn {
  sendPrompt: (prompt: string) => void
  queuePrompt: (prompt: string) => void
  stopAgent: () => void
  respondToPermission: (toolUseId: string, allowed: boolean, updatedInput?: Record<string, unknown>) => void
  availableCommands: CommandInfo[]
  historyMeta: HistoryMeta | null
  loadFullHistory: () => void
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentSdk(options: UseAgentSdkOptions): UseAgentSdkReturn {
  const { sessionId, cwd, sdkSessionId, permissionMode, env, model, effort } = options

  // Lifecycle refs — track whether the agent turn is active and whether
  // at least one query has been created in the main process.
  const isRunningRef = useRef(false)
  const hasStartedRef = useRef(false)

  const [availableCommands, setAvailableCommands] = useState<CommandInfo[]>([])
  const [historyMeta, setHistoryMeta] = useState<HistoryMeta | null>(null)

  // --- History loading state ------------------------------------------------
  // History messages from the SDK transcript are buffered into
  // `historyBufferRef`, then atomically replace existing messages via
  // `replaceMessages` once the load completes. If the load fails, existing
  // messages are left untouched and the guard key is reset so the next
  // mount/visit can retry.
  const historyLoadedRef = useRef<string | null>(null)
  const historyBufferRef = useRef<AgentSdkMessage[]>([])
  const isLoadingHistoryRef = useRef(false)
  const loadGenRef = useRef(0)

  /** Shared logic for loading history from the SDK transcript. */
  const startHistoryLoad = useCallback((sdkId: string, limit?: number) => {
    // Bump the generation so any in-flight load's callbacks become no-ops.
    const gen = ++loadGenRef.current
    historyBufferRef.current = []
    isLoadingHistoryRef.current = true

    window.agentSdk.loadHistory(sdkId, sessionId, env, limit)
      .then(() => {
        if (loadGenRef.current !== gen) return // superseded by a newer load
        useAgentChatStore.getState().replaceMessages(sessionId, historyBufferRef.current)
      })
      .catch(() => {
        if (loadGenRef.current !== gen) return // superseded
        // Load failed — keep existing messages, allow retry on next visit
        historyLoadedRef.current = null
      })
      .finally(() => {
        if (loadGenRef.current !== gen) return // superseded
        isLoadingHistoryRef.current = false
        historyBufferRef.current = []
      })
  }, [sessionId, env])

  // --- Effects --------------------------------------------------------------

  // Fetch available slash commands on mount and when cwd changes
  useEffect(() => {
    void window.agentSdk.commands(cwd, env).then(setAvailableCommands)
  }, [cwd, env])

  // Load message history from the SDK transcript on mount.
  useEffect(() => {
    const currentSdkId = getStoredSdkSessionId(sessionId) ?? sdkSessionId
    if (!currentSdkId || currentSdkId.length === 0) return
    const key = `${sessionId}:${currentSdkId}`
    if (historyLoadedRef.current === key) return
    historyLoadedRef.current = key
    startHistoryLoad(currentSdkId)
  }, [sessionId, sdkSessionId, env, startHistoryLoad])

  // Subscribe to IPC events from the main process.
  useEffect(() => {
    const cleanups: (() => void)[] = []

    cleanups.push(window.agentSdk.onMessage(sessionId, (msg: AgentSdkMessage) => {
      const isHistory = msg.id.startsWith('history-')

      if (isHistory && isLoadingHistoryRef.current) {
        // Buffer history messages for atomic replacement when load completes
        historyBufferRef.current.push(msg)
      } else {
        useAgentChatStore.getState().addMessage(sessionId, msg)
      }

      if (!isHistory && (msg.type === 'text' || msg.type === 'tool_use')) {
        useSessionStore.getState().updateAgentMonitor(sessionId, {
          status: 'working',
          lastMessage: msg.text ?? msg.toolName ?? undefined,
        })
      }
    }))

    cleanups.push(window.agentSdk.onDone(sessionId, (returnedSdkSessionId: string) => {
      isRunningRef.current = false
      useAgentChatStore.getState().clearQueuedFlag(sessionId)
      useAgentChatStore.getState().setState(sessionId, 'idle')
      useSessionStore.getState().updateAgentMonitor(sessionId, { status: 'idle' })
      if (returnedSdkSessionId && returnedSdkSessionId.length > 0) {
        useSessionStore.getState().setSdkSessionId(sessionId, returnedSdkSessionId)
      }
    }))

    cleanups.push(window.agentSdk.onError(sessionId, (error: string) => {
      isRunningRef.current = false
      // Do NOT clear sdkSessionId — errors are transient, the session is still
      // resumable and clearing it permanently destroys the history link.
      // Do NOT reset hasStartedRef — the session still exists in the main process.
      useAgentChatStore.getState().setError(sessionId, error)
      useAgentChatStore.getState().addMessage(sessionId, {
        id: `error-${String(Date.now())}`,
        type: 'error',
        timestamp: Date.now(),
        text: error,
      })
      useSessionStore.getState().updateAgentMonitor(sessionId, { status: 'idle' })
    }))

    cleanups.push(window.agentSdk.onPermissionRequest(sessionId, (req) => {
      useAgentChatStore.getState().setPendingPermission(sessionId, req)
    }))

    cleanups.push(window.agentSdk.onHistoryMeta(sessionId, (meta) => {
      setHistoryMeta(meta)
    }))

    return () => { cleanups.forEach((fn) => fn()) }
  }, [sessionId])

  // --- Actions --------------------------------------------------------------

  const queuePrompt = useCallback((prompt: string) => {
    const trimmed = prompt.trim()
    if (!trimmed || !isRunningRef.current) return
    addUserMessage(sessionId, trimmed, true)
    // The main process guards against missing sdkSessionId / inactive sessions.
    void window.agentSdk.inject(sessionId, trimmed)
  }, [sessionId])

  const sendPrompt = useCallback((prompt: string) => {
    if (isRunningRef.current) {
      // Agent is still running (e.g. executing a tool) — queue instead of dropping
      queuePrompt(prompt)
      return
    }

    const trimmed = prompt.trim()

    // Intercept commands the SDK doesn't support
    if (trimmed === '/login') {
      addUserMessage(sessionId, trimmed)
      isRunningRef.current = true
      useAgentChatStore.getState().setState(sessionId, 'running')
      void window.agentSdk.login(sessionId)
      return
    }
    if (trimmed === '/status') {
      addUserMessage(sessionId, trimmed)
      void window.agentSdk.status(sessionId, env)
      return
    }

    isRunningRef.current = true
    useAgentChatStore.getState().setState(sessionId, 'running')
    useAgentChatStore.getState().setError(sessionId, null)
    useSessionStore.getState().updateAgentMonitor(sessionId, { status: 'working' })

    addUserMessage(sessionId, prompt)

    if (hasStartedRef.current) {
      // Session exists in main process — send creates a new query with resume.
      // Pass cwd/env/permissionMode so if the main process lost the session
      // (e.g. after hot reload), it can start a new one with correct params.
      void window.agentSdk.send(sessionId, prompt, {
        cwd, permissionMode, env, model, effort,
        sdkSessionId: getStoredSdkSessionId(sessionId),
      })
    } else {
      // First message — create a new query (with resume if we have a stored session)
      const storedId = getStoredSdkSessionId(sessionId)
      const resumeId = (storedId && storedId.length > 0)
        ? storedId
        : (sdkSessionId && sdkSessionId.length > 0 ? sdkSessionId : undefined)
      hasStartedRef.current = true
      void window.agentSdk.start({
        id: sessionId,
        prompt,
        cwd,
        sdkSessionId: resumeId,
        permissionMode,
        env,
        model,
        effort,
      })
    }
  }, [sessionId, cwd, sdkSessionId, permissionMode, env, model, effort, queuePrompt])

  const stopAgent = useCallback(() => {
    void window.agentSdk.stop(sessionId)
    isRunningRef.current = false
    hasStartedRef.current = false
    useAgentChatStore.getState().setState(sessionId, 'idle')
    useSessionStore.getState().updateAgentMonitor(sessionId, { status: 'idle' })
  }, [sessionId])

  const respondToPermission = useCallback((toolUseId: string, allowed: boolean, updatedInput?: Record<string, unknown>) => {
    void window.agentSdk.respondToPermission(sessionId, toolUseId, allowed, updatedInput)
    useAgentChatStore.getState().setPendingPermission(sessionId, null)
    if (allowed) {
      useAgentChatStore.getState().setState(sessionId, 'running')
    }
  }, [sessionId])

  const loadFullHistory = useCallback(() => {
    const sdkId = getStoredSdkSessionId(sessionId)
    if (sdkId && sdkId.length > 0) {
      setHistoryMeta(null)
      startHistoryLoad(sdkId, 9999)
    }
  }, [sessionId, startHistoryLoad])

  return { sendPrompt, queuePrompt, stopAgent, respondToPermission, availableCommands, historyMeta, loadFullHistory }
}
