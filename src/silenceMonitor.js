/**
 * End-of-utterance detector: wait for speech, then fire after sustained silence.
 * Uses the same MediaStream as MediaRecorder (no second mic capture).
 */

const DEFAULTS = {
  /** RMS above this counts as speech. */
  speechThreshold: 0.018,
  /** How long silence must last after speech before ending. */
  silenceMs: 1400,
  /** Ignore brief noise blips shorter than this. */
  minSpeechMs: 350,
  /** Don't arm silence until the user has spoken at least this long. */
  minListenMs: 500,
}

/**
 * @param {MediaStream} stream
 * @param {() => void} onSilence
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{ stop: () => void }}
 */
export function startSilenceMonitor(stream, onSilence, options = {}) {
  const cfg = { ...DEFAULTS, ...options }
  const audioContext = new AudioContext()
  const source = audioContext.createMediaStreamSource(stream)
  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.4
  source.connect(analyser)

  const samples = new Float32Array(analyser.fftSize)
  const startedAt = performance.now()

  let speechStartedAt = 0
  let lastSpeechAt = 0
  let fired = false
  let raf = 0
  let stopped = false

  function rms() {
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
    return Math.sqrt(sum / samples.length)
  }

  function tick() {
    if (stopped || fired) return
    const now = performance.now()
    const level = rms()
    const speaking = level >= cfg.speechThreshold

    if (speaking) {
      if (!speechStartedAt) speechStartedAt = now
      lastSpeechAt = now
    } else if (
      speechStartedAt &&
      now - startedAt >= cfg.minListenMs &&
      lastSpeechAt - speechStartedAt >= cfg.minSpeechMs &&
      now - lastSpeechAt >= cfg.silenceMs
    ) {
      fired = true
      stop()
      onSilence()
      return
    }

    raf = requestAnimationFrame(tick)
  }

  function stop() {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(raf)
    try {
      source.disconnect()
    } catch {
      /* ignore */
    }
    try {
      analyser.disconnect()
    } catch {
      /* ignore */
    }
    void audioContext.close()
  }

  if (audioContext.state === 'suspended') {
    void audioContext.resume().then(() => {
      if (!stopped) raf = requestAnimationFrame(tick)
    })
  } else {
    raf = requestAnimationFrame(tick)
  }

  return { stop }
}
