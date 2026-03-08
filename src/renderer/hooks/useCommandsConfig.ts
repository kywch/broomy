/**
 * Hook that loads and watches commands.json for the active session's directory.
 * Returns null when no commands.json exists (prompting the setup banner).
 */
import { useState, useEffect } from 'react'
import type { CommandsConfig } from '../utils/commandsConfig'
import { loadCommandsConfig } from '../utils/commandsConfig'

export function useCommandsConfig(directory: string | undefined): {
  config: CommandsConfig | null
  loading: boolean
  exists: boolean
  error: string | null
} {
  const [config, setConfig] = useState<CommandsConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [exists, setExists] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!directory) {
      setConfig(null)
      setLoading(false)
      setExists(false)
      setError(null)
      return
    }

    let cancelled = false

    async function load() {
      setLoading(true)
      const result = await loadCommandsConfig(directory!)
      if (!cancelled) {
        if (result === null) {
          setConfig(null)
          setExists(false)
          setError(null)
        } else if (!result.ok) {
          setConfig(null)
          setExists(true)
          setError(result.error)
        } else {
          setConfig(result.config)
          setExists(true)
          setError(null)
        }
        setLoading(false)
      }
    }

    void load()

    // Watch for changes to commands.json
    const watcherId = `commands-config-${directory}`
    const broomyDir = `${directory}/.broomy`
    void window.fs.watch(watcherId, broomyDir)
    const removeListener = window.fs.onChange(watcherId, (event: { eventType: string; filename: string | null }) => {
      if (event.filename && event.filename !== 'commands.json') return
      void load()
    })

    return () => {
      cancelled = true
      removeListener()
      void window.fs.unwatch(watcherId)
    }
  }, [directory])

  return { config, loading, exists, error }
}
