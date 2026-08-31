/**
 * Streaming voice pipeline — ported from the `vvs` project
 * (github.com/MohammadHajjaj03/vvs, voice_pipeline.py).
 *
 * Same method, different stack: vvs ran the whole flow through a FastAPI
 * backend (OpenAI STT + ElevenLabs TTS). Here everything stays in the browser
 * and reuses AbuSahel's existing Gemini modules, but the pipeline shape is
 * identical:
 *
 *   mic -> live browser transcript -> STT -> RAG (SSE stream)
 *       -> boundary-split answer deltas -> FIFO TTS chunk queue -> audio
 *
 * The point of the design is that speech starts playing while the RAG answer
 * is still being generated, instead of waiting for the full answer.
 *
 * Usage:
 *   const pipeline = createVoicePipeline({
 *     onStatus, onTranscript, onAnswer, onTiming, onDebug,
 *   })
 *   await pipeline.start()   // begins recording
 *   await pipeline.stop()    // stops, transcribes, streams answer + speech
 */

import { transcribeAudio } from './transcribe.js'
import { speakText, stopSpeaking } from './speak.js'

const RAG_STREAM_URL =
  import.meta.env.VITE_RAG_STREAM_URL ||
  'https://faqragsystem-production-88c2.up.railway.app/query'

// Chunking thresholds, carried over from vvs.
const FLUSH_WORD_COUNT = 32 // force a TTS chunk once the buffer reaches this
const MIN_WORD_COUNT = 14 // don't speak a chunk shorter than this unless forced
const IDLE_FLUSH_MS = 1400 // ...unless the stream goes quiet for this long

// Boundaries we're willing to cut a spoken chunk at (Arabic + Latin).
const BOUNDARY_CHARS = [' ', '\n', '.', ',', '،', '؛', ';', ':', '!', '?', '؟']

/* -------------------------------------------------------------------------
 * SSE parsing
 * `vvs` parsed the event stream twice — once in Python over the RAG response,
 * once in JS over its own backend stream. Only one parser is needed here.
 * ---------------------------------------------------------------------- */

function parseSseBlock(rawEvent) {
  let eventName = 'message'
  const dataLines = []

  for (const line of rawEvent.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }

  if (!dataLines.length) return null

  const raw = dataLines.join('\n')
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = { text: raw }
  }
  if (typeof payload !== 'object' || payload === null) {
    payload = { value: payload }
  }

  return { event: eventName, payload }
}

/**
 * POSTs the question and yields `{ event, payload }` for each SSE frame.
 * Falls back to a single synthetic `delta` + `final` pair if the endpoint
 * answers with plain JSON instead of a stream — same fallback vvs had.
 */
async function* streamRagSse(text, signal) {
  const response = await fetch(RAG_STREAM_URL, {
    method: 'POST',
    headers: { accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, stream: true }),
    signal,
  })

  if (!response.ok) {
    throw new Error(`RAG API error (${response.status})`)
  }

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('event-stream') || !response.body) {
    const data = await response.json().catch(() => ({}))
    const answer = (data.answer || data.text || data.response || '').trim()
    if (!answer) throw new Error('No answer returned from RAG API')
    yield { event: 'metadata', payload: { source: 'non-streaming' } }
    yield { event: 'delta', payload: { text: answer } }
    yield { event: 'final', payload: data }
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() || ''
    for (const block of blocks) {
      const parsed = parseSseBlock(block)
      if (parsed) yield parsed
    }
  }

  if (buffer.trim()) {
    const parsed = parseSseBlock(buffer)
    if (parsed) yield parsed
  }
}

/* -------------------------------------------------------------------------
 * Boundary splitting — decides how much of the streamed answer is safe to
 * hand to TTS. Text after the last boundary is carried forward so a chunk
 * never ends mid-word.
 * ---------------------------------------------------------------------- */

