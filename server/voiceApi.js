/**
 * Server-side voice endpoints — OpenAI for speech-to-text, ElevenLabs for
 * text-to-speech. Ported from the `vvs` project's voice_pipeline.py.
 *
 * These run on the server so the API keys never reach the browser. The
 * frontend talks to two routes:
 *
 *   POST /api/stt              — raw audio bytes -> { language, text }
 *   POST /api/ask-stream       — { text }         -> SSE: metadata/delta/final
 *   POST /api/tts-chunk        — { text }         -> { stream_id }
 *   GET  /api/tts-stream/<id>  —                  -> audio/mpeg, streamed
 *
 * Mounted into the Vite dev/preview server by vite.config.js, so `npm run dev`
 * stays a single command.
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const OPENAI_STT_URL = 'https://api.openai.com/v1/audio/transcriptions'

/**
 * Text queued by POST /api/tts-chunk, waiting for GET /api/tts-stream/<id>.
 *
 * This two-step handshake is lifted from vvs and it is the reason first audio
 * arrives fast: an <audio> element can only stream from a GET URL, and
 * streaming lets playback start on the first bytes (~0.85s) instead of after
 * the whole file has downloaded (~4.6s).
 */
const pendingTtsText = new Map()

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * OpenAI returns the transcript but not a reliable language tag for every
 * model, and AbuSahel only ever needs "is this Arabic or English". Counting
 * Arabic-script characters answers that without a second API call.
 */
function detectLanguage(text) {
  const arabic = (text.match(/[؀-ۿ]/g) || []).length
  const latin = (text.match(/[A-Za-z]/g) || []).length
  return arabic >= latin ? 'ar' : 'en'
}

/**
 * Identifies the container from the file's own magic bytes.
 *
 * The browser's Content-Type cannot be trusted: Firefox's MediaRecorder writes
 * an Ogg/Opus file but reports an empty mimeType, so the caller falls back to
 * "audio/webm" and OpenAI — which picks its decoder from the filename — rejects
 * it as corrupt. Chrome really does write WebM. Sniffing handles both.
 */
