const BLINK_INTERVAL_MS = 3000
const BLINK_CLOSE_MS = 90
const BLINK_OPEN_MS = 120

export class EyeBlink {
  /** @param {import('three').Mesh[]} morphMeshes */
  constructor(morphMeshes, { restBlink = 0.2 } = {}) {
    this.morphMeshes = morphMeshes
    this.restBlink = restBlink
    this.lastBlinkTime = performance.now()
    this.phase = 'idle'
    this.phaseStart = 0
    this.peakBlink = 1
  }

  update(now = performance.now()) {
    if (this.phase === 'idle') {
      if (now - this.lastBlinkTime < BLINK_INTERVAL_MS) return
      this.phase = 'closing'
      this.phaseStart = now
    }

    if (this.phase === 'closing') {
      const t = Math.min(1, (now - this.phaseStart) / BLINK_CLOSE_MS)
      this.applyBlink(this.restBlink + (this.peakBlink - this.restBlink) * t)
      if (t >= 1) {
        this.phase = 'opening'
        this.phaseStart = now
      }
      return
    }

    if (this.phase === 'opening') {
      const t = Math.min(1, (now - this.phaseStart) / BLINK_OPEN_MS)
      this.applyBlink(this.peakBlink + (this.restBlink - this.peakBlink) * t)
      if (t >= 1) {
        this.phase = 'idle'
        this.lastBlinkTime = now
        this.applyBlink(this.restBlink)
      }
    }
  }

  applyBlink(weight) {
    for (const mesh of this.morphMeshes) {
      const dict = mesh.morphTargetDictionary
      const influences = mesh.morphTargetInfluences
      if (!dict || !influences) continue

      const left = dict.Eye_Blink_L
      const right = dict.Eye_Blink_R
      if (left !== undefined) influences[left] = weight
      if (right !== undefined) influences[right] = weight
    }
  }
}