function splitStableSpeechText(text) {
  let lastBoundary = -1
  for (const char of BOUNDARY_CHARS) {
    lastBoundary = Math.max(lastBoundary, text.lastIndexOf(char))
  }
  if (lastBoundary === -1) return { ready: '', carry: text }
  return {
    ready: text.slice(0, lastBoundary + 1),
    carry: text.slice(lastBoundary + 1),
  }
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/* -------------------------------------------------------------------------
 * Pipeline
 * ---------------------------------------------------------------------- */

export function createVoicePipeline({
  onStatus = () => {},
  onTranscript = () => {},
  onAnswer = () => {},
  onTiming = () => {},
  onDebug = () => {},
  language = 'ar',
} = {}) {
  let mediaRecorder = null
  let mediaStream = null
  let audioChunks = []
  let recognition = null
  let abortController = null

  // live browser transcript (SpeechRecognition), shown while the user speaks
  let finalBrowserTranscript = ''
  let interimTranscript = ''

  // answer + TTS chunking state
  let answerText = ''
  let speechBuffer = ''
  let speechCarry = ''
  let speechIdleTimer = null
  let speechQueue = Promise.resolve()

  // latency marks
  let turnStart = 0
  const marks = {}

  function mark(name) {
    if (marks[name] !== undefined || !turnStart) return
    marks[name] = Number(((performance.now() - turnStart) / 1000).toFixed(3))
    onTiming({ ...marks })
  }

  function reset() {
    finalBrowserTranscript = ''
    interimTranscript = ''
    answerText = ''
    speechBuffer = ''
    speechCarry = ''
    speechQueue = Promise.resolve()
    if (speechIdleTimer) {
      clearTimeout(speechIdleTimer)
      speechIdleTimer = null
    }
    for (const key of Object.keys(marks)) delete marks[key]
    turnStart = 0
    stopSpeaking()
  }

  /* --- live transcript ---------------------------------------------- */

  function setupRecognition() {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) return null

    const instance = new SpeechRecognition()
    instance.lang = language === 'ar' ? 'ar-SA' : 'en-US'
    instance.continuous = true
    instance.interimResults = true
    instance.onresult = (event) => {
      let finalText = ''
      let interimText = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const text = event.results[i][0].transcript
        if (event.results[i].isFinal) finalText += `${text} `
        else interimText += text
      }
      finalBrowserTranscript += finalText
      interimTranscript = interimText
      onTranscript({
        text: finalBrowserTranscript.trim(),
        interim: interimTranscript,
        final: false,
      })
    }
    return instance
  }

  /* --- FIFO TTS queue ------------------------------------------------ */
  // vvs kept an explicit array of pre-warmed <audio> elements because
  // ElevenLabs streamed bytes. Gemini TTS returns a whole clip, so a serial
  // promise chain gives the same guarantee: chunks play in order, and the
  // next chunk is requested as soon as the previous one finishes.

  function enqueueSpeech(text) {
    speechQueue = speechQueue
      .then(async () => {
        mark('firstTtsRequest')
        await speakText(text, language)
        mark('firstAudible')
      })
      .catch((error) => {
        onDebug(`TTS chunk failed: ${error.message}`)
      })
    return speechQueue
  }

  function flushSpeechBuffer(force) {
    if (speechIdleTimer) {
      clearTimeout(speechIdleTimer)
      speechIdleTimer = null
    }
    if (force && speechCarry) {
      speechBuffer += speechCarry
      speechCarry = ''
    }

    const text = speechBuffer.trim()
    if (!text) return

    if (!force && wordCount(text) < MIN_WORD_COUNT) {
      speechIdleTimer = setTimeout(() => flushSpeechBuffer(false), IDLE_FLUSH_MS)
      return
    }

    speechBuffer = ''
    enqueueSpeech(text)
  }

  function appendSpeechDelta(deltaText) {
    if (!deltaText) return
    const { ready, carry } = splitStableSpeechText(speechCarry + deltaText)
    speechBuffer += ready
    speechCarry = carry

    if (speechIdleTimer) clearTimeout(speechIdleTimer)

    if (wordCount(speechBuffer) >= FLUSH_WORD_COUNT) {
      flushSpeechBuffer(false)
    } else {
      speechIdleTimer = setTimeout(() => flushSpeechBuffer(false), IDLE_FLUSH_MS)
    }
  }

  /* --- public API ----------------------------------------------------- */

  async function start() {
    reset()
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' })
    audioChunks = []

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunks.push(event.data)
    }

    recognition = setupRecognition()
    if (recognition) {
      try {
        recognition.start()
      } catch {
        /* already running */
      }
    }

    mediaRecorder.start()
    onStatus('listening')
  }

  async function stop() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return null

    const recorded = new Promise((resolve) => {
      mediaRecorder.onstop = resolve
    })
    mediaRecorder.stop()
    await recorded

    mediaStream?.getTracks().forEach((track) => track.stop())
    if (recognition) {
      try {
        recognition.stop()
      } catch {
        /* ignore */
      }
    }

    return process(new Blob(audioChunks, { type: 'audio/webm' }))
  }

  /** STT -> streamed RAG -> chunked speech. Resolves when audio finishes. */
  async function process(blob) {
    turnStart = performance.now()
    abortController = new AbortController()

    try {
      onStatus('transcribing')
      const transcript = await transcribeAudio(blob)
      mark('stt')
      onTranscript({ text: transcript.text, interim: '', final: true })

      onStatus('asking')
      let finalPayload = null

      for await (const { event, payload } of streamRagSse(
        transcript.text,
        abortController.signal,
      )) {
        if (event === 'metadata') {
          onDebug(`RAG metadata: ${JSON.stringify(payload)}`)
          continue
        }

        if (event === 'delta') {
          const delta = String(
            payload.text ?? payload.delta ?? payload.answer ?? payload.value ?? '',
          )
          if (!delta) continue
          answerText += delta
          mark('firstDelta')
          onStatus('answering')
          onAnswer({ text: answerText, delta })
          appendSpeechDelta(delta)
          continue
        }

        if (event === 'final') {
          finalPayload = payload
          if (!answerText) {
            for (const key of ['answer', 'text', 'response', 'output']) {
              if (typeof payload[key] === 'string') {
                answerText = payload[key].trim()
                onAnswer({ text: answerText, delta: answerText })
                appendSpeechDelta(answerText)
                break
              }
            }
          }
        }
      }

      mark('ragTotal')
      flushSpeechBuffer(true)
      await speechQueue
      mark('total')

      onStatus('done')
      return {
        question: transcript.text,
        language: transcript.language,
        answer: answerText,
        finalPayload,
        timings: { ...marks },
      }
    } catch (error) {
      onStatus('error')
      onDebug(error.message)
      throw error
    } finally {
      abortController = null
    }
  }

  function cancel() {
    abortController?.abort()
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop()
    mediaStream?.getTracks().forEach((track) => track.stop())
    reset()
    onStatus('idle')
  }

  return { start, stop, process, cancel }
}

export { splitStableSpeechText, streamRagSse }
