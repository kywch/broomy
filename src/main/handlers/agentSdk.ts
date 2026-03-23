/**
 * IPC handlers for the Claude Agent SDK integration.
 *
 * Each user message starts a new query() call. Multi-turn context is maintained
 * via the SDK's session resume feature (passing the session ID from the previous
 * query). The SDK process exits after each query completes.
 */
import { BrowserWindow, IpcMain } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import { HandlerContext } from './types'
import { resolveCommand } from '../platform'
import type { AgentSdkMessage, AgentSdkPermissionRequest } from '../../shared/agentSdkTypes'

interface PendingPermission {
  resolve: (result: { behavior: 'allow' } | { behavior: 'deny'; message: string }) => void
}

interface ActiveSession {
  sdkSessionId?: string
  abortController: AbortController
  ownerWindow: BrowserWindow
  pendingPermission: PendingPermission | null
  queryObj?: { close(): void }
}

// Module-local state
const activeSessions = new Map<string, ActiveSession>()

let messageCounter = 0
function nextMessageId(): string {
  return `sdk-msg-${String(++messageCounter)}-${String(Date.now())}`
}

function sendMsg(win: BrowserWindow, sessionId: string, msg: AgentSdkMessage): void {
  win.webContents.send(`agentSdk:message:${sessionId}`, msg)
}

function processSystemMessage(sessionId: string, sdkMessage: Record<string, unknown>, win: BrowserWindow): void {
  const session = activeSessions.get(sessionId)
  if (session && typeof sdkMessage.session_id === 'string') {
    session.sdkSessionId = sdkMessage.session_id
  }
  const model = typeof sdkMessage.model === 'string' ? sdkMessage.model : 'unknown'
  sendMsg(win, sessionId, {
    id: nextMessageId(),
    type: 'system',
    timestamp: Date.now(),
    text: `Session initialized (model: ${model})`,
  })
}

function processAssistantMessage(sessionId: string, sdkMessage: Record<string, unknown>, win: BrowserWindow): void {
  const message = sdkMessage.message as Record<string, unknown> | undefined
  if (!message) return
  const content = message.content as Record<string, unknown>[] | undefined
  if (!content) return
  const parentId = (sdkMessage.parent_tool_use_id as string | null) ?? null

  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      sendMsg(win, sessionId, {
        id: nextMessageId(),
        type: 'text',
        timestamp: Date.now(),
        text: block.text,
        parentToolUseId: parentId,
      })
    } else if (block.type === 'tool_use') {
      sendMsg(win, sessionId, {
        id: nextMessageId(),
        type: 'tool_use',
        timestamp: Date.now(),
        toolName: block.name as string,
        toolInput: block.input as Record<string, unknown>,
        toolUseId: block.id as string,
        parentToolUseId: parentId,
      })
    }
  }
}

function processUserMessage(sessionId: string, sdkMessage: Record<string, unknown>, win: BrowserWindow): void {
  const message = sdkMessage.message as Record<string, unknown> | undefined
  if (!message) return
  const content = message.content as Record<string, unknown>[] | undefined
  if (!content) return
  const parentId = (sdkMessage.parent_tool_use_id as string | null) ?? null

  for (const block of content) {
    if (block.type !== 'tool_result') continue
    const resultContent = block.content as string | Record<string, unknown>[] | undefined
    let resultText = ''
    if (typeof resultContent === 'string') {
      resultText = resultContent
    } else if (Array.isArray(resultContent)) {
      resultText = resultContent
        .filter((c) => c.type === 'text')
        .map((c) => c.text as string)
        .join('\n')
    }
    if (resultText.length > 5000) {
      resultText = `${resultText.slice(0, 5000)}\n... (truncated)`
    }
    sendMsg(win, sessionId, {
      id: nextMessageId(),
      type: 'tool_result',
      timestamp: Date.now(),
      toolUseId: block.tool_use_id as string,
      toolResult: resultText,
      isError: (block.is_error as boolean | undefined) === true,
      parentToolUseId: parentId,
    })
  }
}

function processResultMessage(sessionId: string, sdkMessage: Record<string, unknown>, win: BrowserWindow): void {
  sendMsg(win, sessionId, {
    id: nextMessageId(),
    type: 'result',
    timestamp: Date.now(),
    result: typeof sdkMessage.result === 'string' ? sdkMessage.result : undefined,
    costUsd: sdkMessage.total_cost_usd as number | undefined,
    durationMs: sdkMessage.duration_ms as number | undefined,
    numTurns: sdkMessage.num_turns as number | undefined,
  })
}

