/**
 * Page controller for voice.html — a standalone mic page built on the vvs
 * pipeline. Deliberately self-contained: it shares nothing with main.js, so
 * another team can lift voice.html + src/voice.js + src/voicePipeline.js +
 * server/voiceApi.js and drop them into their own app.
 */

import './voice.css'
import { createVoicePipeline } from './voicePipeline.js'

const startBtn = document.getElementById('startBtn')
const stopBtn = document.getElementById('stopBtn')
const statusText = document.getElementById('statusText')
const statusDot = document.getElementById('statusDot')
const transcriptBox = document.getElementById('transcriptBox')
const answerBox = document.getElementById('answerBox')
const debugBox = document.getElementById('debugBox')

const STATUS_LABELS = {
  idle: 'جاهز',
  listening: 'أنت تتكلم الآن...',
  transcribing: 'جاري تحويل الصوت إلى نص...',
  asking: 'جاري سؤال الـ RAG...',
  answering: 'يجيب الآن...',
  done: 'اكتمل',
  error: 'خطأ',
}

function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

const pipeline = createVoicePipeline({
  onStatus(status) {
    statusText.textContent = STATUS_LABELS[status] || status
    statusDot.classList.toggle('live', status === 'listening')
  },

  onTranscript({ text, interim }) {
    transcriptBox.innerHTML =
      `<span>${escapeHtml(text)}</span>` +
      (interim ? ` <span class="interim">${escapeHtml(interim)}</span>` : '')
  },

  onAnswer({ text }) {
    answerBox.textContent = text
  },

  onTiming(marks) {
    for (const [name, seconds] of Object.entries(marks)) {
      const cell = document.getElementById(`t-${name}`)
      if (cell) cell.textContent = `${seconds}s`
    }
  },

  onDebug(message) {
    debugBox.textContent = message
  },
})

startBtn.addEventListener('click', async () => {
  transcriptBox.textContent = ''
  answerBox.textContent = ''
  debugBox.textContent = ''
  for (const cell of document.querySelectorAll('.timing b')) cell.textContent = '-'

  try {
    await pipeline.start()
    startBtn.disabled = true
    stopBtn.disabled = false
  } catch (error) {
    debugBox.textContent = `تعذر الوصول للميكروفون: ${error.message}`
    statusText.textContent = STATUS_LABELS.error
  }
})

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true
  try {
    await pipeline.stop()
  } catch (error) {
    debugBox.textContent = error.message
  } finally {
    startBtn.disabled = false
  }
})
