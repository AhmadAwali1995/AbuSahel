import * as THREE from 'three'

export const ANIMATION_URL = '/models/AbuSahelModel/ANIMATION.glb'
export const BONE_NAMES_URL = '/models/AbuSahelModel/TheChatBot_BoneNames.txt'

/**
 * Time ranges (in seconds) for each segment inside the giant stitched animation clip.
 * Adjust these values to match the actual keyframe boundaries from the designer.
 */
const SEGMENT_RANGES = {
  idle:  { start: 0,    end: 8    },
  think: { start: 8,    end: 17   },
  talk1: { start: 17,   end: 27   },
  talk2: { start: 27,   end: 37   },
}

const CROSSFADE_DURATION = 0.4

const SOURCE_CLIP_PREFERENCES = [
  '2563486400256_TempMotion_BAKED',
  '2563486400256_TempMotion',
]

/** Designer bone list — used to verify the character skeleton matches the animation rig. */
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

/** Pick the best source clip from the animation file. */
function selectSourceClip(clips) {
  for (const name of SOURCE_CLIP_PREFERENCES) {
    const clip = clips.find((c) => c.name === name)
    if (clip) return clip
  }
  const useful = clips.filter((c) => c.duration > 0)
  return useful[0] || clips[0] || null
}

/** Extract a looping subclip from a giant stitched animation. */
function makeSubclip(sourceClip, name, startSec, endSec) {
  const fps = sourceClip.tracks[0]
    ? Math.round(sourceClip.tracks[0].times.length / sourceClip.duration)
    : 30
  const startFrame = Math.round(startSec * fps)
  const endFrame = Math.round(endSec * fps)
  return THREE.AnimationUtils.subclip(sourceClip.clone(), name, startFrame, endFrame, fps)
}

/**
 * Creates an animation controller that supports switching between
 * idle, think, talk1, and talk2 segments with crossfade transitions.
 */
export function createAnimationController(model, clips) {
  const sourceClip = selectSourceClip(clips)
  if (!sourceClip) {
    console.warn('No usable animation clip found.')
    return null
  }

  const mixer = new THREE.AnimationMixer(model)
  const clock = new THREE.Clock()

  const subclips = {}
  const actions = {}

  for (const [name, range] of Object.entries(SEGMENT_RANGES)) {
    subclips[name] = makeSubclip(sourceClip, name, range.start, range.end)
    const action = mixer.clipAction(subclips[name], model)
    action.setLoop(THREE.LoopRepeat)
    action.clampWhenFinished = false
    actions[name] = action
  }

  let currentState = 'idle'
  let talkToggle = false
  actions.idle.play()

  function transitionTo(targetName) {
    if (targetName === currentState) return
    const prev = actions[currentState]
    const next = actions[targetName]
    next.reset().setEffectiveWeight(1).play()
    prev.crossFadeTo(next, CROSSFADE_DURATION, true)
    currentState = targetName
  }

  return {
    mixer,
    actions,
    get currentState() { return currentState },

    setStatus(status) {
      switch (status) {
        case 'thinking':
          transitionTo('think')
          break
        case 'talking':
          talkToggle = !talkToggle
          transitionTo(talkToggle ? 'talk1' : 'talk2')
          break
        case 'idle':
        default:
          transitionTo('idle')
          break
      }
    },

    update() {
      mixer.update(clock.getDelta())
    },

    dispose() {
      mixer.stopAllAction()
    },
  }
}
