const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY
const TTS_MODEL = 'gemini-2.5-flash-preview-tts'
const TTS_VOICE = import.meta.env.VITE_TTS_VOICE || 'Algieba'

let currentAudio = null

function writeString(view, offset, value) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i))
  }
}

function pcmToWav(pcmBytes, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
  const bytesPerSample = bitDepth / 8
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = pcmBytes.length
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  new Uint8Array(buffer, 44).set(pcmBytes)

  return buffer
}

function stopSpeaking() {
  if (!currentAudio) return
  currentAudio.pause()
  currentAudio = null
}

export async function speakText(text, language) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing VITE_GEMINI_API_KEY — add it to your .env file')
  }

  stopSpeaking()

  const languageLabel = language === 'ar' ? 'Arabic' : 'English'

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Read the following ${languageLabel} text aloud in a calm, friendly male voice. Speak exactly as written:\n\n${text}`,
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: TTS_VOICE,
              },
            },
          },
        },
      }),
    },
  )

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error?.message || `Gemini TTS error (${response.status})`)
  }

  const data = await response.json()
  const base64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data

  if (!base64) {
    throw new Error('No audio returned from Gemini TTS')
  }

  const pcmBytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const wavBuffer = pcmToWav(pcmBytes)
  const blob = new Blob([wavBuffer], { type: 'audio/wav' })
  const url = URL.createObjectURL(blob)

  currentAudio = new Audio(url)

  await new Promise((resolve, reject) => {
    currentAudio.onended = () => {
      URL.revokeObjectURL(url)
      currentAudio = null
      resolve()
    }
    currentAudio.onerror = () => {
      URL.revokeObjectURL(url)
      currentAudio = null
      reject(new Error('Failed to play generated audio'))
    }
    currentAudio.play().catch(reject)
  })
}

export { stopSpeaking }
