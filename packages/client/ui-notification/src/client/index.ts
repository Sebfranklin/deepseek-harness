/**
 * Frame-wide progress / attention notices shown in `shell.overlay`, so a brief
 * line appears no matter which Session is in front.
 *
 * The store holds the current notice text plus its sequence; every new report
 * bumps the seq so the overlay entry remounts and shows the latest text even
 * if identical. `report` is the public face the schedule reminder (and any
 * other caller) writes into. Notices auto-dismiss after DISMISS_AFTER_MS.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { ProgressNotice } from './ProgressNotice.tsx'

/** The notice currently shown in the overlay, or null while nothing shows. */
export type ProgressNoticeState = {
  /** Brief one-line message. */
  readonly text: string
  /** When it was reported, epoch ms. */
  readonly at: number
  /** Bumps on every report so the entry remounts on identical text. */
  readonly seq: number
}

/** Source the overlay entry reads, plus the public report face. */
export interface ProgressNoticeSource {
  /** @returns current notice state, or null. */
  readonly hooks: { readonly notice: HostObservable<ProgressNoticeState | null> }
  /** Report a one-line notice shown frame-wide. */
  readonly report: (text: string) => void
  /** Dismiss the showing notice. */
  readonly dismiss: () => void
}

/** How long a notice stays before auto-dismissing. */
const DISMISS_AFTER_MS = 3000

/**
 * Create the one notice store the overlay entry shows.
 * @returns the source with `hooks.notice`, `report`, and `dismiss`.
 */
export function createProgressNoticeSource(): ProgressNoticeSource {
  const store = createSnapshotStore<ProgressNoticeState | null>(null)
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    hooks: { notice: store },
    report: (text: string): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { store.set(null); timer = undefined }, DISMISS_AFTER_MS)
      seq += 1
      store.set({ text, at: Date.now(), seq })
    },
    dismiss: (): void => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      store.set(null)
    },
  }
}

/** Cordis plugin entry. */
export const name = 'ui-notification'
export const inject = ['slots']

/** @param ctx - client root context. */
export function apply(ctx: ClientContext): void {
  const source = createProgressNoticeSource()
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'notification.progress',
    inject: (): { hooks: { notice: HostObservable<ProgressNoticeState | null> }; dismiss: () => void } => ({
      hooks: { notice: source.hooks.notice },
      dismiss: source.dismiss,
    }),
  }, ProgressNotice))
  ctx.reflect.provide('progressNotice', source)
}