function processAndSendMessage(
  sessionId: string,
  sdkMessage: Record<string, unknown>,
  win: BrowserWindow,
): void {
  const type = sdkMessage.type as string

  if (type === 'system' && sdkMessage.subtype === 'init') {
    processSystemMessage(sessionId, sdkMessage, win)
  } else if (type === 'assistant') {
    processAssistantMessage(sessionId, sdkMessage, win)
  } else if (type === 'user') {
    processUserMessage(sessionId, sdkMessage, win)
  } else if (type === 'result') {
    processResultMessage(sessionId, sdkMessage, win)
  }
}

// Expand ~ to home directory in env var values (same as pty.ts)
function expandHome(value: string): string {
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  if (value === '~') return homedir()
  return value
}

/**
 * Run a single SDK query. Each message gets its own query() call.
 * Multi-turn context is maintained via resume with the SDK session ID.
 */
async function runSdkQuery(
  sessionId: string,
  prompt: string,
  cwd: string,
  win: BrowserWindow,
  options: {
    sdkSessionId?: string
    skipApproval: boolean
    env?: Record<string, string>
  },
): Promise<void> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')

  const abortController = new AbortController()

  const session: ActiveSession = {
    sdkSessionId: options.sdkSessionId,
    abortController,
    ownerWindow: win,
    pendingPermission: null,
  }
  activeSessions.set(sessionId, session)

  // Build env: process.env as base, agent-specific env vars merged on top
  const agentEnv: Record<string, string> = {}
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      agentEnv[key] = expandHome(value)
    }
  }
  const env = { ...process.env, ...agentEnv }

  const queryOptions: Record<string, unknown> = {
    abortController,
    cwd,
    env,
    tools: { type: 'preset', preset: 'claude_code' },
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project'],
  }

  if (options.sdkSessionId && options.sdkSessionId.length > 0) {
    queryOptions.resume = options.sdkSessionId
  }

  if (options.skipApproval) {
    queryOptions.permissionMode = 'bypassPermissions'
    queryOptions.allowDangerouslySkipPermissions = true
  } else {
    queryOptions.canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      canUseToolOptions: { toolUseID: string; decisionReason?: string },
    ) => {
      const permReq: AgentSdkPermissionRequest = {
        id: `perm-${String(Date.now())}`,
        toolName,
        toolInput: input,
        toolUseId: canUseToolOptions.toolUseID,
        decisionReason: canUseToolOptions.decisionReason,
      }
      win.webContents.send(`agentSdk:permission:${sessionId}`, permReq)

      return new Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }>((resolve) => {
        const activeSession = activeSessions.get(sessionId)
        if (activeSession) {
          activeSession.pendingPermission = { resolve }
        }
      })
    }
  }

  const queryObj = query({
    prompt,
    options: queryOptions as Parameters<typeof query>[0]['options'],
  })
  session.queryObj = queryObj

  try {
    for await (const message of queryObj) {
      if (!activeSessions.has(sessionId)) break
      processAndSendMessage(sessionId, message as unknown as Record<string, unknown>, win)
    }
    const sdkSessionId = session.sdkSessionId ?? ''
    win.webContents.send(`agentSdk:done:${sessionId}`, sdkSessionId)
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    if (!errorMessage.includes('aborted')) {
      win.webContents.send(`agentSdk:error:${sessionId}`, errorMessage)
    }
  } finally {
    activeSessions.delete(sessionId)
  }
}

async function handleLoadHistory(senderWindow: BrowserWindow, sdkSessionId: string, sessionId: string, agentEnv?: Record<string, string>, limit?: number): Promise<void> {
  const configDir = agentEnv?.CLAUDE_CONFIG_DIR
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  if (configDir) process.env.CLAUDE_CONFIG_DIR = expandHome(configDir)

  try {
    const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk')
    const allMessages = await getSessionMessages(sdkSessionId)

    // Only load the last N messages (default 10) for speed.
    // Send total count so the renderer can show "Show earlier".
    const maxMessages = limit ?? 10
    const history = allMessages.length > maxMessages
      ? allMessages.slice(allMessages.length - maxMessages)
      : allMessages

    // Tell the renderer how many total messages exist so it can show a "load more" button
    if (allMessages.length > maxMessages) {
      senderWindow.webContents.send(`agentSdk:historyMeta:${sessionId}`, {
        total: allMessages.length,
        loaded: history.length,
      })
    }

    for (const entry of history) {
      const entryType = (entry as Record<string, unknown>).type as string
      const message = (entry as Record<string, unknown>).message as Record<string, unknown> | undefined
      if (!message) continue
      const content = message.content as Record<string, unknown>[] | string | undefined
      if (!content) continue

      const idPrefix = entryType === 'user' ? 'history-user' : 'history-asst'
      const blocks = typeof content === 'string'
        ? [{ type: 'text', text: content }] as Record<string, unknown>[]
        : Array.isArray(content) ? content : []

      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          sendMsg(senderWindow, sessionId, {
            id: `${idPrefix}-${nextMessageId()}`, type: 'text', timestamp: Date.now(), text: block.text,
          })
        } else if (entryType === 'assistant' && block.type === 'tool_use') {
          sendMsg(senderWindow, sessionId, {
            id: `history-tool-${nextMessageId()}`, type: 'tool_use', timestamp: Date.now(),
            toolName: block.name as string, toolInput: block.input as Record<string, unknown>, toolUseId: block.id as string,
          })
        }
      }
    }
  } finally {
    if (configDir) {
      if (prevConfigDir) process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      else delete process.env.CLAUDE_CONFIG_DIR
    }
  }
}

