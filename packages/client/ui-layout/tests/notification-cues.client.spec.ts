// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

/** A playable stand-in for the Session status value. */
interface TestStatus {
  running: boolean | undefined
  pendingInteraction?: unknown
  completionUnread?: boolean
}

class FakeAudioParam {
  setValueAtTime = vi.fn()
  exponentialRampToValueAtTime = vi.fn()
}

class FakeAudioNode {
  connect = vi.fn((target: unknown) => target)
}

class FakeOscillator extends FakeAudioNode {
  type = ''
  frequency = new FakeAudioParam()
  start = vi.fn()
  stop = vi.fn()
}

class FakeGain extends FakeAudioNode {
  gain = new FakeAudioParam()
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []

  currentTime = 0
  destination = new FakeAudioNode()
  readonly resume = vi.fn(() => Promise.resolve())
  readonly oscillators: FakeOscillator[] = []
  readonly gains: FakeGain[] = []

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  readonly createOscillator = (): FakeOscillator => {
    const oscillator = new FakeOscillator()
    this.oscillators.push(oscillator)
    return oscillator
  }

  readonly createGain = (): FakeGain => {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }
}

/** One observable status fixture: `publish` swaps the snapshot and notifies. */
function statusFixture(initial: ReadonlyMap<string, TestStatus>) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: (): ReadonlyMap<string, TestStatus> => snapshot,
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    publish: (next: ReadonlyMap<string, TestStatus>): void => {
      snapshot = next
      for (const listener of listeners) listener()
    },
    listenerCount: (): number => listeners.size,
  }
}

/** Load a fresh module instance so the page-lifetime audio cache starts empty. */
async function loadCues() {
  vi.resetModules()
  return import('../src/client/notification-cues.ts')
}

/** Read the frequency each scheduled note plays at. */
function frequencies(context: FakeAudioContext): number[] {
  return context.oscillators.map(oscillator => oscillator.frequency.setValueAtTime.mock.calls[0]?.[0] as number)
}

/** Read the peak gain each scheduled note reaches. */
function peaks(context: FakeAudioContext): number[] {
  return context.gains.map(gain => gain.gain.exponentialRampToValueAtTime.mock.calls[0]?.[0] as number)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  FakeAudioContext.instances = []
})

describe('playCue', () => {
  it('plays the completion figure as a louder rising pair', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { playCue } = await loadCues()
    playCue('done')
    const context = FakeAudioContext.instances[0]
    expect(frequencies(context!)).toEqual([659.25, 987.77])
    expect(peaks(context!)).toEqual([0.2, 0.2])
    expect(context?.oscillators.every(oscillator => oscillator.type === 'sine')).toBe(true)
  })

  it('plays the failure figure as a falling triangle', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { playCue } = await loadCues()
    playCue('fail')
    const context = FakeAudioContext.instances[0]
    expect(frequencies(context!)).toEqual([392, 261.63])
    expect(peaks(context!)).toEqual([0.24, 0.24])
    expect(context?.oscillators.every(oscillator => oscillator.type === 'triangle')).toBe(true)
  })

  it('plays the attention figure as three quick blips', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { playCue } = await loadCues()
    playCue('attention')
    const context = FakeAudioContext.instances[0]
    expect(frequencies(context!)).toEqual([880, 1174.66, 880])
    expect(context?.oscillators).toHaveLength(3)
  })

  it('plays the job figure as one mid note', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { playCue } = await loadCues()
    playCue('job')
    const context = FakeAudioContext.instances[0]
    expect(frequencies(context!)).toEqual([523.25])
  })

  it('collapses success bursts but never suppresses a failure', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const { playCue } = await loadCues()
    playCue('done')
    playCue('done')
    playCue('fail')
    playCue('fail')
    const context = FakeAudioContext.instances[0]
    // One completed pair, then both failure figures.
    expect(context?.oscillators).toHaveLength(2 + 2 + 2)
  })

  it('reuses one context for later cues', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { playCue } = await loadCues()
    playCue('done')
    vi.spyOn(Date, 'now').mockReturnValue(10_000)
    playCue('attention')
    expect(FakeAudioContext.instances).toHaveLength(1)
  })

  it('falls back to the prefixed constructor', async () => {
    vi.stubGlobal('webkitAudioContext', FakeAudioContext)
    const { playCue } = await loadCues()
    playCue('job')
    expect(FakeAudioContext.instances).toHaveLength(1)
  })

  it('stays silent without WebAudio', async () => {
    const { playCue } = await loadCues()
    playCue('done')
    expect(FakeAudioContext.instances).toHaveLength(0)
  })

  it('stays silent when the context cannot be created', async () => {
    function RefusedContext(): never {
      throw new Error('no audio device')
    }
    vi.stubGlobal('AudioContext', RefusedContext)
    const { playCue } = await loadCues()
    playCue('done')
    await Promise.resolve()
    expect(FakeAudioContext.instances).toHaveLength(0)
  })

  it('survives a refused context resume', async () => {
    class RefusingContext extends FakeAudioContext {
      override readonly resume = vi.fn(() => Promise.reject(new Error('gesture required')))
    }
    vi.stubGlobal('AudioContext', RefusingContext)
    const { playCue } = await loadCues()
    playCue('fail')
    await Promise.resolve()
    expect(FakeAudioContext.instances).toHaveLength(1)
  })
})

