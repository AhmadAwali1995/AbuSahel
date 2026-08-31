const ASK_API_URL =
  import.meta.env.VITE_ASK_API_URL ||
  '/v1/messages?wait=60&format=json'

export async function askQuestion(text) {
  const response = await fetch(ASK_API_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || err.detail || `Ask API error (${response.status})`)
  }

  const data = await response.json()

  if (data.error) {
    throw new Error(typeof data.error === 'string' ? data.error : 'Ask API returned an error')
  }

  if (!data.answer?.trim()) {
    throw new Error('No answer returned from Ask API')
  }

  return {
    answer: data.answer.trim(),
    language: data.language === 'en' ? 'en' : 'ar',
    question: data.text || text,
    confident: data.confident,
    confidence: data.confidence,
  }
}