async function handleStatus(senderWindow: BrowserWindow, sessionId: string, agentEnv?: Record<string, string>): Promise<void> {
  const session = activeSessions.get(sessionId)
  const rows: [string, string][] = [
    ['Status', session ? 'Active' : 'Idle'],
    ['Session', session?.sdkSessionId ?? 'none'],
  ]

  try {
    const configDir = agentEnv?.CLAUDE_CONFIG_DIR
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    if (configDir) process.env.CLAUDE_CONFIG_DIR = expandHome(configDir)

    const { query: sdkQuery } = await import('@anthropic-ai/claude-agent-sdk')
    const q = sdkQuery({
      prompt: '/cost',
      options: { env: process.env, settingSources: ['user'], maxTurns: 0 },
    })
    const account = await q.accountInfo()
    if (account.email) rows.push(['Account', account.email])
    if (account.subscriptionType) rows.push(['Plan', account.subscriptionType])
    q.close()

    if (configDir) {
      if (prevConfigDir) process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      else delete process.env.CLAUDE_CONFIG_DIR
    }
  } catch {
    // Ignore
  }

  const tableRows = rows.map(([k, v]) => `| **${k}** | ${v} |`).join('\n')
  const table = `| | |\n|---|---|\n${tableRows}`

  sendMsg(senderWindow, sessionId, {
    id: nextMessageId(), type: 'result', timestamp: Date.now(), result: table,
  })
  senderWindow.webContents.send(`agentSdk:done:${sessionId}`, session?.sdkSessionId ?? '')
}

async function handleFetchCommands(agentEnv?: Record<string, string>): Promise<{ name: string; description: string }[]> {
  const configDir = agentEnv?.CLAUDE_CONFIG_DIR
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  if (configDir) process.env.CLAUDE_CONFIG_DIR = expandHome(configDir)

  try {
    const { query: sdkQuery } = await import('@anthropic-ai/claude-agent-sdk')
    const q = sdkQuery({
      prompt: '/cost',
      options: {
        env: process.env,
        tools: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project'],
        maxTurns: 0,
      },
    })
    const cmds = await q.supportedCommands()
    q.close()
    return cmds.map((c: Record<string, unknown>) => ({
      name: c.name as string,
      description: (typeof c.description === 'string' ? c.description : '').split('\n')[0].slice(0, 80),
    }))
  } catch {
    return []
  } finally {
    if (configDir) {
      if (prevConfigDir) process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      else delete process.env.CLAUDE_CONFIG_DIR
    }
  }
}