function sniffAudioFormat(buffer, claimedType) {
  const head = buffer.subarray(0, 12)

  if (head.subarray(0, 4).toString('latin1') === 'OggS') {
    return { extension: 'ogg', mimeType: 'audio/ogg' }
  }
  if (head.readUInt32BE(0) === 0x1a45dfa3) {
    return { extension: 'webm', mimeType: 'audio/webm' }
  }
  if (head.subarray(0, 4).toString('latin1') === 'RIFF') {
    return { extension: 'wav', mimeType: 'audio/wav' }
  }
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
    return { extension: 'mp4', mimeType: 'audio/mp4' }
  }
  if (
    head.subarray(0, 3).toString('latin1') === 'ID3' ||
    (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
  ) {
    return { extension: 'mp3', mimeType: 'audio/mpeg' }
  }

  // Unrecognised — fall back to whatever the browser claimed.
  const mimeType = (claimedType || 'audio/webm').split(';')[0].trim()
  const known = { 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3' }
  return { extension: known[mimeType] || 'webm', mimeType }
}

async function handleStt(req, res, env) {
  const apiKey = env.OPENAI_API_KEY
  if (!apiKey) {
    return sendJson(res, 500, { error: 'OPENAI_API_KEY is not set in .env' })
  }

  const audio = await readBody(req)
  if (!audio.length) {
    return sendJson(res, 400, { error: 'No audio received' })
  }

  const rawType = req.headers['content-type'] || ''
  const { extension, mimeType } = sniffAudioFormat(audio, rawType)

  console.log(`[stt] ${audio.length} bytes, claimed "${rawType}" -> recording.${extension}`)

  const form = new FormData()
  form.append('file', new Blob([audio], { type: mimeType }), `recording.${extension}`)
  form.append('model', env.OPENAI_STT_MODEL || 'gpt-transcribe')
  form.append('response_format', 'json')

  const response = await fetch(OPENAI_STT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!response.ok) {
    const detail = await response.text()
    const dump = `${tmpdir()}/abusahel-stt-debug.${extension}`
    writeFileSync(dump, audio)
    console.error(
      `[stt] rejected. first bytes: ${audio.subarray(0, 8).toString('hex')} ` +
        `("${audio.subarray(0, 4).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}") ` +
        `saved to ${dump}`,
    )
    console.error(`[stt] OpenAI ${response.status}: ${detail.slice(0, 500)}`)
    return sendJson(res, response.status, {
      error: `OpenAI STT failed (${response.status}): ${detail.slice(0, 300)}`,
    })
  }

  const data = await response.json()
  const text = (data.text || '').trim()
  if (!text) {
    console.error('[stt] empty transcript from OpenAI')
    return sendJson(res, 502, {
      error: 'OpenAI heard no speech. Check the microphone input level.',
    })
  }

  console.log(`[stt] "${text}"`)

  return sendJson(res, 200, { text, language: detectLanguage(text) })
}


/**
 * Proxies the RAG endpoint's Server-Sent Events straight through to the
 * browser, unchanged. Kept server-side so RAG_API_URL (and its optional bearer
 * token) stay in .env, and so the browser never makes a cross-origin request.
 *
 * Mirrors vvs: POST { "text": "...", "stream": true } -> event: metadata /
 * delta / final.
 */
async function handleAskStream(req, res, env) {
  const ragUrl = env.RAG_API_URL
  if (!ragUrl) {
    return sendJson(res, 500, { error: 'RAG_API_URL is not set in .env' })
  }

  const raw = await readBody(req)
  let question
  try {
    question = String(JSON.parse(raw.toString('utf8')).text || '').trim()
  } catch {
    return sendJson(res, 400, { error: 'Body must be JSON: { "text": "..." }' })
  }
  if (!question) {
    return sendJson(res, 400, { error: 'Text is required' })
  }

  const payload = { text: question, stream: true }
  if (env.RAG_API_EXTRA_JSON) {
    Object.assign(payload, JSON.parse(env.RAG_API_EXTRA_JSON))
    payload.stream = true
  }

  const headers = { 'Content-Type': 'application/json', accept: 'text/event-stream' }
  if (env.RAG_API_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${env.RAG_API_BEARER_TOKEN}`
  }

  const upstream = await fetch(ragUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Number(env.RAG_API_TIMEOUT_SECONDS || 60) * 1000),
  })

  if (!upstream.ok) {
    const detail = await upstream.text()
    console.error(`[rag] ${upstream.status}: ${detail.slice(0, 300)}`)
    return sendJson(res, upstream.status, {
      error: `RAG API failed (${upstream.status}): ${detail.slice(0, 300)}`,
    })
  }

  // If the endpoint answered with plain JSON instead of a stream (the Railway
  // deployment does this), synthesise the SSE frames the client expects.
  const contentType = upstream.headers.get('content-type') || ''
  if (!contentType.includes('event-stream')) {
    const data = await upstream.json().catch(() => ({}))
    const answer = String(data.answer || data.text || '').trim()
    console.log(`[rag] non-streaming response, ${answer.length} chars`)
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.write(sse('metadata', { source: 'non-streaming' }))
    if (answer) res.write(sse('delta', { text: answer }))
    res.write(sse('final', data))
    return res.end()
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  })

  const reader = upstream.body.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    res.write(Buffer.from(value))
  }
  res.end()
}

function sse(event, data) {
  return `event: ${event}
data: ${JSON.stringify(data)}

`
}

/**
 * Streams audio straight through from ElevenLabs to the browser, so playback
 * can start before synthesis finishes. Retries on 409/429 the way vvs did —
 * ElevenLabs rejects concurrent requests on some plans.
 */
/** POST /api/tts-chunk -> { stream_id } for the browser to open as audio. */
async function handleTtsChunk(req, res, env) {
  if (!env.ELEVENLABS_API_KEY) {
    return sendJson(res, 500, { error: 'ELEVENLABS_API_KEY is not set in .env' })
  }

  const raw = await readBody(req)
  let text
  try {
    text = String(JSON.parse(raw.toString('utf8')).text || '').trim()
  } catch {
    return sendJson(res, 400, { error: 'Body must be JSON: { "text": "..." }' })
  }
  if (!text) {
    return sendJson(res, 400, { error: 'Text is required' })
  }

  const streamId = randomUUID()
  pendingTtsText.set(streamId, text)

  // Guard against ids that are never collected (the tab closed mid-turn).
  setTimeout(() => pendingTtsText.delete(streamId), 5 * 60 * 1000).unref?.()

  return sendJson(res, 200, { stream_id: streamId })
}

/** GET /api/tts-stream/<id> -> audio/mpeg, streamed as ElevenLabs produces it. */
async function handleTtsStream(req, res, env, streamId) {
  const text = pendingTtsText.get(streamId)
  pendingTtsText.delete(streamId)
  if (!text) {
    return sendJson(res, 404, { error: 'TTS stream not found or expired.' })
  }

  const apiKey = env.ELEVENLABS_API_KEY

  const voiceId = env.ELEVENLABS_TTS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'
  const outputFormat = env.ELEVENLABS_TTS_OUTPUT_FORMAT || 'mp3_44100_128'
  const maxRetries = Number(env.ELEVENLABS_TTS_MAX_RETRIES || 4)
  const retryDelay = Number(env.ELEVENLABS_TTS_RETRY_DELAY_SECONDS || 0.5) * 1000

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream` +
    `?output_format=${encodeURIComponent(outputFormat)}`

  const payload = {
    text,
    model_id: env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2',
    voice_settings: {
      stability: 0.35,
      similarity_boost: 0.85,
      style: 0.35,
      use_speaker_boost: true,
      speed: Number(env.ELEVENLABS_TTS_SPEED || 0.92),
    },
  }

  let response = null
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(
        Number(env.ELEVENLABS_TTS_TIMEOUT_SECONDS || 60) * 1000,
      ),
    })
    if (response.status !== 409 && response.status !== 429) break
    if (attempt === maxRetries) break
    await new Promise((resolve) => setTimeout(resolve, retryDelay * (attempt + 1)))
  }

  if (!response.ok) {
    const detail = await response.text()
    return sendJson(res, response.status, {
      error: `ElevenLabs TTS failed (${response.status}): ${detail.slice(0, 300)}`,
    })
  }

  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  })

  const reader = response.body.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    res.write(Buffer.from(value))
  }
  res.end()
}

/** Connect-style middleware. `env` is the parsed .env (all keys, unprefixed). */
export function voiceApiMiddleware(env) {
  return async (req, res, next) => {
    const route = (req.url || '').split('?')[0]

    try {
      if (req.method === 'GET' && route.startsWith('/api/tts-stream/')) {
        await handleTtsStream(req, res, env, route.slice('/api/tts-stream/'.length))
        return
      }

      const handlers = {
        '/api/stt': handleStt,
        '/api/tts-chunk': handleTtsChunk,
        '/api/ask-stream': handleAskStream,
      }
      if (req.method !== 'POST' || !handlers[route]) {
        return next()
      }

      await handlers[route](req, res, env)
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error.message })
      } else {
        res.end()
      }
    }
  }
}
