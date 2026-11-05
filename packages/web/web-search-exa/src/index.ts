/**
 * Exa-backed search provider for `ctx.web`.
 *
 * The harness ships only DeepSeek search providers, so `web_search` is dead
 * without a DeepSeek key. Exa needs a plain API key and returns page text with
 * each hit, so the model gets excerpts rather than bare links.
 *
 * @module @deepseek-ai/dsh-web-search-exa
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

export const name = 'web-search-exa'
export const inject = ['web']

const ENDPOINT = 'https://api.exa.ai/search'

/** One row from Exa's search response. */
interface ExaResult {
  readonly url?: string
  readonly title?: string
  readonly text?: string
  readonly publishedDate?: string
}

/**
 * Read the key at call time so a rotated key applies without a restart.
 * @returns the key, or undefined when unset.
 */
function apiKey(): string | undefined {
  const fromEnv = process.env.EXA_API_KEY
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  // A key written after the Host started is absent from its environment, so
  // read the shared file each call; available() must stay sync and offline.
  try {
    const text = readFileSync(join(homedir(), '.dsh/.env'), 'utf8')
    const hit = /^EXA_API_KEY="?([^"\n]+)"?/m.exec(text)
    return hit === null ? undefined : hit[1]
  } catch {
    return undefined
  }
}

/**
 * Run one Exa search and normalise it into the seam's result shape.
 * @param key - the Exa API key.
 * @param request - the query and optional result bound.
 * @param signal - caller cancellation.
 * @returns citeable sources in seam form.
 */
async function searchExa(
  key: string, request: WebSearchRequest, signal?: AbortSignal,
): Promise<WebSearchResult> {
  const body: Record<string, unknown> = {
    query: request.query,
    // Ask for page text: a source without an excerpt forces a second fetch and
    // the model cannot judge a bare URL.
    contents: { text: { maxCharacters: 1200 } },
  }
  if (request.maxResults !== undefined) body['numResults'] = request.maxResults
  const init: RequestInit = {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
  if (signal !== undefined) init.signal = signal
  const res = await fetch(ENDPOINT, init)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error('exa search failed: HTTP ' + res.status + ' ' + text.slice(0, 200))
  }
  const data = await res.json() as { results?: ExaResult[] }
  const sources: WebSearchSource[] = []
  for (const r of data.results ?? []) {
    if (typeof r.url !== 'string' || r.url === '') continue
    const text = r.text ?? ''
    sources.push({
      url: r.url,
      ...r.title === undefined ? {} : { title: r.title },
      ...text === '' ? {} : { snippet: text.slice(0, 300) },
      ...text === '' ? {} : { summary: text },
      ...r.publishedDate === undefined ? {} : { publishedAt: r.publishedDate },
    })
  }
  return { sources, truncated: false }
}

/**
 * Register the provider; `available()` is credential presence only.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.web.registerSearchProvider({
    id: 'exa',
    title: 'Exa',
    available: () => apiKey() !== undefined,
    async search(request, signal) {
      const key = apiKey()
      if (key === undefined) throw new Error('exa search: EXA_API_KEY is not set')
      return await searchExa(key, request, signal)
    },
  }), 'web-search-exa provider')
}
