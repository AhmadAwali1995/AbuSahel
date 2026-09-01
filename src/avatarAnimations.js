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

/** Apply every clip from ANIMATION.glb onto the character, looping continuously. */
export function playLoopingAnimations(model, clips) {
  const mixer = new THREE.AnimationMixer(model)
  const clock = new THREE.Clock()

  const actions = clips.map((clip) => {
    const action = mixer.clipAction(clip, model)
    action.setLoop(THREE.LoopRepeat)
    action.clampWhenFinished = false
    action.play()
    return action
  })

  return {
    mixer,
    actions,
    update() {
      mixer.update(clock.getDelta())
    },
    dispose() {
      mixer.stopAllAction()
    },
  }
}
