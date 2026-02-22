import { useSessionStore } from '../store/sessions'

const PROGRESS_INTERVAL_MS = 500

/**
 * Keeps a session in "working" state during an async git operation.
 * Periodically calls updateAgentMonitor to override the terminal's idle detection.
 * When the operation finishes (or throws), the interval is cleared and normal
 * idle detection takes back over.
 */
export async function withGitProgress<T>(
  sessionId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!sessionId) return fn()

  const { updateAgentMonitor } = useSessionStore.getState()
  updateAgentMonitor(sessionId, { status: 'working' })

  const interval = setInterval(() => {
    useSessionStore.getState().updateAgentMonitor(sessionId, { status: 'working' })
  }, PROGRESS_INTERVAL_MS)

  try {
    return await fn()
  } finally {
    clearInterval(interval)
  }
}
