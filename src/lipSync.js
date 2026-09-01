/**
 * Drives ARKit / CC viseme morph targets from live audio amplitude.
 * ElevenLabs TTS does not expose viseme events, so we react to the waveform.
 */

const VISEME_TARGETS = [
  'Jaw_Open',
  'V_Open',
  'V_Lip_Open',
  'V_Wide',
  'V_Tight',
  'V_Dental_Lip',
  'Mouth_Close',
]

const SMOOTHING = 0.35

export class LipSync {
  /** @param {import('three').Mesh[]} morphMeshes */
  constructor(morphMeshes) {
    this.morphMeshes = morphMeshes
    this.audioContext = null
    this.analyser = null
    this.source = null
    this.activeAudio = null
    this.running = false
    this.current = Object.fromEntries(VISEME_TARGETS.map((name) => [name, 0]))
    this.timeData = new Uint8Array(0)
    this.freqData = new Uint8Array(0)
  }

  /** @param {HTMLAudioElement} audio */
  async play(audio) {
    this.stop()

    this.audioContext = new AudioContext()
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }

    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 512
    this.analyser.smoothingTimeConstant = 0.5

    this.source = this.audioContext.createMediaElementSource(audio)
    this.source.connect(this.analyser)
    this.analyser.connect(this.audioContext.destination)

    this.timeData = new Uint8Array(this.analyser.fftSize)
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount)

    this.activeAudio = audio
    this.running = true

    const onEnd = () => this.stop()
    audio.addEventListener('ended', onEnd, { once: true })
  }

  stop() {
    this.running = false
    this.activeAudio = null

    if (this.source) {
      try {
        this.source.disconnect()
      } catch {
        /* already disconnected */
      }
      this.source = null
    }

    if (this.audioContext) {
      void this.audioContext.close()
      this.audioContext = null
    }

    this.analyser = null
    this.fadeToSilence()
  }

  fadeToSilence() {
    for (const key of VISEME_TARGETS) {
      this.current[key] = 0
    }
    this.applyWeights(this.current)
  }

  update() {
    if (!this.running || !this.analyser) return

    this.analyser.getByteTimeDomainData(this.timeData)
    this.analyser.getByteFrequencyData(this.freqData)

    let sumSq = 0
    for (let i = 0; i < this.timeData.length; i += 1) {
      const sample = (this.timeData[i] - 128) / 128
      sumSq += sample * sample
    }
    const rms = Math.sqrt(sumSq / this.timeData.length)

    const lowEnd = this.bandAverage(0, 8)
    const midBand = this.bandAverage(8, 40)
    const highBand = this.bandAverage(40, 120)

    const volume = Math.min(1, rms * 5.5)
    const openness = Math.min(1, lowEnd * 2.2 + volume * 0.45)
    const wide = Math.min(1, highBand * 2.8)
    const tight = Math.min(1, midBand * 2.0 * (1 - volume * 0.35))

    const targets = {
      Jaw_Open: openness * 0.55,
      V_Open: openness * 0.5,
      V_Lip_Open: openness * 0.42,
      V_Wide: wide * 0.35 * volume,
      V_Tight: tight * 0.3,
      V_Dental_Lip: tight * 0.22,
      Mouth_Close: Math.max(0, 0.12 - volume * 0.12),
    }

    for (const key of VISEME_TARGETS) {
      const next = targets[key] ?? 0
      this.current[key] += (next - this.current[key]) * SMOOTHING
    }

    this.applyWeights(this.current)
  }

  bandAverage(from, to) {
    if (!this.freqData.length) return 0
    let sum = 0
    const end = Math.min(to, this.freqData.length)
    for (let i = from; i < end; i += 1) sum += this.freqData[i]
    return sum / ((end - from) * 255)
  }

  applyWeights(weights) {
    for (const mesh of this.morphMeshes) {
      const dict = mesh.morphTargetDictionary
      const influences = mesh.morphTargetInfluences
      if (!dict || !influences) continue

      for (const [name, value] of Object.entries(weights)) {
        const index = dict[name]
        if (index !== undefined) influences[index] = value
      }
    }
  }
}
