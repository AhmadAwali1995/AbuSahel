import './style.css'
import { createAvatar } from './avatar.js'
import { createVoicePipeline } from './voicePipeline.js'
import { playTts } from './tts.js'

const DEFAULT_TEST_TEXT = 'مرحباً، أنا أبو سهيل. كيف يمكنني مساعدتك اليوم؟'

const app = document.querySelector('#app')

const stage = document.createElement('div')
stage.className = 'stage'
stage.innerHTML = '<p class="stage-loading">Loading Abu Sahel…</p>'
app.appendChild(stage)

const testPanel = document.createElement('div')
testPanel.className = 'test-panel'

const testLabel = document.createElement('label')
testLabel.className = 'test-label'
testLabel.htmlFor = 'test-text'
testLabel.textContent = 'نص تجريبي'

const testTextarea = document.createElement('textarea')
testTextarea.id = 'test-text'
testTextarea.className = 'test-text'
testTextarea.rows = 4
testTextarea.dir = 'rtl'
testTextarea.value = DEFAULT_TEST_TEXT

const testVoiceButton = document.createElement('button')
testVoiceButton.type = 'button'
testVoiceButton.className = 'test-voice-button'
testVoiceButton.textContent = 'Test voice'
testVoiceButton.disabled = true

testPanel.append(testLabel, testTextarea, testVoiceButton)
app.appendChild(testPanel)

const micButton = document.createElement('button')
micButton.type = 'button'
micButton.id = 'mic-button'
micButton.className = 'mic-button'
micButton.innerHTML = '🎤'
micButton.title = 'Microphone'
app.appendChild(micButton)

let avatar = null
let isRecording = false
let isBusy = false
let isTestPlaying = false

try {
  avatar = await createAvatar(stage)
  stage.querySelector('.stage-loading')?.remove()
  testVoiceButton.disabled = false
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
      isBusy = false
      isRecording = status === 'listening'
      micButton.classList.remove('loading')
      if (status !== 'listening') micButton.classList.remove('recording')
    }
  },
})

testVoiceButton.addEventListener('click', async () => {
  if (isTestPlaying || !avatar) return

  isTestPlaying = true
  testVoiceButton.disabled = true
  testVoiceButton.classList.add('loading')

  try {
    await playTts(testTextarea.value, {
      onAudio: (audio) => {
        void avatar.speak(audio)
      },
    })
  } catch (error) {
    console.error('Test voice failed:', error)
  } finally {
    avatar?.stopSpeaking()
    isTestPlaying = false
    testVoiceButton.disabled = !avatar
    testVoiceButton.classList.remove('loading')
  }
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
  } finally {
    isBusy = false
    micButton.classList.remove('loading', 'recording')
  }
})
