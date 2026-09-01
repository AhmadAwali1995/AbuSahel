import './style.css'
import { createVoicePipeline } from './voicePipeline.js'

const app = document.querySelector('#app')

const avatar = document.createElement('div')
avatar.className = 'avatar'
app.appendChild(avatar)

function createClip(src) {
  const video = document.createElement('video')
  video.className = 'avatar-video'
  video.src = src
  video.loop = true
  video.muted = true
  video.playsInline = true
  video.setAttribute('playsinline', '')
  video.preload = 'auto'
  avatar.appendChild(video)
  return video
}

const clips = {
  thinking: createClip('/models/AbuSahelModel/AbuShlThinking.mp4'),
  speaking: createClip('/models/AbuSahelModel/AbuShlVideo.mp4'),
}

function setAvatarClip(name) {
  for (const [key, video] of Object.entries(clips)) {
    const on = key === name
    video.classList.toggle('is-active', on)
    if (on) {
      void video.play()
    } else {
      video.pause()
      video.currentTime = 0
    }
  }
}

const micButton = document.createElement('button')
micButton.type = 'button'
micButton.id = 'mic-button'
micButton.className = 'mic-button'
micButton.innerHTML = '🎤'
micButton.title = 'Microphone'
app.appendChild(micButton)

let isRecording = false
let isBusy = false

const pipeline = createVoicePipeline({
  onStatus(status) {
    micButton.classList.toggle('recording', status === 'listening')
    const pending = status === 'transcribing' || status === 'asking' || status === 'answering'
    micButton.classList.toggle('loading', pending)

    if (status === 'transcribing' || status === 'asking') setAvatarClip('thinking')
    else if (status === 'answering') setAvatarClip('speaking')
    else setAvatarClip(null)

    if (status === 'done' || status === 'idle' || status === 'error') {
      isBusy = false
      isRecording = status === 'listening'
      micButton.classList.remove('loading')
      if (status !== 'listening') micButton.classList.remove('recording')
    }
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
  setAvatarClip('thinking')

  try {
    await pipeline.stop()
  } catch (error) {
    console.error('Voice question failed:', error)
    setAvatarClip(null)
  } finally {
    isBusy = false
    micButton.classList.remove('loading', 'recording')
    setAvatarClip(null)
  }
})
