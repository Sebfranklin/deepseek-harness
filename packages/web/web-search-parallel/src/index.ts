/**
 * Parallel-backed search provider for `ctx.web`.
 *
 * The harness ships only DeepSeek search providers, so `web_search` is dead
 * whenever no DeepSeek key is configured. This registers Parallel's Search API
 * as a provider, so the native tool works and every internal consumer of
 * `ctx.web.search()` gets results.
 *
 * @module @deepseek-ai/dsh-web-search-parallel
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

export const name = 'web-search-parallel'
export const inject = ['web']

const ENDPOINT = 'https://api.parallel.ai/v1/search'

/** One result row from Parallel's Search API. */
interface ParallelResult {
  readonly url?: string
  readonly title?: string
  readonly publish_date?: string | null
  readonly excerpts?: readonly string[]
}

/**
 * Read the key at call time, never at module load, so a rotated key is used
 * by the next request without a restart.
 * @returns the key, or undefined when unset.
 */
function apiKey(): string | undefined {
  const fromEnv = process.env.PARALLEL_API_KEY
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  // The host process starts before a key written later exists in its
  // environment, so a key added at runtime is invisible to process.env. Read
  // the shared env file each call: a rotated key takes effect immediately and
  // available() stays a sync, network-free check.
  try {
    const text = readFileSync(join(homedir(), '.dsh/.env'), 'utf8')
    const hit = /^PARALLEL_API_KEY="?([^"\n]+)"?/m.exec(text)
    return hit === null ? undefined : hit[1]
  } catch {
    return undefined
  }
}

/**
 * Run one Parallel search and normalise it into the seam's result shape.
 * @param key - the Parallel API key.
 * @param request - the query and optional result bound.
 * @param signal - caller cancellation.
 * @returns citeable sources in seam form.
 */
async function searchParallel(
  key: string, request: WebSearchRequest, signal?: AbortSignal,
): Promise<WebSearchResult> {
  // max_results lives inside advanced_settings; sent top-level the API rejects
  // the whole request with 422 extra_forbidden.
  const advanced: Record<string, unknown> = {}
  if (request.maxResults !== undefined) advanced['max_results'] = request.maxResults
  const body: Record<string, unknown> = {
    objective: request.query,
    search_queries: [request.query],
    ...Object.keys(advanced).length === 0 ? {} : { advanced_settings: advanced },
  }
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
  if (signal !== undefined) init.signal = signal
  const res = await fetch(ENDPOINT, init)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error('parallel search failed: HTTP ' + res.status + ' ' + text.slice(0, 200))
  }
  const data = await res.json() as { results?: ParallelResult[] }
  const rows = data.results ?? []
  const sources: WebSearchSource[] = []
  for (const r of rows) {
    if (typeof r.url !== 'string' || r.url === '') continue
    const excerpts = r.excerpts ?? []
    sources.push({
      url: r.url,
      ...r.title === undefined ? {} : { title: r.title },
      ...excerpts[0] === undefined ? {} : { snippet: excerpts[0] },
      ...excerpts.length === 0 ? {} : { summary: excerpts.join('\n\n') },
      ...r.publish_date === null || r.publish_date === undefined
        ? {} : { publishedAt: r.publish_date },
    })
  }
  return { sources, truncated: false }
}

/**
 * Register the provider. `available()` is credential presence only and makes
 * no network call, as the seam requires.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.web.registerSearchProvider({
    id: 'parallel',
    title: 'Parallel',
    available: () => apiKey() !== undefined,
    async search(request, signal) {
      const key = apiKey()
      if (key === undefined) throw new Error('parallel search: PARALLEL_API_KEY is not set')
      return await searchParallel(key, request, signal)
    },
  }), 'web-search-parallel provider')
}
