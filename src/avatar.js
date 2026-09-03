import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import {
  ANIMATION_URL,
  loadExpectedBoneNames,
  playLoopingAnimations,
  validateSkeleton,
} from './avatarAnimations.js'
import { LipSync } from './lipSync.js'
import { EyeBlink } from './eyeBlink.js'

const MODEL_URL = '/models/AbuSahelModel/AbuSahelModel.glb'

/** Subtle resting eye pose — softer lids, less stare. */
const RELAXED_EYE_WEIGHTS = {
  Eye_Squint_L: 0.2,
  Eye_Squint_R: 0.2,
  Eye_Blink_L: 0.2,
  Eye_Blink_R: 0.2,
  Eyelash_Upper_Down_L: 0.14,
  Eyelash_Upper_Down_R: 0.14,
  Eye_Wide_L: 0,
  Eye_Wide_R: 0,
}

function applyMorphWeights(morphMeshes, weights) {
  for (const mesh of morphMeshes) {
    const dict = mesh.morphTargetDictionary
    const influences = mesh.morphTargetInfluences
    if (!dict || !influences) continue

    for (const [name, value] of Object.entries(weights)) {
      const index = dict[name]
      if (index !== undefined) influences[index] = value
    }
  }
}

/** Upper-torso portrait — head, shoulders, and top of thobe only. */
function framePortraitCamera(model, camera, container) {
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())

  const viewBottom = box.min.y + size.y * 0.52
  const viewTop = box.max.y + size.y * 0.035
  const viewHeight = viewTop - viewBottom
  const viewWidth = size.x * 1.37

  const target = new THREE.Vector3(
    center.x,
    (viewTop + viewBottom) / 2 + size.y * 0.045,
    center.z,
  )

  const width = container.clientWidth || 1
  const height = container.clientHeight || 1
  const aspect = width / height
  const vFov = (camera.fov * Math.PI) / 180
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect)

  const distForHeight = (viewHeight / 2) / Math.tan(vFov / 2)
  const distForWidth = (viewWidth / 2) / Math.tan(hFov / 2)
  const distance = Math.max(distForHeight, distForWidth) * 0.96

  camera.position.set(target.x, target.y, target.z + distance)
  camera.lookAt(target)
}

