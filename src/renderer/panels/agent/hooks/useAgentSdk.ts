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

let userMsgCounter = 0
function nextUserMsgId(): string {
  return `user-${String(++userMsgCounter)}-${String(Date.now())}`
}

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
  stopAgent: () => void
  respondToPermission: (toolUseId: string, allowed: boolean, updatedInput?: Record<string, unknown>) => void
  availableCommands: CommandInfo[]
  historyMeta: HistoryMeta | null
  loadFullHistory: () => void
}

export function useAgentSdk(options: UseAgentSdkOptions): UseAgentSdkReturn {
  const { sessionId, cwd, sdkSessionId, permissionMode, env, model, effort } = options
  const isRunningRef = useRef(false)
  const hasStartedRef = useRef(false)
  // Messages queued while the agent is running, to be sent as a proper new
  // turn when the current turn finishes.  We don't use the SDK's streamInput
  // because it isn't reliably visible to the SDK — queued messages would be
  // lost if the local store is ever refreshed from the SDK transcript.
  const pendingQueueRef = useRef<string[]>([])
  // Ref so the onDone handler (registered once) always calls the latest version
  const sendNextQueuedRef = useRef<() => void>(() => {})
  const [availableCommands, setAvailableCommands] = useState<CommandInfo[]>([])
  const [historyMeta, setHistoryMeta] = useState<HistoryMeta | null>(null)

  // Fetch available slash commands on mount and when cwd changes
  useEffect(() => {
    void window.agentSdk.commands(cwd, env).then(setAvailableCommands)
  }, [cwd, env])

  // Load message history from the SDK transcript on mount only.
  // This must NOT re-run when sdkSessionId changes later (e.g. after the
  // first turn completes and onDone sets the id) because clearSession would
  // destroy live messages — including any the user queued mid-turn.
  const historyLoadedRef = useRef<string | null>(null)
  useEffect(() => {
    const stored = useSessionStore.getState().sessions.find(s => s.id === sessionId)
    const currentSdkId = stored?.sdkSessionId ?? sdkSessionId
    if (!currentSdkId || currentSdkId.length === 0) return
    const key = `${sessionId}:${currentSdkId}`
    if (historyLoadedRef.current === key) return
    historyLoadedRef.current = key
    useAgentChatStore.getState().clearSession(sessionId)
    void window.agentSdk.loadHistory(currentSdkId, sessionId, env)
  }, [sessionId])

  // Subscribe to IPC events
  useEffect(() => {
    const cleanups: (() => void)[] = []

    const unsubMessage = window.agentSdk.onMessage(sessionId, (msg: AgentSdkMessage) => {
      useAgentChatStore.getState().addMessage(sessionId, msg)

      const isHistory = msg.id.startsWith('history-')
      if (!isHistory && (msg.type === 'text' || msg.type === 'tool_use')) {
        useSessionStore.getState().updateAgentMonitor(sessionId, {
          status: 'working',
          lastMessage: msg.text ?? msg.toolName ?? undefined,
        })
      }
    })
    cleanups.push(unsubMessage)

    const unsubDone = window.agentSdk.onDone(sessionId, (returnedSdkSessionId: string) => {
      isRunningRef.current = false
      if (returnedSdkSessionId && returnedSdkSessionId.length > 0) {
        useSessionStore.getState().setSdkSessionId(sessionId, returnedSdkSessionId)
      }
      // If the user queued messages while the agent was working, send the
      // next one as a proper new turn now that the SDK is idle.
      if (pendingQueueRef.current.length > 0) {
        sendNextQueuedRef.current()
      } else {
        useAgentChatStore.getState().clearQueuedFlag(sessionId)
        useAgentChatStore.getState().setState(sessionId, 'idle')
        useSessionStore.getState().updateAgentMonitor(sessionId, { status: 'idle' })
      }
    })
    cleanups.push(unsubDone)

    const unsubError = window.agentSdk.onError(sessionId, (error: string) => {
      isRunningRef.current = false
      hasStartedRef.current = false
      pendingQueueRef.current = []
      useSessionStore.getState().setSdkSessionId(sessionId, '')
      useAgentChatStore.getState().setError(sessionId, error)
      useAgentChatStore.getState().addMessage(sessionId, {
        id: `error-${String(Date.now())}`,
        type: 'error',
        timestamp: Date.now(),
        text: error,
      })
      useSessionStore.getState().updateAgentMonitor(sessionId, { status: 'idle' })
    })
    cleanups.push(unsubError)

    const unsubPermission = window.agentSdk.onPermissionRequest(sessionId, (req) => {
      useAgentChatStore.getState().setPendingPermission(sessionId, req)
    })
    cleanups.push(unsubPermission)

    const unsubHistoryMeta = window.agentSdk.onHistoryMeta(sessionId, (meta) => {
      setHistoryMeta(meta)
    })
    cleanups.push(unsubHistoryMeta)

    return () => {
      cleanups.forEach((fn) => fn())
    }
  }, [sessionId])

  // Send the next queued message as a proper new turn.  Called from onDone
  // (via ref) after the current turn finishes so the SDK actually sees the message.
  const sendNextQueued = useCallback(() => {
    if (pendingQueueRef.current.length === 0) return
    const next = pendingQueueRef.current.shift()!
    // Clear the queued flag on the message we're about to send
    useAgentChatStore.getState().clearQueuedFlag(sessionId)
    isRunningRef.current = true
    useAgentChatStore.getState().setState(sessionId, 'running')
    useSessionStore.getState().updateAgentMonitor(sessionId, { status: 'working' })
    void window.agentSdk.send(sessionId, next, { cwd, permissionMode, env, model, effort,
      sdkSessionId: useSessionStore.getState().sessions.find(s => s.id === sessionId)?.sdkSessionId })
  }, [sessionId, cwd, permissionMode, env, model, effort])
  sendNextQueuedRef.current = sendNextQueued

  // Queue a message to be sent after the current turn finishes.
  // Only called from sendPrompt after it has verified isRunningRef === true.
  const queuePrompt = useCallback((prompt: string) => {
    useAgentChatStore.getState().addMessage(sessionId, {
      id: nextUserMsgId(),
      type: 'text',
      timestamp: Date.now(),
      text: prompt,
      queued: true,
    })
    pendingQueueRef.current.push(prompt)
  }, [sessionId])

  // Single entry point for all user messages.  Uses isRunningRef (synchronous,
  // always up-to-date) — never the React-rendered `isRunning` prop — to decide
  // between queuing mid-turn and starting a new turn.
  const sendPrompt = useCallback((prompt: string) => {
    const trimmed = prompt.trim()
    if (!trimmed) return

    if (isRunningRef.current) {
      // Agent is still running — queue as a mid-turn inject
      queuePrompt(trimmed)
      return
    }

    // Intercept commands the SDK doesn't support
    if (trimmed === '/login') {
      useAgentChatStore.getState().addMessage(sessionId, {
        id: nextUserMsgId(), type: 'text', timestamp: Date.now(), text: trimmed,
      })
      isRunningRef.current = true
      useAgentChatStore.getState().setState(sessionId, 'running')
      void window.agentSdk.login(sessionId)
      return
    }
    if (trimmed === '/status') {
      useAgentChatStore.getState().addMessage(sessionId, {
        id: nextUserMsgId(), type: 'text', timestamp: Date.now(), text: trimmed,
      })
      void window.agentSdk.status(sessionId, env)
      return
    }

    isRunningRef.current = true
    useAgentChatStore.getState().setState(sessionId, 'running')
    useAgentChatStore.getState().setError(sessionId, null)
    useSessionStore.getState().updateAgentMonitor(sessionId, { status: 'working' })

    useAgentChatStore.getState().addMessage(sessionId, {
      id: nextUserMsgId(),
      type: 'text',
      timestamp: Date.now(),
      text: trimmed,
    })

    if (hasStartedRef.current) {
      // Session exists in main process — send creates a new query with resume.
      // Pass cwd/env/permissionMode so if the main process lost the session
      // (e.g. after hot reload), it can start a new one with correct params.
      void window.agentSdk.send(sessionId, trimmed, { cwd, permissionMode, env, model, effort,
        sdkSessionId: useSessionStore.getState().sessions.find(s => s.id === sessionId)?.sdkSessionId })
    } else {
      // First message — create a new query (with resume if we have a stored session)
      const storedId = useSessionStore.getState().sessions.find(s => s.id === sessionId)?.sdkSessionId
      const resumeId = storedId && storedId.length > 0 ? storedId : (sdkSessionId && sdkSessionId.length > 0 ? sdkSessionId : undefined)
      hasStartedRef.current = true
      void window.agentSdk.start({
        id: sessionId,
        prompt: trimmed,
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
    pendingQueueRef.current = []
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
    const stored = useSessionStore.getState().sessions.find(s => s.id === sessionId)
    const sdkId = stored?.sdkSessionId
    if (sdkId && sdkId.length > 0) {
      useAgentChatStore.getState().clearSession(sessionId)
      setHistoryMeta(null)
      void window.agentSdk.loadHistory(sdkId, sessionId, env, 9999)
    }
  }, [sessionId, env])

  return { sendPrompt, stopAgent, respondToPermission, availableCommands, historyMeta, loadFullHistory }
}
