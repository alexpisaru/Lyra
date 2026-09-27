// Mirrors the Lyra API 0.3.0 contract (src/openjarvis/api.py, docs/API.md).

export type Pack = 'auto' | 'chat' | 'general' | 'files' | 'memory' | 'knowledge' | 'browser'

export type RuntimeState = 'idle' | 'thinking' | 'using_tool' | 'error'

export interface LyraStatus {
  status: 'ok'
  name: string
  version: string
  state: RuntimeState
  busy: boolean
  model: { provider: string; model: string; reachable: boolean }
  memory: { enabled: boolean }
  knowledge: { enabled: boolean }
  browser: { enabled: boolean; backend: string | null }
  packs: Pack[]
}

export interface ToolResult {
  tool_name: string
  content: string
  success: boolean
  metadata?: Record<string, unknown>
}

export interface ChatResponse {
  content: string
  pack: Exclude<Pack, 'auto'> | null
  turns: number
  complete: boolean
  tool_results: ToolResult[]
  metadata: Record<string, unknown>
}

export interface SearchResult {
  path: string
  excerpt: string
}

export interface SearchResponse {
  results: SearchResult[]
  skipped: number
}

export interface NoteResponse {
  path: string
  content: string
}

/** Events sent by GET /ws. */
export type LyraEvent =
  | { type: 'state'; state: RuntimeState }
  | { type: 'tool_started'; tool: string }
  | { type: 'tool_finished'; tool: string; success: boolean }
  | { type: 'response'; content: string }
  | { type: 'error'; message: string }
