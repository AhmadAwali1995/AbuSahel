import * as THREE from 'three'
import { prepareArtwork } from './artwork.js'
import { VISEME_NAMES, VISEME_SHAPES, selectViseme, approach } from './visemes.js'
import { vertexShader, fragmentShader } from './shaders.js'

/**
 * Port of the 2D CharacterEngine, plus speakFromElement() so the existing
 * voice pipeline can drive lip animation from streaming TTS <audio> chunks.
 */
export class CharacterEngine {
  constructor(host, onSnapshot = () => {}, options = {}) {
    this.host = host
    this.onSnapshot = onSnapshot
    this.options = options

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.setClearColor(0, 0)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
    this.camera.position.z = 3

    this.mesh = null
    this.material = null
    this.art = null
    this.marks = []

    this.audio = null
    this.analyser = null
    this.source = null
    this.mediaSource = null
    this.element = null
    this.buffer = null
    this.raw = null
    this.data = new Float32Array(1024)
    this.freq = new Uint8Array(512)

    this.state = 'Idle'
    this.energy = 0
    this.mix = 0
    this.thought = 0
    this.mouthActive = 0
    this.openness = 0
    this.roundness = 0
    this.lipWidth = 35
    this.lipHeight = 1.4
    this.pucker = 0
    this.pose = 0
    this.playing = false
    this.started = 0
    this.endedTime = 0
    this.dead = false
    this.raf = 0
    this.last = 0
    this.lastUI = 0
    this.nextBlink = 3
    this.blinkEnd = 0
    this.nextPose = 0
    this.peak = 0
    this.frameTimes = []
    this.fps = 0
    this.nextFrame = 0
    this.generation = 0
    this.history = []
    this.thinkingTimer = null
    this.thinkingResolve = null
    this.elementEndedHandler = null

    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(host)
  }

