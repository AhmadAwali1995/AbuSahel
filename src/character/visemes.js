export const VISEME_NAMES = ['REST', 'CLOSED', 'SMALL_OPEN', 'WIDE_OPEN', 'ROUND', 'PUCKER']

export const VISEME_SHAPES = {
  REST: { width: 38, height: 2, round: 0, pucker: 0 },
  CLOSED: { width: 35, height: 1.4, round: 0, pucker: 0 },
  SMALL_OPEN: { width: 32, height: 10, round: 0.12, pucker: 0 },
  WIDE_OPEN: { width: 46, height: 19, round: 0, pucker: 0 },
  ROUND: { width: 20, height: 21, round: 1, pucker: 0 },
  PUCKER: { width: 12.5, height: 11, round: 1, pucker: 1 },
}

/** Lightweight audio-driven approximations, not speech recognition. */
export function selectViseme(energy, low, mid, high, playing) {
  if (!playing) return 'REST'
  if (energy < 0.045) return 'CLOSED'
  if (energy > 0.62) return 'WIDE_OPEN'
  const total = low + mid + high
  const bass = total > 0 ? low / total : 0
  if (bass > 0.68 && energy < 0.36) return 'PUCKER'
  if (bass > 0.48) return 'ROUND'
  if (high > mid * 0.85 && energy > 0.16) return 'WIDE_OPEN'
  return 'SMALL_OPEN'
}

export function approach(current, target, dt, tau) {
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dt) / tau))
}
