import { CharacterEngine } from './character/engine.js'

/**
 * Drop-in replacement for the old GLB avatar facade.
 * Same surface used by main.js: speak(audio), stopSpeaking(), dispose().
 */
export async function createAvatar(container) {
  const engine = new CharacterEngine(container)
  await engine.init()

  return {
    engine,

    async speak(audio) {
      await engine.speakFromElement(audio)
    },

    stopSpeaking() {
      if (engine.element) {
        try {
          engine.element.pause()
        } catch {
          /* ignore */
        }
      }
      engine.idle()
    },

    thinking() {
      engine.thinking()
    },

    idle() {
      engine.idle()
    },

    dispose() {
      engine.dispose()
    },
  }
}
