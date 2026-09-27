import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Pack } from '../types/api'
import { BrainIcon, GlobeIcon, PlusIcon, SendIcon } from './icons'

export const PACK_LABEL: Record<Pack, string> = {
  auto: 'Auto',
  chat: 'Solo chat',
  general: 'Calcolo',
  files: 'File',
  memory: 'Memoria',
  knowledge: 'Knowledge',
  browser: 'Browser',
}

const PACK_HINT: Record<Pack, string> = {
  auto: 'Lyra sceglie da sola',
  chat: 'Nessuno strumento',
  general: 'Calcolatrice',
  files: 'File nel workspace',
  memory: 'Ricordi personali',
  knowledge: 'Note del vault',
  browser: 'Pagine web',
}

interface ChatComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (text: string) => void
  pack: Pack
  onPackChange: (pack: Pack) => void
  packs: Pack[]
  disabled?: boolean
  pending?: boolean
}

/**
 * [+ pack] Come posso aiutarti?   [knowledge] [browser] [send]
 * Book and globe are pack shortcuts, not uploads: the API has no file upload.
 */
export function ChatComposer({
  value,
  onChange,
  onSubmit,
  pack,
  onPackChange,
  packs,
  disabled,
  pending,
}: ChatComposerProps) {
  const [menu, setMenu] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const root = useRef<HTMLFormElement>(null)

  useEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`
  }, [value])

  useEffect(() => {
    if (!menu) return
    const close = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setMenu(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menu])

  const canSend = value.trim().length > 0 && !pending && !disabled

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (canSend) onSubmit(value)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const toggle = (target: Pack) => onPackChange(pack === target ? 'auto' : target)
  const has = (target: Pack) => packs.includes(target)

  return (
    <form ref={root} className="composer" onSubmit={submit} data-pending={pending}>
      <div className="composer-pack">
        <button
          type="button"
          className="composer-icon"
          aria-label="Scegli il gruppo di strumenti"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((open) => !open)}
        >
          <PlusIcon size={22} />
        </button>
        {menu ? (
          <ul className="pack-menu" role="menu">
            {packs.map((option) => (
              <li key={option}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={pack === option}
                  onClick={() => {
                    onPackChange(option)
                    setMenu(false)
                    input.current?.focus()
                  }}
                >
                  <span>{PACK_LABEL[option]}</span>
                  <small>{PACK_HINT[option]}</small>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {pack !== 'auto' ? (
        <button type="button" className="pack-chip" onClick={() => onPackChange('auto')} aria-label={`Pack ${PACK_LABEL[pack]}, torna ad Auto`}>
          {PACK_LABEL[pack]} <span aria-hidden="true">×</span>
        </button>
      ) : null}
      <label className="sr-only" htmlFor="lyra-composer">
        Messaggio per Lyra
      </label>
      <textarea
        id="lyra-composer"
        ref={input}
        className="composer-input"
        placeholder="Come posso aiutarti?"
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        enterKeyHint="send"
        autoComplete="off"
        maxLength={4000}
      />
      <div className="composer-actions">
        {has('knowledge') ? (
          <button
            type="button"
            className="composer-icon"
            aria-pressed={pack === 'knowledge'}
            aria-label="Cerca nelle note (Knowledge)"
            title="Knowledge"
            onClick={() => toggle('knowledge')}
          >
            <BrainIcon size={21} />
          </button>
        ) : null}
        {has('browser') ? (
          <button
            type="button"
            className="composer-icon"
            aria-pressed={pack === 'browser'}
            aria-label="Usa il browser"
            title="Browser"
            onClick={() => toggle('browser')}
          >
            <GlobeIcon size={21} />
          </button>
        ) : null}
        <button type="submit" className="composer-send" disabled={!canSend} aria-label="Invia">
          <SendIcon size={20} />
        </button>
      </div>
    </form>
  )
}
