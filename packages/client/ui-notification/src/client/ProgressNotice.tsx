/** Props of the `shell.overlay` progress-notice entry. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'

export type ProgressNoticeProps = {
  /** The notice observable the overlay entry reads. */
  readonly hooks: { readonly notice: HostObservable<{ readonly text: string; readonly at: number; readonly seq: number } | null> }
  /** Clear the shown notice. */
  readonly dismiss: () => void
}

/** Render one banner in the frame overlay; returns null while nothing shows. */
export function ProgressNotice({ useNotice, dismiss }: ProgressNoticeProps): JSX.Element | null {
  const notice = useNotice(current => current)
  if (notice === null) return null
  const key = `progress-notice-${String(notice.seq)}`
  return <Toast key={key} text={notice.text} onDone={dismiss} />
}