  async init() {
    this.art = await prepareArtwork()
    if (this.dead) {
      this.freeTextures()
      return
    }

    for (const tex of [
      ...this.art.neutral.flat(),
      ...this.art.angry,
      ...this.art.thinking,
      ...this.art.clean,
      ...this.art.angryClean,
    ]) {
      this.renderer.initTexture(tex)
    }

    const m = this.art.mouth
    const am = this.art.angryMouth
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        neutral: { value: this.art.neutral[0][0] },
        clean: { value: this.art.clean[0] },
        angry: { value: this.art.angry[0] },
        angryClean: { value: this.art.angryClean[0] },
        thinking: { value: this.art.thinking[0] },
        blend: { value: 0 },
        thought: { value: 0 },
        breath: { value: 0 },
        emphasis: { value: 0 },
        pondering: { value: 0 },
        mouthActive: { value: 0 },
        openness: { value: 0 },
        roundness: { value: 0 },
        lipWidth: { value: 35 },
        lipHeight: { value: 1.4 },
        pucker: { value: 0 },
        angryMouthCenter: {
          value: new THREE.Vector2((am.x + am.w / 2) / 1024, 1 - (am.y + am.h * 0.5) / 1134),
        },
        mouthCenter: {
          value: new THREE.Vector2((m.x + m.w / 2) / 1024, 1 - (m.y + m.h * 0.5) / 1134),
        },
      },
      vertexShader,
      fragmentShader,
    })

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.806, 2, 24, 32), this.material)
    this.scene.add(this.mesh)

    const glyph = document.createElement('canvas')
    glyph.width = 128
    glyph.height = 160
    const ctx = glyph.getContext('2d')
    ctx.font = 'bold 124px Georgia'
    ctx.textAlign = 'center'
    ctx.fillStyle = '#f1cb76'
    ctx.fillText('?', 64, 128)
    const map = new THREE.CanvasTexture(glyph)
    map.colorSpace = THREE.SRGBColorSpace

    for (let i = 0; i < 3; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map, transparent: true, depthTest: false, opacity: 0 }),
      )
      sprite.visible = false
      sprite.scale.set(0.11, 0.14, 1)
      this.scene.add(sprite)
      this.marks.push(sprite)
    }

    this.resize()
    this.ensureContext()
    this.raf = requestAnimationFrame((t) => this.tick(t))
    window.__character = this
  }

  resize() {
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    const aspect = w / h
    this.camera.left = -aspect
    this.camera.right = aspect
    this.camera.top = 1
    this.camera.bottom = -1
    this.camera.updateProjectionMatrix()
    if (this.mesh) {
      const scale = Math.min(0.92, aspect / 0.91)
      this.mesh.scale.setScalar(scale)
      this.mesh.position.y = -1 + scale
    }
  }

  ensureContext() {
    if (!this.audio) {
      this.audio = new AudioContext()
      this.analyser = this.audio.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyser.smoothingTimeConstant = 0.35
      this.analyser.connect(this.audio.destination)
    }
  }

  async context() {
    this.ensureContext()
    if (this.audio.state === 'suspended') {
      await this.audio.resume()
    }
  }

  cancelThinking() {
    if (this.thinkingTimer !== null) {
      clearTimeout(this.thinkingTimer)
      this.thinkingTimer = null
    }
    this.thinkingResolve?.()
    this.thinkingResolve = null
  }

  disconnectMedia() {
    if (this.element && this.elementEndedHandler) {
      this.element.removeEventListener('ended', this.elementEndedHandler)
    }
    this.elementEndedHandler = null
    this.element = null
    if (this.mediaSource) {
      try {
        this.mediaSource.disconnect()
      } catch {
        /* already disconnected */
      }
      this.mediaSource = null
    }
  }

  stopSource() {
    if (this.source) {
      this.source.onended = null
      try {
        this.source.stop()
      } catch {
        /* already stopped */
      }
      this.source.disconnect()
      this.source = null
    }
    this.disconnectMedia()
    this.playing = false
  }

  idle() {
    this.generation++
    this.cancelThinking()
    this.stopSource()
    this.state = 'Idle'
    this.endedTime = 0
  }

  thinking() {
    this.generation++
    this.cancelThinking()
    this.stopSource()
    this.state = 'Thinking'
    this.endedTime = 0
  }

  angry() {
    if (this.state === 'Thinking') {
      this.generation++
      this.cancelThinking()
    }
    this.state = 'Angry'
  }

  /**
   * Drive mouth animation from a playing HTMLAudioElement (TTS chunk).
   * The pipeline owns play()/pause(); this only taps the waveform.
   */
  async speakFromElement(audio) {
    const token = ++this.generation
    this.cancelThinking()
    this.stopSource()
    await this.context()
    if (this.dead || token !== this.generation) return

    this.state = this.state === 'Angry' ? 'Angry' : 'Speaking'
    this.endedTime = 0
    this.ensureContext()

    this.mediaSource = this.audio.createMediaElementSource(audio)
    this.mediaSource.connect(this.analyser)
    this.element = audio
    this.playing = true
    this.started = this.audio.currentTime

    this.elementEndedHandler = () => {
      if (token !== this.generation) return
      this.playing = false
      this.state = 'Idle'
      this.disconnectMedia()
    }
    audio.addEventListener('ended', this.elementEndedHandler)
  }

  tick(ms) {
    if (this.dead) return
    if (ms < this.nextFrame) {
      this.raf = requestAnimationFrame((v) => this.tick(v))
      return
    }
    this.nextFrame = Math.max(this.nextFrame + 1000 / 60, ms - 16)
    const t = ms / 1000
    const elapsed = this.last ? t - this.last : 1 / 60
    const dt = Math.min(0.05, elapsed)
    this.last = t

    let target = 0
    let low = 0
    let mid = 0
    let high = 0

    if (this.playing && this.analyser) {
      this.analyser.getFloatTimeDomainData(this.data)
      let sum = 0
      for (let i = 0; i < this.data.length; i++) sum += this.data[i] * this.data[i]
      target = Math.min(1, Math.max(0, (Math.sqrt(sum / this.data.length) - 0.006) * 7))
      this.analyser.getByteFrequencyData(this.freq)
      let nl = 0
      let nm = 0
      let nh = 0
      const hzPerBin = this.audio.sampleRate / this.analyser.fftSize
      for (let i = 1; i < this.freq.length; i++) {
        const hz = i * hzPerBin
        const value = this.freq[i]
        if (hz >= 120 && hz < 650) {
          low += value
          nl++
        } else if (hz >= 650 && hz < 1800) {
          mid += value
          nm++
        } else if (hz >= 1800 && hz < 4800) {
          high += value
          nh++
        }
      }
      low /= Math.max(1, nl)
      mid /= Math.max(1, nm)
      high /= Math.max(1, nh)
    }

    const follow = (current, goal, tau) => approach(current, goal, dt, tau)
    this.energy = follow(this.energy, target, target > this.energy ? 0.018 : 0.055)
    if (this.energy < 0.001) this.energy = 0

    if (t > this.nextPose || !this.playing || target < 0.01) {
      this.pose = VISEME_NAMES.indexOf(
        selectViseme(this.energy, low, mid, high, this.playing),
      )
      this.nextPose = t + 0.045
    }

    const shape = VISEME_SHAPES[VISEME_NAMES[this.pose]]
    const syllableScale = 0.78 + 0.22 * Math.min(1, this.energy * 2.5)
    this.lipWidth = follow(this.lipWidth, shape.width, 0.022)
    this.lipHeight = follow(this.lipHeight, shape.height * (this.pose > 1 ? syllableScale : 1), 0.025)
    this.pucker = follow(this.pucker, shape.pucker, 0.022)
    this.openness = Math.max(0, Math.min(1, (this.lipHeight - 1.4) / 19.6))
    this.roundness = follow(this.roundness, shape.round, 0.025)
    this.mouthActive = follow(this.mouthActive, Number(this.playing), 0.06)
    this.peak = follow(this.peak, Math.max(0, this.energy - 0.38), 0.13)
    this.mix = follow(this.mix, Number(this.state === 'Angry'), 0.13)
    this.thought = follow(this.thought, Number(this.state === 'Thinking'), 0.13)

    if (t > this.nextBlink) {
      this.blinkEnd = t + 0.12
      this.nextBlink = t + 2.6 + Math.random() * 3.6
    }
    const blink = t < this.blinkEnd ? 1 : 0

    if (this.material && this.art && this.mesh) {
      const u = this.material.uniforms
      u.neutral.value = this.art.neutral[0][blink]
      u.clean.value = this.art.clean[blink]
      u.angry.value = this.art.angry[blink]
      u.angryClean.value = this.art.angryClean[blink]
      u.thinking.value = this.art.thinking[blink]
      u.blend.value = this.mix
      u.thought.value = this.thought
      u.breath.value = Math.sin(t * 1.7)
      u.emphasis.value = this.peak * Math.sin(t * 12)
      u.pondering.value = this.thought * Math.sin(t * 1.9)
      u.mouthActive.value = this.mouthActive
      u.openness.value = this.openness
      u.roundness.value = this.roundness
      u.lipWidth.value = this.lipWidth
      u.lipHeight.value = this.lipHeight
      u.pucker.value = this.pucker

      const crown = this.mesh.position.y + 0.865 * this.mesh.scale.y
      this.marks.forEach((mark, i) => {
        mark.visible = this.thought > 0.005
        mark.material.opacity = this.thought * (0.65 + 0.35 * Math.sin(t * 2.8 - i * 0.8) ** 2)
        mark.position.set(
          (i - 1) * 0.145 - 0.035,
          crown + 0.13 + Math.sin(t * 2.8 - i * 0.8) * 0.018 + (i === 1 ? 0.045 : 0),
          0.1,
        )
        mark.material.rotation = Math.sin(t * 1.5 + i) * 0.13
      })

      this.renderer.render(this.scene, this.camera)
    }

    this.frameTimes.push(elapsed * 1000)
    if (this.frameTimes.length > 120) this.frameTimes.shift()
    if (ms - this.lastUI > 100) {
      this.fps = Math.round(
        1000 / (this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length),
      )
      const s = this.snapshot()
      this.onSnapshot(s)
      this.history.push(s)
      if (this.history.length > 600) this.history.shift()
      this.lastUI = ms
    }

    this.raf = requestAnimationFrame((v) => this.tick(v))
  }

  snapshot() {
    const duration = this.buffer?.duration || this.element?.duration || 0
    const time = this.playing
      ? this.element
        ? this.element.currentTime || 0
        : this.buffer
          ? Math.min(this.buffer.duration, this.audio.currentTime - this.started)
          : 0
      : this.endedTime
    return {
      state: this.state,
      pose: VISEME_NAMES[this.pose],
      energy: this.energy,
      fps: this.fps,
      time,
      duration,
      playing: this.playing,
    }
  }

  freeTextures() {
    if (!this.art) return
    ;[
      ...this.art.neutral.flat(),
      ...this.art.angry,
      ...this.art.thinking,
      ...this.art.clean,
      ...this.art.angryClean,
    ].forEach((t) => t.dispose())
  }

  dispose() {
    this.dead = true
    this.generation++
    this.cancelThinking()
    cancelAnimationFrame(this.raf)
    this.stopSource()
    this.observer.disconnect()
    this.analyser?.disconnect()
    void this.audio?.close()
    this.freeTextures()
    this.marks[0]?.material.map?.dispose()
    this.marks.forEach((m) => m.material.dispose())
    this.mesh?.geometry.dispose()
    this.material?.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    if (window.__character === this) delete window.__character
  }
}
