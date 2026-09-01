import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import {
  ANIMATION_URL,
  loadExpectedBoneNames,
  playLoopingAnimations,
  validateSkeleton,
} from './avatarAnimations.js'
import { LipSync } from './lipSync.js'

const MODEL_URL = '/models/AbuSahelModel/AbuSahelModel.glb'

/** Head-and-upper-chest framing. */
function frameBustCamera(model, camera, container) {
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())

  const viewBottom = box.min.y + size.y * 0.58
  const viewTop = box.max.y + size.y * 0.02
  const viewHeight = viewTop - viewBottom
  const viewWidth = size.x * 0.38

  const target = new THREE.Vector3(center.x, (viewTop + viewBottom) / 2, center.z)

  const width = container.clientWidth || 1
  const height = container.clientHeight || 1
  const aspect = width / height
  const vFov = (camera.fov * Math.PI) / 180
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect)

  const distForHeight = (viewHeight / 2) / Math.tan(vFov / 2)
  const distForWidth = (viewWidth / 2) / Math.tan(hFov / 2)
  const distance = Math.max(distForHeight, distForWidth) * 1.08

  camera.position.set(target.x, target.y, target.z + distance)
  camera.lookAt(target)
}

export async function createAvatar(container) {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0xf7f7f7)

  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100)
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
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

  frameBustCamera(model, camera, container)

  function resize() {
    const width = container.clientWidth
    const height = container.clientHeight
    if (!width || !height) return
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
    frameBustCamera(model, camera, container)
  }

  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)
  resize()

  function tick() {
    rafId = requestAnimationFrame(tick)
    animationPlayer?.update()
    lipSync.update()
    renderer.render(scene, camera)
  }
  tick()

  return {
    /** Start lip-sync while the TTS audio element plays. */
    async speak(audio) {
      await lipSync.play(audio)
    },

    stopSpeaking() {
      lipSync.stop()
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
