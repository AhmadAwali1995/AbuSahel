/**
 * Direct translation of the vvs pipeline (github.com/MohammadHajjaj03/vvs,
 * voice_pipeline.py + its INDEX_HTML script) into a module.
 *
 *   mic -> live browser transcript -> STT -> RAG (SSE) -> boundary-split
 *       deltas -> FIFO TTS chunk queue -> audio
 *
 * Function names and order follow the original so the two can be diffed:
 * splitStableSpeechText, shouldFlushSpeechBuffer, appendSpeechDelta,
 * flushSpeechBuffer, enqueueTtsChunk, prepareNextAudioChunk,
 * warmNextQueuedChunk, pumpAudioQueue.
 *
 * The server half lives in server/voiceApi.js and keeps the same routes vvs
 * had: /api/stt, /api/ask-stream, /api/tts-chunk, /api/tts-stream/<id>.
 *
 * Shares no module with the original AbuSahel app.
 */

const RAG_STREAM_URL = '/api/ask-stream'

// vvs thresholds, unchanged.
const FLUSH_WORD_COUNT = 32
const MIN_WORD_COUNT = 14
const IDLE_FLUSH_MS = 1400

const BOUNDARY_CHARS = [' ', '\n', '.', ',', '،', '؛', ';', ':', '!', '?', '؟']

// The first chunk is allowed to be shorter than the rest: every second spent
// filling it is a second of silence the listener sits through. It is still cut
// at a clause or sentence boundary, so the delivery stays natural — the same
// reason the splitter never cuts mid-word. Chunks after the first keep the vvs
// thresholds, so the bulk of the answer is still spoken in full passages.
const FIRST_CHUNK_MIN_WORDS = 6
const FIRST_CHUNK_IDLE_MS = 400
const CLAUSE_END = ['.', '،', '؛', ';', ':', '!', '?', '؟', '\n']

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */

/** vvs: splitStableSpeechText — never cut a spoken chunk mid-word. */
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

/** vvs: shouldFlushSpeechBuffer */
function shouldFlushSpeechBuffer(text) {
  return wordCount(text) >= FLUSH_WORD_COUNT
}

/** vvs: parseEvent — one SSE frame -> { event, payload }. */
function parseSseBlock(rawEvent) {
  let eventName = 'message'
  const dataLines = []

  for (const line of rawEvent.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) eventName = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }

  if (!dataLines.length) return null

  const raw = dataLines.join('\n')
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = { text: raw }
  }
  if (typeof payload !== 'object' || payload === null) payload = { value: payload }

  return { event: eventName, payload }
}

