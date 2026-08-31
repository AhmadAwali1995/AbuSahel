import './style.css'
import { transcribeAudio } from './transcribe.js'
import { speakText } from './speak.js'
import { askQuestion } from './askApi.js'

const app = document.querySelector('#app')

const STATUS_IMAGES = {
  idle: '/models/AbuSahelModel/AbuShl.jpg',
  thinking: '/models/AbuSahelModel/AbuShlThinking.jpg',
  answer: '/models/AbuSahelModel/AbuShlAnswer.jpg',
  angry: '/models/AbuSahelModel/AbuShlAngry.jpg',
  disappointment: '/models/AbuSahelModel/AbuShlDisappointment.jpg',
}

const DISAPPOINTMENT_MESSAGE = {
  ar: 'آسف، ما قدرت أجاوبك الحين. جرّب تسألني مرة ثانية، يمكن أقدر أساعدك.',
  en: "Sorry, I couldn't answer that right now. Please try asking again — I'd love to help.",
}

let currentStatus = 'idle'
let statusChangeId = 0

const avatar = document.createElement('div')
avatar.className = 'avatar'
avatar.innerHTML = `
  <img
    class="avatar-image"
    src="${STATUS_IMAGES.idle}"
    alt="AbuSahel"
    width="320"
    height="480"
  />
`
app.appendChild(avatar)

const avatarImage = avatar.querySelector('.avatar-image')

const statusPanel = document.createElement('div')
statusPanel.className = 'status-panel'
statusPanel.setAttribute('role', 'group')
statusPanel.setAttribute('aria-label', 'Bot status')
statusPanel.innerHTML = `
  <button type="button" class="status-button is-active" data-status="idle">Idle</button>
  <button type="button" class="status-button" data-status="thinking">Thinking</button>
  <button type="button" class="status-button" data-status="answer">Answer</button>
  <button type="button" class="status-button" data-status="angry">Angry</button>
  <button type="button" class="status-button" data-status="disappointment">Disappointment</button>
`
app.appendChild(statusPanel)

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function showDisappointmentMessage() {
  transcriptPanel.innerHTML = `
    <span class="transcript-lang">AbuSahel</span>
    <p class="disappointment-message disappointment-message--ar" dir="rtl" lang="ar">${escapeHtml(DISAPPOINTMENT_MESSAGE.ar)}</p>
    <p class="disappointment-message disappointment-message--en" lang="en">${escapeHtml(DISAPPOINTMENT_MESSAGE.en)}</p>
  `
}

function setBotStatus(status) {
  if (!STATUS_IMAGES[status]) return

  statusPanel.querySelectorAll('.status-button').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.status === status)
  })

  if (status === currentStatus) return

  currentStatus = status
  avatarImage.alt = `AbuSahel — ${status}`

  if (status === 'disappointment') {
    showDisappointmentMessage()
  }

  const changeId = (statusChangeId += 1)
  const nextSrc = STATUS_IMAGES[status]

  const applyImage = () => {
    if (changeId !== statusChangeId) return
    avatarImage.src = nextSrc
    avatarImage.classList.remove('is-leaving')
    void avatarImage.offsetWidth
    avatarImage.classList.add('is-entering')
  }

  avatarImage.classList.remove('is-entering')
  avatarImage.classList.add('is-leaving')

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    applyImage()
    return
  }

  const onLeaveEnd = (event) => {
    if (event.animationName !== 'avatar-leave') return
    avatarImage.removeEventListener('animationend', onLeaveEnd)
    applyImage()
  }

  avatarImage.addEventListener('animationend', onLeaveEnd)
}

statusPanel.addEventListener('click', (event) => {
  const button = event.target.closest('.status-button')
  if (!button) return
  setBotStatus(button.dataset.status)
})

const micButton = document.createElement('button')
micButton.type = 'button'
micButton.id = 'mic-button'
micButton.className = 'mic-button'
micButton.innerHTML = '🎤'
micButton.title = 'Microphone'
app.appendChild(micButton)