describe('primeNotificationCues', () => {
  it('resumes the shared context on the first gesture, then detaches', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { primeNotificationCues } = await loadCues()
    const release = primeNotificationCues()
    window.dispatchEvent(new Event('pointerdown'))
    const context = FakeAudioContext.instances[0]
    expect(context?.resume).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('keydown'))
    expect(FakeAudioContext.instances).toHaveLength(1)
    release()
  })
})

describe('installSessionCues', () => {
  it('sounds completion only while the person is away', async () => {
    const { installSessionCues } = await loadCues()
    const fixture = statusFixture(new Map([['session', { running: true }]]))
    const play = vi.fn()
    const release = installSessionCues(fixture.source, play, {
      attended: () => true,
      failed: () => false,
    })
    fixture.publish(new Map([['session', { running: false }]]))
    expect(play).not.toHaveBeenCalled()
    release()
    expect(fixture.listenerCount()).toBe(0)
  })

  it('sounds a settlement outside the main panel even while attended', async () => {
    const { installSessionCues } = await loadCues()
    const fixture = statusFixture(new Map([['background', { running: true }]]))
    const play = vi.fn()
    installSessionCues(fixture.source, play, { attended: () => true, failed: () => false })
    fixture.publish(new Map([['background', { running: false, completionUnread: true }]]))
    expect(play).toHaveBeenCalledWith('done')
  })

  it('sounds a failure settlement even while attended', async () => {
    const { installSessionCues } = await loadCues()
    const fixture = statusFixture(new Map([['session', { running: true }]]))
    const play = vi.fn()
    installSessionCues(fixture.source, play, { attended: () => true, failed: id => String(id) === 'session' })
    fixture.publish(new Map([['session', { running: false }]]))
    expect(play).toHaveBeenCalledWith('fail')
  })

  it('sounds a fresh pending interaction as attention', async () => {
    const { installSessionCues } = await loadCues()
    const fixture = statusFixture(new Map([['session', { running: true }]]))
    const play = vi.fn()
    installSessionCues(fixture.source, play, { attended: () => true, failed: () => false })
    fixture.publish(new Map([['session', { running: true, pendingInteraction: { kind: 'approval' } }]]))
    expect(play).toHaveBeenCalledWith('attention')
  })

  it('ignores snapshots without a settlement or a new interaction', async () => {
    const { installSessionCues } = await loadCues()
    const fixture = statusFixture(new Map([['session', { running: true, pendingInteraction: { kind: 'approval' } }]]))
    const play = vi.fn()
    installSessionCues(fixture.source, play, { attended: () => false, failed: () => false })
    fixture.publish(new Map([['session', { running: true, pendingInteraction: { kind: 'approval' } }]]))
    expect(play).not.toHaveBeenCalled()
  })
})

describe('installJobCues', () => {
  function jobsFixture() {
    let rows: Record<string, { id: string; status: string }[]> = {}
    const listeners = new Set<() => void>()
    return {
      state: {
        getSnapshot: () => ({ rows }),
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
      watchRows: vi.fn(() => vi.fn()),
      publish: (next: Record<string, { id: string; status: string }[]>) => {
        rows = next
        for (const listener of listeners) listener()
      },
    }
  }

  it('sounds a completed job for the Session in the main panel', async () => {
    const { installJobCues } = await loadCues()
    const jobs = jobsFixture()
    const play = vi.fn()
    const sessions = {
      get: () => 'main' as never,
      subscribe: () => () => {},
    }
    installJobCues(jobs, sessions, play)
    expect(jobs.watchRows).toHaveBeenCalledWith('main')
    jobs.publish({ main: [{ id: 'job-1', status: 'running' }] })
    jobs.publish({ main: [{ id: 'job-1', status: 'completed' }] })
    expect(play).toHaveBeenCalledWith('job')
  })

  it('sounds a failed job as a failure and ignores a killed one', async () => {
    const { installJobCues } = await loadCues()
    const jobs = jobsFixture()
    const play = vi.fn()
    installJobCues(jobs, { get: () => 'main' as never, subscribe: () => () => {} }, play)
    jobs.publish({ main: [{ id: 'job-1', status: 'running' }, { id: 'job-2', status: 'running' }] })
    jobs.publish({ main: [{ id: 'job-1', status: 'failed' }, { id: 'job-2', status: 'killed' }] })
    expect(play).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenCalledWith('fail')
  })

  it('moves the watch when the main panel changes Session', async () => {
    const { installJobCues } = await loadCues()
    const jobs = jobsFixture()
    let main: string | undefined = 'first'
    const listeners = new Set<() => void>()
    installJobCues(jobs, {
      get: () => main as never,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }, vi.fn())
    const releaseFirst = jobs.watchRows.mock.results[0]?.value as () => void
    main = 'second'
    for (const listener of listeners) listener()
    expect(releaseFirst).toHaveBeenCalled()
    expect(jobs.watchRows).toHaveBeenLastCalledWith('second')
  })

  it('watches nothing while the main panel shows no Session', async () => {
    const { installJobCues } = await loadCues()
    const jobs = jobsFixture()
    const release = installJobCues(jobs, { get: () => undefined, subscribe: () => () => {} }, vi.fn())
    expect(jobs.watchRows).not.toHaveBeenCalled()
    release()
  })
})