export function register(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('agentSdk:start', (_event, options: {
    id: string
    prompt: string
    cwd: string
    sdkSessionId?: string
    skipApproval: boolean
    env?: Record<string, string>
  }) => {
    if (ctx.isE2ETest) {
      const senderWindow = BrowserWindow.fromWebContents(_event.sender)
      if (!senderWindow) return { id: options.id }

      const initMsg: AgentSdkMessage = {
        id: nextMessageId(),
        type: 'system',
        timestamp: Date.now(),
        text: 'Session initialized (model: claude-sonnet-4-20250514)',
      }
      senderWindow.webContents.send(`agentSdk:message:${options.id}`, initMsg)

      setTimeout(() => {
        const textMsg: AgentSdkMessage = {
          id: nextMessageId(),
          type: 'text',
          timestamp: Date.now(),
          text: "I'll help you with that. Let me look at the codebase.",
        }
        senderWindow.webContents.send(`agentSdk:message:${options.id}`, textMsg)

        setTimeout(() => {
          const resultMsg: AgentSdkMessage = {
            id: nextMessageId(),
            type: 'result',
            timestamp: Date.now(),
            result: 'Task completed successfully.',
            costUsd: 0.01,
            durationMs: 2000,
            numTurns: 1,
          }
          senderWindow.webContents.send(`agentSdk:message:${options.id}`, resultMsg)
          senderWindow.webContents.send(`agentSdk:done:${options.id}`, 'mock-session-id')
        }, 500)
      }, 200)

      return { id: options.id }
    }

    const senderWindow = BrowserWindow.fromWebContents(_event.sender)
    if (!senderWindow) return { id: options.id }

    // Kill any existing session with the same ID
    const existing = activeSessions.get(options.id)
    if (existing) {
      existing.abortController.abort()
      activeSessions.delete(options.id)
    }

    void runSdkQuery(options.id, options.prompt, options.cwd, senderWindow, {
      sdkSessionId: options.sdkSessionId,
      skipApproval: options.skipApproval,
      env: options.env,
    })

    return { id: options.id }
  })

  // Send is now the same as start — each message is a new query() with resume
  ipcMain.handle('agentSdk:send', (_event, id: string, prompt: string, sdkSessionId?: string) => {
    const existing = activeSessions.get(id)
    if (existing) {
      existing.abortController.abort()
      activeSessions.delete(id)
    }

    const senderWindow = BrowserWindow.fromWebContents(_event.sender)
    if (!senderWindow) return

    void runSdkQuery(id, prompt, process.cwd(), senderWindow, {
      sdkSessionId,
      skipApproval: false,
    })
  })

  ipcMain.handle('agentSdk:stop', (_event, id: string) => {
    const session = activeSessions.get(id)
    if (session) {
      session.abortController.abort()
      if (session.queryObj) {
        (session.queryObj as { close(): void }).close()
      }
      activeSessions.delete(id)
    }
  })

  ipcMain.handle('agentSdk:respond', (_event, id: string, _toolUseId: string, allowed: boolean, updatedInput?: Record<string, unknown>) => {
    const session = activeSessions.get(id)
    if (session?.pendingPermission) {
      if (allowed) {
        session.pendingPermission.resolve({
          behavior: 'allow',
          ...(updatedInput ? { updatedInput } : {}),
        })
      } else {
        session.pendingPermission.resolve({ behavior: 'deny', message: 'User denied permission' })
      }
      session.pendingPermission = null
    }
  })

  ipcMain.handle('agentSdk:loadHistory', async (_event, sdkSessionId: string, sessionId: string, agentEnv?: Record<string, string>, limit?: number) => {
    if (ctx.isE2ETest || !sdkSessionId || sdkSessionId.length === 0) return
    const senderWindow = BrowserWindow.fromWebContents(_event.sender)
    if (!senderWindow) return
    try {
      await handleLoadHistory(senderWindow, sdkSessionId, sessionId, agentEnv, limit)
    } catch (err) {
      console.warn('[agentSdk] Failed to load history:', err instanceof Error ? err.message : err)
    }
  })

  // Handle /login — spawns `claude login` which opens a browser for OAuth
  ipcMain.handle('agentSdk:login', (_event, sessionId: string) => {
    const senderWindow = BrowserWindow.fromWebContents(_event.sender)
    if (!senderWindow) return

    const claudePath = resolveCommand('claude') ?? 'claude'
    const child = spawn(claudePath, ['login'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    child.stdout.on('data', (data: Buffer) => { output += data.toString() })
    child.stderr.on('data', (data: Buffer) => { output += data.toString() })

    sendMsg(senderWindow, sessionId, {
      id: nextMessageId(),
      type: 'system',
      timestamp: Date.now(),
      text: 'Opening browser for login...',
    })

    child.on('close', (code) => {
      const success = code === 0
      sendMsg(senderWindow, sessionId, {
        id: nextMessageId(),
        type: success ? 'system' : 'error',
        timestamp: Date.now(),
        text: success
          ? 'Login successful. You can now send messages.'
          : `Login failed (exit ${String(code)}). ${output.trim()}`,
      })
      senderWindow.webContents.send(`agentSdk:done:${sessionId}`, '')
    })
  })

  ipcMain.handle('agentSdk:status', async (_event, sessionId: string, agentEnv?: Record<string, string>) => {
    const senderWindow = BrowserWindow.fromWebContents(_event.sender)
    if (!senderWindow) return
    await handleStatus(senderWindow, sessionId, agentEnv)
  })

  ipcMain.handle('agentSdk:commands', async (_event, agentEnv?: Record<string, string>) => {
    return handleFetchCommands(agentEnv)
  })
}
