let currentAudio = null

export function stopTts() {
  if (!currentAudio) return
  currentAudio.pause()
  currentAudio.removeAttribute('src')
  currentAudio = null
}

/** POST /api/tts-chunk then stream from GET /api/tts-stream/<id>. */
export async function playTts(text, { onAudio } = {}) {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Text is required')

  stopTts()

  const response = await fetch('/api/tts-chunk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: trimmed }),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `TTS failed (${response.status})`)
  }

  const { stream_id: streamId } = await response.json()
  const audio = new Audio(`/api/tts-stream/${encodeURIComponent(streamId)}`)
  currentAudio = audio
  onAudio?.(audio)

  await new Promise((resolve, reject) => {
    const finish = (error) => {
      if (currentAudio === audio) currentAudio = null
      if (error) reject(error)
      else resolve()
    }

    audio.onended = () => finish()
    audio.onerror = () => finish(new Error('Failed to play audio'))
    audio.play().catch((error) => finish(error))
  })
}
