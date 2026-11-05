/**
 * Renders a ```mermaid fence as a diagram once its source settles.
 *
 * Mermaid is loaded from its prebuilt UMD bundle rather than the ESM entry:
 * the ESM graph's `default` export is dropped when the app bundles it (the
 * emitted chunk exports only minified internals), which left every diagram
 * falling back to source text. The UMD build assigns `globalThis.mermaid`
 * itself and survives bundling intact.
 *
 * While streaming, the fence shows through CodeBlock; re-parsing a
 * half-written diagram would flash an error on every chunk.
 *
 * @module
 */
import { useEffect, useState, type ReactNode } from 'react'

/** Props for {@link MermaidBlock}. */
export interface MermaidBlockProps {
  /** Diagram source exactly as authored inside the fence. */
  code: string
}

/** The subset of the Mermaid API this block calls. */
interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, code: string) => Promise<{ svg: string }>
}

/** Where the UMD bundle leaves its export. */
type MermaidGlobal = typeof globalThis & { mermaid?: MermaidApi }

const SCRIPT_ID = 'dsh-mermaid-umd'
let loading: Promise<MermaidApi> | undefined

/**
 * Load the Mermaid UMD bundle once per page and initialize it.
 * @returns The initialized global Mermaid API.
 */
function loadMermaid(): Promise<MermaidApi> {
  loading ??= new Promise<MermaidApi>((resolve, reject) => {
    const ready = (): void => {
      const api = (globalThis as MermaidGlobal).mermaid
      if (api === undefined) {
        reject(new Error('mermaid: UMD bundle did not publish globalThis.mermaid'))
        return
      }
      const source = document.documentElement.dataset.dsThemeSource
      const dark = source === 'dark'
        || (source === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
      api.initialize({
        startOnLoad: false,
        theme: dark ? 'dark' : 'default',
        securityLevel: 'strict',
        fontFamily: 'inherit',
      })
      resolve(api)
    }
    if ((globalThis as MermaidGlobal).mermaid !== undefined) {
      ready()
      return
    }
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null
    if (existing !== null) {
      existing.addEventListener('load', ready, { once: true })
      existing.addEventListener('error', () => reject(new Error('mermaid: bundle failed to load')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.id = SCRIPT_ID
    // Resolve beside this app's own assets rather than a hardcoded root: the
    // GUI is served under a token path, so `/assets/...` can be rewritten or
    // blocked. A missing base falls back to the root form.
    script.src = new URL('assets/mermaid.umd.js', document.baseURI).href
    script.async = true
    script.addEventListener('load', ready, { once: true })
    script.addEventListener('error', () => reject(new Error('mermaid: bundle failed to load')), { once: true })
    document.head.append(script)
  })
  return loading
}

/**
 * Diagram block; falls back to the source text when Mermaid cannot parse it.
 * @param props - the fence source.
 * @returns The rendered SVG, its source as a fallback, or nothing while loading.
 */
export function MermaidBlock({ code }: MermaidBlockProps): ReactNode {
  const [svg, setSvg] = useState<string>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setFailed(false)
    const id = `mermaid-${Math.random().toString(36).slice(2)}`
    loadMermaid()
      .then(api => api.render(id, code))
      .then(result => { if (live) setSvg(result.svg) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [code])

  if (failed) return <pre className="mermaid-source">{code}</pre>
  if (svg === undefined) return null
  // Mermaid's own sanitized output under `securityLevel: 'strict'`.
  return <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />
}