export async function createAvatar(container) {
  const scene = new THREE.Scene()

  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100)
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  container.appendChild(renderer.domElement)

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.1)
  scene.add(hemi)

  const key = new THREE.DirectionalLight(0xffffff, 1.4)
  key.position.set(1.2, 2.4, 2.5)
  scene.add(key)

  const fill = new THREE.DirectionalLight(0xdde8ff, 0.55)
  fill.position.set(-2, 0.5, 2)
  scene.add(fill)

  const morphMeshes = []
  let model = null
  let lipSync = null
  let eyeBlink = null
  let animationPlayer = null
  let rafId = 0

  const loader = new GLTFLoader()
  const [gltf, animationGltf, expectedBones] = await Promise.all([
    loader.loadAsync(MODEL_URL),
    loader.loadAsync(ANIMATION_URL),
    loadExpectedBoneNames(),
  ])

  model = gltf.scene
  scene.add(model)

  const skeletonCheck = validateSkeleton(model, expectedBones)
  if (!skeletonCheck.ok) {
    console.warn(
      'Character skeleton is missing bones expected by ANIMATION.glb:',
      skeletonCheck.missing,
    )
  }

  if (!animationGltf.animations.length) {
    console.warn('ANIMATION.glb contains no animation clips.')
  } else {
    animationPlayer = playLoopingAnimations(model, animationGltf.animations)
    console.info('Playing idle animation:', animationPlayer.clipNames.join(', '))
  }

  model.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true
      child.receiveShadow = true
      if (child.morphTargetDictionary && child.morphTargetInfluences) {
        morphMeshes.push(child)
      }
    }
  })

  lipSync = new LipSync(morphMeshes)
  applyMorphWeights(morphMeshes, RELAXED_EYE_WEIGHTS)
  eyeBlink = new EyeBlink(morphMeshes, { restBlink: RELAXED_EYE_WEIGHTS.Eye_Blink_L })

  framePortraitCamera(model, camera, container)

  function resize() {
    const width = container.clientWidth
    const height = container.clientHeight
    if (!width || !height) return
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
    framePortraitCamera(model, camera, container)
  }

  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)
  resize()

  function tick() {
    rafId = requestAnimationFrame(tick)
    animationPlayer?.update()
    lipSync.update()
    eyeBlink?.update()
    renderer.render(scene, camera)
  }
  tick()

  // -- Overlay animations (think / talk) --
  const OVERLAY_URLS = {
    think: '/models/AbuSahelModel/think.glb',
    talk_1: '/models/AbuSahelModel/talk_1.glb',
    talk_confident: '/models/AbuSahelModel/talk_confident.glb',
    uncut_animations: '/models/AbuSahelModel/uncut_animations.glb',
  }

  const overlayClips = {}
  const overlayGltfs = await Promise.all(
    Object.entries(OVERLAY_URLS).map(async ([name, url]) => {
      const gltf = await loader.loadAsync(url)
      return [name, gltf]
    }),
  )
  for (const [name, gltf] of overlayGltfs) {
    overlayClips[name] = gltf.animations[0] ?? null
    if (!overlayClips[name]) console.warn(`${name}.glb contains no animation clips.`)
  }

  let overlayAction = null
  let activeOverlay = null

  function stopOverlay() {
    if (!overlayAction || !animationPlayer) {
      activeOverlay = null
      overlayAction = null
      return
    }
    overlayAction.fadeOut(0.4)
    animationPlayer.actions.forEach((a) => a.reset().fadeIn(0.4).play())
    overlayAction = null
    activeOverlay = null
  }

  /** Play an overlay clip (no toggle). Returns active name or null. */
  function playOverlay(name) {
    if (!animationPlayer || !name) return null
    if (name === activeOverlay) return activeOverlay

    const clip = overlayClips[name]
    if (!clip) return activeOverlay

    if (overlayAction) {
      overlayAction.fadeOut(0.4)
    } else {
      animationPlayer.actions.forEach((a) => a.fadeOut(0.4))
    }

    overlayAction = animationPlayer.mixer.clipAction(clip, model)
    overlayAction.setLoop(THREE.LoopRepeat)
    overlayAction.clampWhenFinished = false
    overlayAction.reset().fadeIn(0.4).play()
    activeOverlay = name
    return activeOverlay
  }

  /** Play an overlay clip, or stop if name is null / already active. Returns active name or null. */
  function setOverlay(name) {
    if (!animationPlayer) return null
    if (!name || name === activeOverlay) {
      stopOverlay()
      return null
    }
    return playOverlay(name)
  }

  return {
    /** Start lip-sync + talk_1 while the TTS audio element plays. */
    async speak(audio) {
      playOverlay('talk_1')
      audio.addEventListener(
        'ended',
        () => {
          if (activeOverlay === 'talk_1') stopOverlay()
        },
        { once: true },
      )
      await lipSync.play(audio)
    },

    stopSpeaking() {
      lipSync.stop()
      if (activeOverlay === 'talk_1') stopOverlay()
    },

    toggleThinking() {
      setOverlay(activeOverlay === 'think' ? null : 'think')
      return activeOverlay === 'think'
    },

    get isThinking() {
      return activeOverlay === 'think'
    },

    /** Toggle a test overlay (talk_confident, uncut_animations). */
    toggleTalk(name) {
      if (name !== 'talk_confident' && name !== 'uncut_animations') return false
      setOverlay(activeOverlay === name ? null : name)
      return activeOverlay === name
    },

    get activeTalk() {
      return activeOverlay === 'talk_confident' || activeOverlay === 'uncut_animations'
        ? activeOverlay
        : null
    },

    dispose() {
      cancelAnimationFrame(rafId)
      resizeObserver.disconnect()
      animationPlayer?.dispose()
      lipSync.stop()
      renderer.dispose()
      container.removeChild(renderer.domElement)
    },
  }
}
