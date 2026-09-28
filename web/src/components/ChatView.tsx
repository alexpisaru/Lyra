import { useEffect, useRef } from 'react'
import type { ChatController } from '../hooks/useChat'
import type { VoiceSession } from '../voice/types'
import type { LyraStatus, Pack } from '../types/api'
import { prepareNote } from '../lib/notes'
import { ChatComposer, PACK_LABEL } from './ChatComposer'
import { NoteMarkdown } from './NoteMarkdown'
import { ResetIcon } from './icons'

interface ChatViewProps {
  chat: ChatController
  status: LyraStatus | null
  online: boolean
  /** what Lyra is doing right now (from the live runtime), shown while waiting */
  working?: string | null
  voice?: VoiceSession
}

const ALL_PACKS: Pack[] = ['auto', 'chat', 'general', 'files', 'memory', 'knowledge', 'browser']

/** Conversation as typography: discreet user line, Lyra's answer in the foreground. */
export function ChatView({ chat, status, online, working, voice }: ChatViewProps) {
  const end = useRef<HTMLDivElement>(null)
  const packs = status ? ALL_PACKS.filter((p) => p !== 'browser' || status.browser.enabled) : ALL_PACKS

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chat.turns.length, chat.pending])

  const submit = async (text: string) => {
    chat.setDraft('')
    const ok = await chat.send(text)
    if (!ok) chat.setDraft((current) => current || text)
  }

  return (
    <section className="view chat-view" aria-label="Chat">
      <div className="chat-scroll">
        <div className="chat-thread" aria-live="polite">
          {chat.turns.map((turn) =>
            turn.role === 'user' ? (
              <p key={turn.id} className="turn-user">
                {turn.text}
              </p>
            ) : (
              <article key={turn.id} className="turn-lyra" data-error={turn.error || undefined}>
                {turn.error ? (
                  <p className="turn-text">{turn.text}</p>
                ) : (
                  <NoteMarkdown className="turn-text markdown" markdown={prepareNote(turn.text)} />
                )}
                {turn.tools?.length || turn.incomplete ? (
                  <p className="turn-meta">
                    {turn.tools?.map((tool, index) => (
                      <span key={`${tool.name}-${index}`} data-ok={tool.success}>
                        {tool.name}
                        {tool.success ? ' ✓' : ' ✕'}
                      </span>
                    ))}
                    {turn.incomplete ? <span data-ok="false">risultato non verificato</span> : null}
                  </p>
                ) : null}
              </article>
            ),
          )}
          {chat.pending ? <p className="turn-pending">{working ?? 'Lyra sta elaborando'}</p> : null}
          <div ref={end} />
        </div>
      </div>
      <div className="chat-dock">
        {chat.turns.length > 0 ? (
          <button type="button" className="chat-reset" onClick={() => void chat.reset()} disabled={chat.pending}>
            <ResetIcon size={15} /> Nuova conversazione
          </button>
        ) : null}
        {!online ? <p className="chat-offline">Lyra non raggiungibile</p> : null}
        <ChatComposer
          value={chat.draft}
          onChange={chat.setDraft}
          onSubmit={(text) => void submit(text)}
          pack={chat.pack}
          onPackChange={chat.setPack}
          packs={packs}
          pending={chat.pending}
          voice={voice}
        />
        {chat.pack !== 'auto' ? <span className="sr-only">Pack attivo: {PACK_LABEL[chat.pack]}</span> : null}
      </div>
    </section>
  )
}