/** vvs: stream_rag_sse — yields each frame as it arrives. */
async function* streamRagSse(text, signal) {
  const response = await fetch(RAG_STREAM_URL, {
    method: 'POST',
    headers: { accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, stream: true }),
    signal,
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `RAG API error (${response.status})`)
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

/** vvs: speech_to_text — POSTs the recording, gets the clean transcript back. */
async function transcribeAudio(blob) {
  const response = await fetch('/api/stt', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Transcription failed (${response.status})`)
  }

  const data = await response.json()
  if (!data.text?.trim()) throw new Error('No transcription returned from OpenAI')

  return { text: data.text.trim(), language: data.language === 'en' ? 'en' : 'ar' }
}

/* ------------------------------------------------------------------ *
 * Pipeline                                                            *
 * ------------------------------------------------------------------ */

export function createVoicePipeline({
  onStatus = () => {},
  onTranscript = () => {},
  onAnswer = () => {},
  onTiming = () => {},
  onDebug = () => {},
  onTtsAudio = () => {},
  language = 'ar',
} = {}) {
  let mediaRecorder = null
  let mediaStream = null
  let audioChunks = []
  let recognition = null
  let abortController = null

  let finalBrowserTranscript = ''
  let interimTranscript = ''

  let answerText = ''
  let speechBuffer = ''
  let speechCarry = ''
  let speechIdleTimer = null

  // vvs kept exactly these four for the audio queue.
  let chunkSequence = 0
  let pendingChunks = []
  let activeChunk = null
  let ttsRequestInFlight = false

  let turnStart = 0
  const marks = {}

  function mark(name) {
    if (marks[name] !== undefined || !turnStart) return
    marks[name] = Number(((performance.now() - turnStart) / 1000).toFixed(3))
    onTiming({ ...marks })
  }

  /* --- vvs: resetUi ------------------------------------------------- */

  function reset() {
    finalBrowserTranscript = ''
    interimTranscript = ''
    answerText = ''
    speechBuffer = ''
    speechCarry = ''

    if (speechIdleTimer) {
      clearTimeout(speechIdleTimer)
      speechIdleTimer = null
    }

    activeChunk?.audio?.pause()
    for (const chunk of pendingChunks) {
      chunk.audio?.pause()
      chunk.audio?.removeAttribute('src')
    }
    chunkSequence = 0
    pendingChunks = []
    activeChunk = null
    ttsRequestInFlight = false

    for (const key of Object.keys(marks)) delete marks[key]
    turnStart = 0
  }

  /* --- live transcript (browser SpeechRecognition) ------------------ */

  function setupRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
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

  /* --- vvs: the speech buffer --------------------------------------- */

  /** vvs: appendSpeechDelta */
  function appendSpeechDelta(deltaText) {
    if (!deltaText) return

    const { ready, carry } = splitStableSpeechText(speechCarry + deltaText)
    speechBuffer += ready
    speechCarry = carry

    if (speechIdleTimer) clearTimeout(speechIdleTimer)

    const isFirstChunk = chunkSequence === 0

    if (shouldFlushSpeechBuffer(speechBuffer)) {
      void flushSpeechBuffer(false)
      return
    }

    // Start speaking as soon as the first clause is complete.
    if (
      isFirstChunk &&
      wordCount(speechBuffer) >= FIRST_CHUNK_MIN_WORDS &&
      CLAUSE_END.some((mark) => speechBuffer.trimEnd().endsWith(mark))
    ) {
      void flushSpeechBuffer(false)
      return
    }

    speechIdleTimer = setTimeout(
      () => void flushSpeechBuffer(false),
      isFirstChunk ? FIRST_CHUNK_IDLE_MS : IDLE_FLUSH_MS,
    )
  }

  /** vvs: flushSpeechBuffer */
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

    const isFirstChunk = chunkSequence === 0
    const minimum = isFirstChunk ? FIRST_CHUNK_MIN_WORDS : MIN_WORD_COUNT

    if (!force && wordCount(text) < minimum) {
      speechIdleTimer = setTimeout(
        () => void flushSpeechBuffer(false),
        isFirstChunk ? FIRST_CHUNK_IDLE_MS : IDLE_FLUSH_MS,
      )
      return
    }

    speechBuffer = ''
    enqueueTtsChunk(text)
  }

  /* --- vvs: the FIFO audio queue ------------------------------------ */

  /** vvs: enqueueTtsChunk */
  function enqueueTtsChunk(text) {
    pendingChunks.push({
      seq: chunkSequence++,
      text,
      audio: null,
      ready: false,
      enqueuedAt: performance.now(),
    })
    pendingChunks.sort((a, b) => a.seq - b.seq)
    void pumpAudioQueue()
    void warmNextQueuedChunk()
  }

  function dropChunk(chunk) {
    if (chunk.loadTimeout) clearTimeout(chunk.loadTimeout)
    pendingChunks = pendingChunks.filter((item) => item !== chunk)
    if (activeChunk === chunk) activeChunk = null
  }

  /**
   * vvs: prepareNextAudioChunk — reserve a stream id, then point an <audio> at
   * the GET route. Streaming from a URL is what makes playback start on the
   * first bytes instead of after the whole clip downloads.
   */
  async function prepareNextAudioChunk(chunk) {
    ttsRequestInFlight = true

    let response
    try {
      response = await fetch('/api/tts-chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: chunk.text }),
      })
    } catch {
      onDebug('Failed to reach the TTS service.')
      dropChunk(chunk)
      ttsRequestInFlight = false
      void pumpAudioQueue()
      return
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      onDebug(err.error || 'Failed to queue a TTS chunk.')
      dropChunk(chunk)
      ttsRequestInFlight = false
      void pumpAudioQueue()
      return
    }

    const payload = await response.json()
    mark('firstTtsRequest')

    chunk.audio = new Audio(`/api/tts-stream/${encodeURIComponent(payload.stream_id)}`)
    chunk.audio.preload = 'auto'

    const markReady = () => {
      if (chunk.ready) return
      if (chunk.loadTimeout) clearTimeout(chunk.loadTimeout)
      chunk.ready = true
      mark('firstAudioByte')
      void pumpAudioQueue()
      void warmNextQueuedChunk()
    }
    chunk.audio.onloadeddata = markReady
    chunk.audio.oncanplay = markReady

    chunk.audio.onplaying = () => {
      mark('firstAudible')
      void warmNextQueuedChunk()
    }

    chunk.audio.onended = () => {
      dropChunk(chunk)
      void pumpAudioQueue()
      void warmNextQueuedChunk()
    }

    chunk.audio.onerror = () => {
      // ElevenLabs answers 200 with an empty body for a very short tail; skip
      // that chunk rather than stalling the queue.
      dropChunk(chunk)
      void pumpAudioQueue()
      void warmNextQueuedChunk()
    }

    chunk.loadTimeout = setTimeout(() => {
      if (!chunk.ready) {
        onDebug('TTS chunk timed out while loading — skipping.')
        dropChunk(chunk)
        void pumpAudioQueue()
      }
    }, 12_000)

    chunk.audio.load()
    ttsRequestInFlight = false
  }

  /** vvs: warmNextQueuedChunk — fetch the next chunk while this one plays. */
  async function warmNextQueuedChunk() {
    if (ttsRequestInFlight) return
    const waiting = pendingChunks.find((chunk) => chunk !== activeChunk && !chunk.audio)
    if (!waiting) return
    await prepareNextAudioChunk(waiting)
  }

  /** vvs: pumpAudioQueue — play strictly in sequence order. */
  async function pumpAudioQueue() {
    if (activeChunk || ttsRequestInFlight) return

    const next = pendingChunks[0]
    if (!next) return

    if (!next.audio) {
      await prepareNextAudioChunk(next)
      return
    }
    if (!next.ready) return

    activeChunk = next
    onTtsAudio(next.audio)
    next.audio.play().catch(() => {
      onDebug('The browser blocked autoplay. Interact with the page first.')
      dropChunk(next)
      void pumpAudioQueue()
    })
    void warmNextQueuedChunk()
  }

  function abandonAudioQueue() {
    for (const chunk of pendingChunks) {
      chunk.audio?.pause()
      if (chunk.loadTimeout) clearTimeout(chunk.loadTimeout)
    }
    pendingChunks = []
    activeChunk = null
    ttsRequestInFlight = false
  }

  function waitForSpeechToFinish() {
    return new Promise((resolve) => {
      const deadline = performance.now() + 120_000

      const finish = () => {
        abandonAudioQueue()
        resolve()
      }

      const check = () => {
        void pumpAudioQueue()

        if (activeChunk?.audio?.ended) {
          dropChunk(activeChunk)
        }

        const now = performance.now()
        for (const chunk of [...pendingChunks]) {
          if (!chunk.ready && now - chunk.enqueuedAt > 15_000) {
            onDebug('TTS chunk stuck — skipping.')
            dropChunk(chunk)
          }
        }

        if (!pendingChunks.length && !activeChunk && !ttsRequestInFlight) {
          resolve()
          return
        }

        if (activeChunk?.audio && !activeChunk.audio.ended) {
          activeChunk.audio.addEventListener('ended', check, { once: true })
          if (now > deadline) finish()
          else setTimeout(check, 200)
          return
        }

        if (now > deadline) {
          finish()
          return
        }

        setTimeout(check, 120)
      }

      check()
    })
  }

  /* --- recording ---------------------------------------------------- */

  async function start() {
    reset()
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    mediaRecorder = new MediaRecorder(mediaStream)
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

    return process(
      new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' }),
    )
  }

  /** vvs: /api/process — STT, then stream the answer while speaking it. */
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
      onStatus('done')

      void waitForSpeechToFinish().then(() => mark('total'))

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
