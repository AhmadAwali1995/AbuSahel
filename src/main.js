import './style.css'
import { createAvatar } from './avatar.js'
import { createVoicePipeline } from './voicePipeline.js'

const app = document.querySelector('#app')

const stage = document.createElement('div')
stage.className = 'stage'
stage.innerHTML = '<p class="stage-loading">Loading Abu Sahel…</p>'
app.appendChild(stage)

const micButton = document.createElement('button')
micButton.type = 'button'
micButton.id = 'mic-button'
micButton.className = 'mic-button'
micButton.innerHTML = '🎤'
micButton.title = 'Microphone'
micButton.disabled = true
app.appendChild(micButton)

let avatar = null
let isRecording = false
let isBusy = false

try {
  avatar = await createAvatar(stage)
  stage.querySelector('.stage-loading')?.remove()
  micButton.disabled = false
} catch (error) {
  console.error('Failed to load 3D model:', error)
  const loading = stage.querySelector('.stage-loading')
  if (loading) loading.textContent = 'Could not load 3D model.'
}

const pipeline = createVoicePipeline({
  onStatus(status) {
    micButton.classList.toggle('recording', status === 'listening')
    const pending = status === 'transcribing' || status === 'asking' || status === 'answering'
    micButton.classList.toggle('loading', pending)

    if (status === 'done' || status === 'idle' || status === 'error') {
      avatar?.stopSpeaking()
      isBusy = false
      isRecording = status === 'listening'
      micButton.classList.remove('loading')
      if (status !== 'listening') micButton.classList.remove('recording')
    }
  },

  onTtsAudio(audio) {
    if (!avatar) return
    void avatar.speak(audio)
  },
})

micButton.addEventListener('click', async () => {
  if (isBusy) return

  if (!isRecording) {
    try {
      await pipeline.start()
      isRecording = true
    } catch (error) {
      console.error('Microphone access failed:', error)
      isRecording = false
      micButton.classList.remove('recording')
    }
    return
  }

  isRecording = false
  isBusy = true
  micButton.classList.add('loading')
  micButton.classList.remove('recording')

  try {
    await pipeline.stop()
  } catch (error) {
    console.error('Voice question failed:', error)
    avatar?.stopSpeaking()
  } finally {
    isBusy = false
    micButton.classList.remove('loading', 'recording')
  }
})
