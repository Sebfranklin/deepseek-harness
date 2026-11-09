/**
 * Notification cues: short WebAudio figures that tell the person, without a
 * visual check, what just happened — a turn settled, a turn failed, a Session
 * needs an answer, or a background job finished. Each event class has its own
 * pitch contour and timbre so the four are distinguishable by ear alone.
 *
 * Browsers start no audio without a user gesture, so the audio context is
 * created (or resumed) on the first pointer or key press and reused
 * afterwards; a page that never sees a gesture stays silent.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The event classes a cue can announce. */
export type Cue = 'done' | 'fail' | 'attention' | 'job'

/** One scheduled note: pitch, offset from the cue's start, envelope, and timbre. */
interface Note {
  /** Oscillator frequency in hertz. */
  readonly hz: number
  /** Start offset from the cue's base time, in seconds. */
  readonly offset: number
  /** Audible length of the note, in seconds. */
  readonly length: number
  /** Oscillator waveform; timbre carries as much of the distinction as pitch. */
  readonly type: OscillatorType
  /** Peak gain before the release; higher is louder. */
  readonly peak: number
}

/**
 * The cue vocabulary. `done` and `job` rise (success), `fail` falls through a
 * low triangle (error), and `attention` is a quick triple blip that stands out
 * from both without being unpleasant.
 */
const CUES: Record<Cue, readonly Note[]> = {
  done: [
    { hz: 659.25, offset: 0, length: 0.2, type: 'sine', peak: 0.2 },
    { hz: 987.77, offset: 0.11, length: 0.26, type: 'sine', peak: 0.2 },
  ],
  fail: [
    { hz: 392, offset: 0, length: 0.26, type: 'triangle', peak: 0.24 },
    { hz: 261.63, offset: 0.17, length: 0.36, type: 'triangle', peak: 0.24 },
  ],
  attention: [
    { hz: 880, offset: 0, length: 0.1, type: 'sine', peak: 0.18 },
    { hz: 1174.66, offset: 0.12, length: 0.1, type: 'sine', peak: 0.18 },
    { hz: 880, offset: 0.24, length: 0.12, type: 'sine', peak: 0.18 },
  ],
  job: [
    { hz: 523.25, offset: 0, length: 0.28, type: 'sine', peak: 0.2 },
  ],
}

/** Minimum gap between two success cues, in milliseconds; bursts stay one sound. */
const BURST_WINDOW_MS = 250

/** The only Session status facts the session cues read. */
interface SessionStatusLike {
  /** Latest known running state; absent until a baseline or event establishes it. */
  readonly running: boolean | undefined
  /** Highest-precedence request currently awaiting user interaction. */
  readonly pendingInteraction?: unknown
  /** Whether an observed stop outside the main view still needs acknowledgement. */
  readonly completionUnread?: boolean
}

