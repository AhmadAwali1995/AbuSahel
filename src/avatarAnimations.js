import * as THREE from 'three'

export const ANIMATION_URL = '/models/AbuSahelModel/ANIMATION.glb'
export const BONE_NAMES_URL = '/models/AbuSahelModel/TheChatBot_BoneNames.txt'

/**
 * Time boundaries (in seconds) for each segment inside the giant 37 s clip.
 * Adjust these once the designer confirms the exact cut points.
 */
const SEGMENT_RANGES = {
  idle:  { start: 0,  end: 8   },
  think: { start: 8,  end: 16  },
  talk1: { start: 16, end: 26  },
  talk2: { start: 26, end: 37  },
}

const CROSSFADE_DURATION = 0.4

const GIANT_CLIP_PREFERENCES = [
  '2563486400256_TempMotion_BAKED',
  '2563486400256_TempMotion',
]

export async function loadExpectedBoneNames() {
  const text = await fetch(BONE_NAMES_URL).then((response) => {
    if (!response.ok) throw new Error(`Could not load bone names (${response.status})`)
    return response.text()
  })

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function collectSkeletonBoneNames(root) {
  const names = new Set()
  root.traverse((child) => {
    if (child.isBone) names.add(child.name)
  })
  return names
}

export function validateSkeleton(root, expectedBoneNames) {
  const found = collectSkeletonBoneNames(root)
  const missing = expectedBoneNames.filter((name) => !found.has(name))
  return { ok: missing.length === 0, missing, found }
}

function findGiantClip(clips) {
  for (const name of GIANT_CLIP_PREFERENCES) {
    const clip = clips.find((c) => c.name === name)
    if (clip) return clip
  }
  const longest = clips.reduce((a, b) => (a.duration >= b.duration ? a : b), clips[0])
  return longest.duration > 1 ? longest : null
}

function extractSubclip(sourceClip, name, start, end) {
  return THREE.AnimationUtils.subclip(sourceClip.clone(), name, start * 30, end * 30, 30)
}

/**
 * Animation state machine that crossfades between idle / think / talk1 / talk2.
 */
export function createAnimationPlayer(model, clips) {
  const giant = findGiantClip(clips)
  if (!giant) {
    console.warn('No suitable giant animation clip found.')
    return null
  }

  const subclips = {}
  for (const [name, range] of Object.entries(SEGMENT_RANGES)) {
    subclips[name] = extractSubclip(giant, name, range.start, range.end)
  }

  const mixer = new THREE.AnimationMixer(model)
  const clock = new THREE.Clock()

  const actions = {}
  for (const [name, clip] of Object.entries(subclips)) {
    const action = mixer.clipAction(clip, model)
    action.setLoop(THREE.LoopRepeat)
    action.clampWhenFinished = false
    action.enabled = true
    action.setEffectiveWeight(0)
    actions[name] = action
  }

  let currentState = 'idle'
  actions.idle.setEffectiveWeight(1)
  actions.idle.play()

  function setState(newState) {
    if (newState === currentState) return
    if (!actions[newState]) {
      console.warn(`Unknown animation state: ${newState}`)
      return
    }

    const prev = actions[currentState]
    const next = actions[newState]

    next.reset()
    next.setEffectiveWeight(1)
    next.play()
    prev.crossFadeTo(next, CROSSFADE_DURATION, true)

    currentState = newState
  }

  return {
    mixer,
    actions,
    get currentState() { return currentState },
    setState,
    update() {
      mixer.update(clock.getDelta())
    },
    dispose() {
      mixer.stopAllAction()
    },
  }
}
