import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectIdleClips } from '../src/avatarAnimations.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const modelDir = path.join(__dirname, '../public/models/AbuSahelModel')

function readGlbJson(fileName) {
  const buffer = fs.readFileSync(path.join(modelDir, fileName))
  const jsonLength = buffer.readUInt32LE(12)
  const jsonStart = 20
  return JSON.parse(buffer.toString('utf8', jsonStart, jsonStart + jsonLength))
}

function nodeName(gltf, index) {
  return gltf.nodes?.[index]?.name || `node_${index}`
}

function collectSkinJointNames(gltf) {
  const names = new Set()
  for (const skin of gltf.skins || []) {
    for (const jointIndex of skin.joints || []) {
      names.add(nodeName(gltf, jointIndex))
    }
  }
  return [...names].sort()
}

function collectMorphNames(gltf) {
  const names = new Set()
  for (const mesh of gltf.meshes || []) {
    for (const target of mesh.extras?.targetNames || []) names.add(target)
    for (const primitive of mesh.primitives || []) {
      const dict = primitive.extras?.targetNames
      if (Array.isArray(dict)) dict.forEach((name) => names.add(name))
    }
  }
  return [...names].sort()
}

function collectClipBoneNames(gltf) {
  const names = new Set()
  for (const anim of gltf.animations || []) {
    for (const channel of anim.channels || []) {
      const nodeIndex = channel.target?.node
      if (nodeIndex !== undefined) names.add(nodeName(gltf, nodeIndex))
    }
  }
  return [...names].sort()
}

function toClips(gltf) {
  return (gltf.animations || []).map((anim) => ({ name: anim.name || 'unnamed' }))
}

const expectedBones = fs
  .readFileSync(path.join(modelDir, 'TheChatBot_BoneNames.txt'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)

const lipTargets = [
  'Jaw_Open',
  'V_Open',
  'V_Lip_Open',
  'V_Wide',
  'V_Tight',
  'V_Dental_Lip',
  'Mouth_Close',
]
const eyeTargets = ['Eye_Blink_L', 'Eye_Blink_R', 'Eye_Squint_L', 'Eye_Squint_R']

const modelGltf = readGlbJson('AbuSahelModel.glb')
const animGltf = readGlbJson('ANIMATION.glb')

const modelBones = collectSkinJointNames(modelGltf)
const morphs = collectMorphNames(modelGltf)
const animBones = collectClipBoneNames(animGltf)
const selectedClip = selectIdleClips(toClips(animGltf))[0]?.name

const missingFromModel = expectedBones.filter((name) => !modelBones.includes(name))
const animNotInModel = animBones.filter((name) => !modelBones.includes(name))
const missingLip = lipTargets.filter((name) => !morphs.includes(name))
const missingEye = eyeTargets.filter((name) => !morphs.includes(name))

console.log('=== AbuSahelModel.glb ===')
console.log('bones:', modelBones.length)
console.log('morph targets:', morphs.length)

console.log('=== ANIMATION.glb ===')
console.log('clips:', (animGltf.animations || []).map((c) => c.name).join(', ') || '(none)')
console.log('selected idle clip:', selectedClip || '(none)')

console.log('\n=== Checks ===')
console.log('missing bones vs TheChatBot_BoneNames.txt:', missingFromModel.length ? missingFromModel : '(none)')
console.log('animation bones missing on model:', animNotInModel.length ? animNotInModel : '(none)')
console.log('missing lip morphs:', missingLip.length ? missingLip : '(none)')
console.log('missing eye morphs:', missingEye.length ? missingEye : '(none)')

if (missingFromModel.length || !selectedClip || missingLip.length || missingEye.length) {
  process.exitCode = 1
}