/** HostObservable face of the Session status snapshot. */
interface StatusSource<Snapshot> {
  /** @returns the current snapshot. */
  getSnapshot: () => Snapshot
  /** @param listener - called after every snapshot replacement. @returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void
}

/** The jobs projection face this module needs. */
interface JobsLike {
  readonly state: {
    getSnapshot: () => { readonly rows: Readonly<Record<string, readonly JobViewLike[]>> }
    subscribe: (listener: () => void) => () => void
  }
  watchRows: (sessionId: SessionId) => () => void
}

/** One job row as the notification policy reads it. */
interface JobViewLike {
  readonly id: string
  readonly status: string
}

/** The Session filling the main panel, and the list changes that can move it. */
export interface MainSessionSource {
  /** @returns the Session the main panel shows, or undefined when it shows none. */
  readonly get: () => SessionId | undefined
  /** @param listener - called whenever the Session list changes. @returns the unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void
}

/** Whether a Session's last agent failure is still unaddressed. */
export type FailureProbe = (sessionId: SessionId) => boolean

/** Attention policy for session-level cues. */
export interface SessionCuePolicy {
  /** Whether the person is looking at the page right now. */
  readonly attended: () => boolean
  /** Whether the Session recorded an agent failure. */
  readonly failed: FailureProbe
}

type AudioContextConstructor = new () => AudioContext

/** One audio context for the page lifetime; undefined when WebAudio is unavailable or refused. */
let audio: AudioContext | undefined
/** Wall-clock time of the last success cue, for burst suppression. */
let lastSuccessAt = 0

/**
 * Resolve the page's AudioContext constructor across prefixed browsers.
 * @returns the constructor, or undefined outside a WebAudio-capable browser.
 */
function audioContextConstructor(): AudioContextConstructor | undefined {
  const scope = globalThis as {
    AudioContext?: AudioContextConstructor
    webkitAudioContext?: AudioContextConstructor
  }
  return scope.AudioContext ?? scope.webkitAudioContext
}

/**
 * Materialize the shared audio context on first use.
 * @returns the context, or undefined when creation throws (restricted iframe, no audio device).
 */
function cueContext(): AudioContext | undefined {
  if (audio !== undefined) return audio
  const Constructor = audioContextConstructor()
  if (Constructor === undefined) return undefined
  try {
    audio = new Constructor()
  } catch {
    return undefined
  }
  return audio
}

/** Schedule one note on the shared context. */
function scheduleNote(context: AudioContext, note: Note, base: number): void {
  const at = base + note.offset
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = note.type
  oscillator.frequency.setValueAtTime(note.hz, at)
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(note.peak, at + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + note.length)
  oscillator.connect(gain).connect(context.destination)
  oscillator.start(at)
  oscillator.stop(at + note.length + 0.02)
}

/**
 * Play one cue. Success cues collapse inside a short burst window so parallel
 * turns do not stack into a chord; failures and attention never suppress.
 * @param cue - the event class to announce.
 */
export function playCue(cue: Cue): void {
  const context = cueContext()
  if (context === undefined) return
  if (cue === 'done' || cue === 'job') {
    const now = Date.now()
    if (now - lastSuccessAt < BURST_WINDOW_MS) return
    lastSuccessAt = now
  }
  void context.resume().catch(() => {})
  const base = context.currentTime + 0.02
  for (const note of CUES[cue]) scheduleNote(context, note, base)
}

/**
 * Resume the shared context on the first user gesture, the only moment a
 * browser permits audio to start.
 * @returns teardown removing both listeners.
 */
export function primeNotificationCues(): () => void {
  const prime = (): void => {
    const context = cueContext()
    if (context !== undefined) void context.resume().catch(() => {})
    detach()
  }
  const detach = (): void => {
    window.removeEventListener('pointerdown', prime)
    window.removeEventListener('keydown', prime)
  }
  window.addEventListener('pointerdown', prime, { passive: true })
  window.addEventListener('keydown', prime)
  return detach
}

/**
 * Session identities whose turn settled between two snapshots.
 * @param previous - snapshot before the change.
 * @param next - snapshot after the change.
 * @returns identities that went from running to not running.
 */
function settledSessions(
  previous: ReadonlyMap<string, SessionStatusLike>,
  next: ReadonlyMap<string, SessionStatusLike>,
): string[] {
  const settled: string[] = []
  for (const [id, status] of previous) {
    if (status.running === true && next.get(id)?.running === false) settled.push(id)
  }
  return settled
}

/**
 * Announce settled turns, failures, and fresh interactions from the Session
 * status snapshot. Completion only sounds while the person is away from the
 * page or looking at another Session; a failure or a pending answer always
 * sounds, because both wait on the person.
 * @param status - the Session status snapshot source.
 * @param play - the audible effect; injectable for tests.
 * @param policy - attention and failure policy.
 * @returns teardown removing the snapshot subscription.
 */
export function installSessionCues(
  status: StatusSource<ReadonlyMap<string, SessionStatusLike>>,
  play: (cue: Cue) => void,
  policy: SessionCuePolicy,
): () => void {
  let previous = status.getSnapshot()
  return status.subscribe(() => {
    const next = status.getSnapshot()
    const attended = policy.attended()
    const awaiting = [...next].some(([id, current]) => current.pendingInteraction !== undefined
      && previous.get(id)?.pendingInteraction === undefined)
    const settled = settledSessions(previous, next)
    const unseen = settled.some(id => next.get(id)?.completionUnread === true)
    previous = next
    if (awaiting) {
      play('attention')
    } else if (settled.some(id => policy.failed(id as SessionId))) {
      play('fail')
    } else if (settled.length > 0 && (unseen || !attended)) {
      play('done')
    }
  })
}

/**
 * Announce terminal background jobs of the Session in the main panel: a
 * completed job gets the job cue, a failed one the failure cue. A job the
 * person killed stays silent. Roster rows exist only while this module watches
 * the Session, so the watch follows the main panel.
 * @param jobs - the client jobs service.
 * @param mainSessions - the source naming the main panel's Session.
 * @param play - the audible effect; injectable for tests.
 * @returns teardown releasing the watch and both subscriptions.
 */
export function installJobCues(
  jobs: JobsLike,
  mainSessions: MainSessionSource,
  play: (cue: Cue) => void,
): () => void {
  let watched: { id: SessionId; release: () => void } | undefined
  let statuses = new Map<string, string>()

  const syncWatch = (): void => {
    const id = mainSessions.get()
    if (watched?.id === id) return
    watched?.release()
    watched = id === undefined ? undefined : { id, release: jobs.watchRows(id) }
    statuses = new Map()
  }

  const observe = (): void => {
    if (watched === undefined) return
    const rows = jobs.state.getSnapshot().rows[String(watched.id)] ?? []
    const next = new Map<string, string>()
    for (const row of rows) next.set(row.id, row.status)
    if (statuses.size > 0) {
      for (const [id, status] of statuses) {
        const current = next.get(id)
        if (status !== 'running' || current === undefined) continue
        if (current === 'completed') play('job')
        else if (current === 'failed') play('fail')
      }
    }
    statuses = next
  }

  syncWatch()
  const stopSessions = mainSessions.subscribe(() => { syncWatch(); observe() })
  const stopJobs = jobs.state.subscribe(observe)
  return () => {
    stopSessions()
    stopJobs()
    watched?.release()
    watched = undefined
  }
}
