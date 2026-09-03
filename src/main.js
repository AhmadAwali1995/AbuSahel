import './style.css'
import { createAvatar } from './avatar.js'
import { createVoicePipeline } from './voicePipeline.js'

const app = document.querySelector('#app')

const header = document.createElement('header')
header.className = 'app-header'
header.innerHTML = '<h1 class="app-header__title">نسخة تجريبية</h1>'
app.appendChild(header)

const stage = document.createElement('div')
stage.className = 'stage'
stage.innerHTML = '<p class="stage-loading">Loading Abu Sahel…</p>'
app.appendChild(stage)

const footer = document.createElement('footer')
footer.className = 'app-footer'
app.appendChild(footer)

const micButton = document.createElement('button')
micButton.type = 'button'
micButton.id = 'mic-button'
micButton.className = 'mic-button'
micButton.innerHTML = '🎤'
micButton.title = 'Microphone'
micButton.disabled = true
footer.appendChild(micButton)

let avatar = null
let isRecording = false
let isBusy = false

function resetMicIdle() {
  isBusy = false
  isRecording = false
  micButton.classList.remove('loading', 'recording')
}

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
    if (status === 'listening') isRecording = true

    const pending = status === 'transcribing' || status === 'asking' || status === 'answering'
    micButton.classList.toggle('loading', pending)

    // Start think animation when question is being processed
    if (pending && !avatar?.isThinking) {
      avatar?.toggleThinking()
    }

    if (status === 'done') {
      if (avatar?.isThinking) avatar.toggleThinking()
      resetMicIdle()
    } else if (status === 'idle' || status === 'error') {
      if (avatar?.isThinking) avatar.toggleThinking()
      avatar?.stopSpeaking()
      resetMicIdle()
    }
  },

  onTtsAudio(audio) {
    if (!avatar) return
    // Stop thinking — answer has arrived
    if (avatar.isThinking) avatar.toggleThinking()
    void avatar.speak(audio)
  },
})

micButton.addEventListener('click', async () => {
  if (isBusy) return

  if (!isRecording) {
    try {
      avatar?.stopSpeaking()
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
    resetMicIdle()
  }
})
