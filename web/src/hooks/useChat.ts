import { useCallback, useRef, useState } from 'react'
import { api, ApiError, describeError } from '../lib/api'
import type { Pack } from '../types/api'
import type { ConverseResult } from '../voice/conversation'

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
  // Typed and spoken turns share one conversation: never two requests at once.
  const inFlight = useRef(false)

  const add = useCallback((turn: Omit<ChatTurn, 'id'>) => {
    const id = nextId.current
    nextId.current += 1
    setTurns((current) => [...current, { ...turn, id }])
  }, [])

  /** One exchange with Lyra; typed Chat and Lyra Voice both come through here. */
  const converse = useCallback(
    async (text: string, packOverride?: Pack): Promise<ConverseResult> => {
      const message = text.trim()
      if (!message) return { ok: false, reply: null }
      if (inFlight.current) return { ok: false, reply: null, error: 'Lyra sta già lavorando a una richiesta' }
      inFlight.current = true
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
        return { ok: true, reply: reply.content }
      } catch (error) {
        const detail =
          error instanceof ApiError && error.kind === 'invalid' && /capability|pack/i.test(error.message)
            ? 'Richiesta con più capacità: scegli un pack con + e riprova.'
            : describeError(error)
        add({ role: 'lyra', text: detail, error: true })
        return { ok: false, reply: null, error: detail }
      } finally {
        inFlight.current = false
        setPending(false)
      }
    },
    [add, pack],
  )

  const send = useCallback(
    async (text: string, packOverride?: Pack) => (await converse(text, packOverride)).ok,
    [converse],
  )

  const reset = useCallback(async () => {
    try {
      await api.resetChat()
    } catch {
      // Clearing the local view is still what the user asked for.
    }
    setTurns([])
  }, [])

  return { turns, pending, draft, setDraft, pack, setPack, send, converse, reset }
}

export type ChatController = ReturnType<typeof useChat>
