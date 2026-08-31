const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY
const GEMINI_MODEL = 'gemini-3.6-flash'

const TRANSCRIBE_PROMPT = `Transcribe this audio.
Return JSON only, no markdown:
{"language":"ar"|"en","text":"..."}
Use "ar" if the speech is Arabic, "en" if English.`

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function parseTranscriptResponse(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const parsed = JSON.parse(cleaned)

  if (parsed.language !== 'ar' && parsed.language !== 'en') {
    throw new Error('Invalid language in transcription response')
  }

  if (!parsed.text?.trim()) {
    throw new Error('No transcription text returned from Gemini')
  }

  return {
    language: parsed.language,
    text: parsed.text.trim(),
  }
}

export async function transcribeAudio(blob) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing VITE_GEMINI_API_KEY — add it to your .env file')
  }

  const base64 = await blobToBase64(blob)
  const mimeType = blob.type || 'audio/webm'

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: TRANSCRIBE_PROMPT,
              },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64,
                },
              },
            ],
          },
        ],
      }),
    },
  )

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error?.message || `Gemini API error (${response.status})`)
  }

  const data = await response.json()
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text

  if (!raw) {
    throw new Error('No transcription returned from Gemini')
  }

  try {
    return parseTranscriptResponse(raw)
  } catch {
    throw new Error('Could not parse transcription response from Gemini')
  }
}
