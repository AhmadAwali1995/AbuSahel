import * as THREE from 'three'

export const ANIMATION_URL = '/models/AbuSahelModel/ANIMATION.glb'
export const BONE_NAMES_URL = '/models/AbuSahelModel/TheChatBot_BoneNames.txt'

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

const IDLE_CLIP_PREFERENCES = [
  '2563486400256_TempMotion_BAKED',
  'TheChatBot|A|Default',
  '2563486400256_TempMotion',
]

const IDLE_CLIP_PATTERNS = [/TempMotion_BAKED/i, /TheChatBot\|A\|Default/i, /TempMotion/i]

/** Pick one idle clip — new ANIMATION.glb ships several; old file had only TempMotion_BAKED. */
export function selectIdleClips(clips) {
  if (!clips.length) return []

  for (const preferredName of IDLE_CLIP_PREFERENCES) {
    const exact = clips.find((clip) => clip.name === preferredName)
    if (exact) return [exact]
  }

  for (const pattern of IDLE_CLIP_PATTERNS) {
    const match = clips.find((clip) => pattern.test(clip.name))
    if (match) return [match]
  }

  const filtered = clips.filter(
    (clip) => !/tripo_node|Armature\.001\|Default/i.test(clip.name),
  )
  return filtered.length ? [filtered[0]] : [clips[0]]
}

/** Loop the selected idle clip from ANIMATION.glb onto the character. */
export function playLoopingAnimations(model, clips) {
  const idleClips = selectIdleClips(clips)
  const mixer = new THREE.AnimationMixer(model)
  const clock = new THREE.Clock()

  const actions = idleClips.map((clip) => {
    const action = mixer.clipAction(clip, model)
    action.setLoop(THREE.LoopRepeat)
    action.clampWhenFinished = false
    action.play()
    return action
  })

  return {
    mixer,
    actions,
    clipNames: idleClips.map((clip) => clip.name),
    update() {
      mixer.update(clock.getDelta())
    },
    dispose() {
      mixer.stopAllAction()
    },
  }
}
