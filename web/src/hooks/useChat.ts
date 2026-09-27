import { useCallback, useRef, useState } from 'react'
import { api, ApiError, describeError } from '../lib/api'
import type { Pack } from '../types/api'

export interface ChatTurn {
  id: number
  role: 'user' | 'lyra'
  text: string
  pack?: string | null
  tools?: { name: string; success: boolean }[]
  incomplete?: boolean
  error?: boolean
}

/**
 * Conversation held at app level so switching Home/Chat/Brain never loses it.
 * The API keeps its own in-RAM context; reset() clears both.
 */
export function useChat() {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [pending, setPending] = useState(false)
  const [draft, setDraft] = useState('')
  const [pack, setPack] = useState<Pack>('auto')
  const nextId = useRef(1)

  const add = useCallback((turn: Omit<ChatTurn, 'id'>) => {
    const id = nextId.current
    nextId.current += 1
    setTurns((current) => [...current, { ...turn, id }])
  }, [])

  const send = useCallback(
    async (text: string, packOverride?: Pack) => {
      const message = text.trim()
      if (!message || pending) return false
      setPending(true)
      add({ role: 'user', text: message })
      try {
        const reply = await api.chat(message, packOverride ?? pack)
        add({
          role: 'lyra',
          text: reply.content || '…',
          pack: reply.pack,
          tools: reply.tool_results.map((t) => ({ name: t.tool_name, success: t.success })),
          incomplete: !reply.complete,
        })
        return true
      } catch (error) {
        const detail =
          error instanceof ApiError && error.kind === 'invalid' && /capability|pack/i.test(error.message)
            ? 'Richiesta con più capacità: scegli un pack con + e riprova.'
            : describeError(error)
        add({ role: 'lyra', text: detail, error: true })
        return false
      } finally {
        setPending(false)
      }
    },
    [add, pack, pending],
  )

  const reset = useCallback(async () => {
    try {
      await api.resetChat()
    } catch {
      // Clearing the local view is still what the user asked for.
    }
    setTurns([])
  }, [])

  return { turns, pending, draft, setDraft, pack, setPack, send, reset }
}

export type ChatController = ReturnType<typeof useChat>