const transcriptPanel = document.createElement('div')
transcriptPanel.className = 'transcript-panel'
transcriptPanel.textContent = 'Click mic to speak'
app.appendChild(transcriptPanel)

let mediaRecorder = null
let audioChunks = []
let isRecording = false
let isBusy = false
let isSpeaking = false
let latestAnswer = null

function showAnswer(language, question, answer) {
  latestAnswer = { language, text: answer }
  const languageLabel = language === 'ar' ? 'Arabic' : 'English'

  transcriptPanel.innerHTML = `
    <span class="transcript-lang">${languageLabel} (${language})</span>
    <p class="transcript-question"><strong>Q:</strong> ${escapeHtml(question)}</p>
    <div class="transcript-row">
      <p class="transcript-text"><strong>A:</strong> ${escapeHtml(answer)}</p>
      <button type="button" class="speak-button" title="Play voice">🔊</button>
    </div>
  `

  transcriptPanel.querySelector('.speak-button').addEventListener('click', handleSpeakClick)
}

async function handleSpeakClick(event) {
  if (!latestAnswer || isSpeaking) return

  const button = event.currentTarget
  isSpeaking = true
  button.classList.add('loading')
  button.disabled = true
  setBotStatus('answer')

  let speakFailed = false
  try {
    await speakText(latestAnswer.text, latestAnswer.language)
  } catch (error) {
    speakFailed = true
    console.error('Text-to-speech failed:', error)
  } finally {
    isSpeaking = false
    button.classList.remove('loading')
    button.disabled = false
    setBotStatus(speakFailed ? 'disappointment' : 'idle')
  }
}

async function handleVoiceQuestion(blob) {
  isBusy = true
  micButton.classList.add('loading')
  setBotStatus('thinking')
  transcriptPanel.textContent = 'Transcribing...'

  try {
    const { language, text } = await transcribeAudio(blob)
    transcriptPanel.innerHTML = `
      <span class="transcript-lang">Question</span>
      <p class="transcript-text">${escapeHtml(text)}</p>
      <p class="transcript-status">Asking AI...</p>
    `
    console.log('Transcript:', { language, text })

    const result = await askQuestion(text)
    const answerLanguage = result.language || language
    showAnswer(answerLanguage, text, result.answer)
    console.log('Ask API:', result)

    isSpeaking = true
    setBotStatus('answer')
    const speakButton = transcriptPanel.querySelector('.speak-button')
    if (speakButton) {
      speakButton.classList.add('loading')
      speakButton.disabled = true
    }

    let speakFailed = false
    try {
      await speakText(result.answer, answerLanguage)
    } catch (error) {
      speakFailed = true
      console.error('Auto text-to-speech failed:', error)
    } finally {
      isSpeaking = false
      if (speakButton) {
        speakButton.classList.remove('loading')
        speakButton.disabled = false
      }
      setBotStatus(speakFailed ? 'disappointment' : 'idle')
    }
  } catch (error) {
    latestAnswer = null
    console.error('Voice question failed:', error)
    setBotStatus('disappointment')
  } finally {
    isBusy = false
    micButton.classList.remove('loading')
  }
}

micButton.addEventListener('click', async () => {
  if (isBusy || isSpeaking) return

  if (isRecording) {
    mediaRecorder.stop()
    return
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    audioChunks = []
    mediaRecorder = new MediaRecorder(stream)

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunks.push(event.data)
    }

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop())
      micButton.classList.remove('recording')
      isRecording = false

      const blob = new Blob(audioChunks, {
        type: mediaRecorder.mimeType || 'audio/webm',
      })

      if (blob.size === 0) {
        latestAnswer = null
        transcriptPanel.textContent = 'No audio recorded'
        return
      }

      await handleVoiceQuestion(blob)
    }

    mediaRecorder.start()
    isRecording = true
    micButton.classList.add('recording')
    transcriptPanel.textContent = 'Recording... click mic to stop'
  } catch (error) {
    console.error('Microphone access failed:', error)
    setBotStatus('disappointment')
  }
})
