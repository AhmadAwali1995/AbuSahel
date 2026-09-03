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
stage.innerHTML = `
  <div class="stage-frame" aria-hidden="true">
    <span class="stage-frame__corner stage-frame__corner--tl"></span>
    <span class="stage-frame__corner stage-frame__corner--tr"></span>
    <span class="stage-frame__corner stage-frame__corner--bl"></span>
    <span class="stage-frame__corner stage-frame__corner--br"></span>
  </div>
  <img
    class="stage-logo"
    src="/models/AbuSahelModel/mwafaq_logo.png"
    alt="mwafq"
  />
  <img
    class="stage-slogan"
    src="/models/AbuSahelModel/slogan.png"
    alt="أسهل .. أسرع .. أفضل"
  />
  <p class="stage-loading">Loading Abu Sahel…</p>
`
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

const button1 = document.createElement('button')
button1.type = 'button'
button1.className = 'mic-button'
button1.textContent = '1'
button1.title = 'Toggle talk_confident animation'
button1.disabled = true
button1.style.marginLeft = '10px'
footer.appendChild(button1)

const button2 = document.createElement('button')
button2.type = 'button'
button2.className = 'mic-button'
button2.textContent = '2'
button2.title = 'Toggle uncut_animations'
button2.disabled = true
button2.style.marginLeft = '10px'
footer.appendChild(button2)

function syncTalkButtons() {
  const active = avatar?.activeTalk ?? null
  button1.classList.toggle('recording', active === 'talk_confident')
  button2.classList.toggle('recording', active === 'uncut_animations')
}

button1.addEventListener('click', () => {
  if (!avatar) return
  avatar.toggleTalk('talk_confident')
  syncTalkButtons()
})

button2.addEventListener('click', () => {
  if (!avatar) return
  avatar.toggleTalk('uncut_animations')
  syncTalkButtons()
})

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
  button1.disabled = false
  button2.disabled = false
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
      syncTalkButtons()
    }

    if (status === 'done') {
      if (avatar?.isThinking) avatar.toggleThinking()
      syncTalkButtons()
      resetMicIdle()
    } else if (status === 'idle' || status === 'error') {
      if (avatar?.isThinking) avatar.toggleThinking()
      syncTalkButtons()
      avatar?.stopSpeaking()
      resetMicIdle()
    }
  },

  onTtsAudio(audio) {
    if (!avatar) return
    // speak() crossfades think → talk_1 and stops talk when audio ends
    void avatar.speak(audio)
    syncTalkButtons()
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
