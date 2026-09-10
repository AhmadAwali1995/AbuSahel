import * as THREE from 'three'

export const POSES = ['REST', 'CLOSED', 'SMALL_OPEN', 'WIDE_OPEN', 'ROUND']

const W = 1024
const H = 1134

function canvas(w = W, h = H) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

async function load(url) {
  const i = new Image()
  i.src = url
  await i.decode()
  return i
}

function colorize(c, mode, material) {
  const ctx = c.getContext('2d')
  const im = ctx.getImageData(0, 0, W, H)
  const d = im.data
  const labels = new Int32Array(W * H).fill(-1)
  const q = new Int32Array(W * H)
  const regions = []

  for (let seed = 0; seed < W * H; seed++) {
    if (labels[seed] >= 0 || d[seed * 4] < 145) continue
    const id = regions.length
    let head = 0
    let tail = 0
    q[tail++] = seed
    labels[seed] = id
    const region = []
    while (head < tail) {
      const p = q[head++]
      region.push(p)
      for (const n of [p % W ? p - 1 : -1, p % W < W - 1 ? p + 1 : -1, p - W, p + W]) {
        if (n >= 0 && n < W * H && labels[n] < 0 && d[n * 4] >= 145) {
          labels[n] = id
          q[tail++] = n
        }
      }
    }
    regions.push(region)
  }

  const exterior = new Set()
  for (let x = 0; x < W; x++) exterior.add(labels[x])
  for (let y = 0; y < H; y++) {
    exterior.add(labels[y * W])
    exterior.add(labels[y * W + W - 1])
  }
  exterior.delete(-1)

  const idAt = (x, y) => labels[y * W + x]
  const skinSeeds = [
    [480, 310],
    [487, 399],
    [487, 596],
    [310, 404],
    [654, 405],
    ...(mode === 'angry' ? [[331, 907], [675, 917]] : mode === 'thinking' ? [[348, 493], [355, 597]] : []),
  ]
  const skin = new Set(skinSeeds.map(([x, y]) => idAt(x, y)))
  skin.delete(-1)

  regions.forEach((pixels, id) => {
    if (!pixels.length || pixels.length > 2500) return
    let x0 = W
    let x1 = 0
    let y0 = H
    let y1 = 0
    for (const p of pixels) {
      const x = p % W
      const y = Math.floor(p / W)
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
    if (y0 >= 329 && y1 <= 437 && ((x0 >= 294 && x1 <= 350) || (x0 >= 625 && x1 <= 685))) {
      skin.add(id)
    }
  })
  for (const id of exterior) skin.delete(id)

  const white = new Set(
    (mode === 'neutral' ? [[423, 361], [574, 361], [485, 485]] : []).map(([x, y]) => idAt(x, y)),
  )
  white.delete(-1)

  const tex = canvas(64, 64)
  const tc = tex.getContext('2d')
  tc.drawImage(material, 390, 690, 48, 48, 0, 0, 64, 64)
  const td = tc.getImageData(0, 0, 64, 64).data

  for (let p = 0; p < W * H; p++) {
    const j = p * 4
    const x = p % W
    const y = Math.floor(p / W)
    const label = labels[p]
    if (exterior.has(label)) {
      d[j + 3] = 0
      continue
    }
    let isSkin = skin.has(label)
    let isWhite = white.has(label)
    if (label < 0) {
      for (const n of [p - 2, p + 2, p - 2 * W, p + 2 * W]) {
        if (n >= 0 && n < W * H && skin.has(labels[n])) isSkin = true
      }
    }
    const ink = Math.max(0, Math.min(1, (245 - Math.min(d[j], d[j + 1], d[j + 2])) / 210))
    const fabric = (td[((y % 64) * 64 + (x % 64)) * 4] - 245) * 0.13
    const shade = isSkin ? 1 - Math.pow((x - 486) / 650, 2) * 0.055 : 1
    const color = isWhite
      ? [255, 252, 240]
      : isSkin
        ? [224 * shade, 171 * shade, 119 * shade]
        : [246 + fabric, 239 + fabric, 221 + fabric]
    for (let k = 0; k < 3; k++) {
      d[j + k] = ink > 0.96 ? d[j + k] : Math.round([33, 34, 91][k] * ink + color[k] * (1 - ink))
    }
  }

  for (let p = W; p < W * (H - 1); p++) {
    const j = p * 4
    if (!d[j + 3] || p % W < 1 || p % W >= W - 1) continue
    if (!d[(p - 1) * 4 + 3] || !d[(p + 1) * 4 + 3] || !d[(p - W) * 4 + 3] || !d[(p + W) * 4 + 3]) {
      const a = Math.max(0.1, Math.min(1, (245 - Math.min(im.data[j], im.data[j + 1], im.data[j + 2])) / 210))
      d[j + 3] = Math.round(255 * a)
      d[j] = 33
      d[j + 1] = 34
      d[j + 2] = 91
    }
  }
  ctx.putImageData(im, 0, 0)
  return c
}

function inkBounds(c, r) {
  const w = c.width
  const d = c.getContext('2d').getImageData(0, 0, w, c.height).data
  let x0 = w
  let y0 = c.height
  let x1 = 0
  let y1 = 0
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const j = (y * w + x) * 4
      if (d[j + 3] > 100 && d[j] < 100 && d[j + 1] < 110) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
    }
  }
  if (x1 < x0) throw Error('Could not locate facial artwork')
  return { x: x0 - 3, y: y0 - 3, w: x1 - x0 + 7, h: y1 - y0 + 7 }
}

function copy(c) {
  const n = canvas()
  n.getContext('2d').drawImage(c, 0, 0)
  return n
}

function erase(ctx, r) {
  const im = ctx.getImageData(r.x - 4, r.y - 4, r.w + 8, r.h + 8)
  const d = im.data
  const ww = im.width
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const j = ((y + 4) * ww + x + 4) * 4
      const l = (y + 4) * ww * 4
      const rr = ((y + 4) * ww + ww - 1) * 4
      const t = x / (r.w - 1)
      for (let k = 0; k < 3; k++) d[j + k] = d[l + k] * (1 - t) + d[rr + k] * t
    }
  }
  ctx.putImageData(im, r.x - 4, r.y - 4)
}

function cleanAngryMouth(ctx) {
  const im = ctx.getImageData(0, 0, W, H)
  const d = im.data
  const seen = new Uint8Array(W * H)
  const mask = new Uint8Array(W * H)
  for (let sy = 469; sy < 511; sy++) {
    for (let sx = 427; sx < 558; sx++) {
      const seed = sy * W + sx
      if (seen[seed] || d[seed * 4] >= 125) continue
      const queue = [seed]
      seen[seed] = 1
      let x0 = W
      let x1 = 0
      let y0 = H
      let y1 = 0
      for (let h = 0; h < queue.length; h++) {
        const p = queue[h]
        const x = p % W
        const y = Math.floor(p / W)
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
        for (const next of [x ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
          if (next >= 0 && next < W * H && !seen[next] && d[next * 4] < 125) {
            seen[next] = 1
            queue.push(next)
          }
        }
      }
      if (x0 < 427 || x1 > 558 || y0 < 469 || y1 > 511) continue
      for (const p of queue) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) mask[p + dy * W + dx] = 1
        }
      }
    }
  }
  const left = ctx.getImageData(420, 490, 1, 1).data
  const right = ctx.getImageData(565, 490, 1, 1).data
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue
    const t = Math.max(0, Math.min(1, ((p % W) - 420) / 145))
    for (let k = 0; k < 3; k++) d[p * 4 + k] = Math.round(left[k] * (1 - t) + right[k] * t)
  }
  ctx.putImageData(im, 0, 0)
}

function texture(c) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

export async function prepareArtwork() {
  const [ni, ai, ti, material] = await Promise.all([
    load('/art/neutral.jpg'),
    load('/art/angry.jpg'),
    load('/art/thinking.jpg'),
    load('/art/colored-sheet.png'),
  ])

  const n = canvas()
  const a = canvas()
  const thinking = canvas()
  thinking.getContext('2d').drawImage(ti, 0, 0, W, H)
  const tctx = thinking.getContext('2d')
  tctx.fillStyle = '#f6f6f6'
  tctx.fillRect(700, 0, 324, 315)
  colorize(thinking, 'thinking', material)
  n.getContext('2d').drawImage(ni, 0, 0, W, H)
  a.getContext('2d').drawImage(ai, 0, 0, W, H)

  const headN = inkBounds(n, { x: 280, y: 65, w: 410, h: 150 })
  const headA = inkBounds(a, { x: 280, y: 65, w: 410, h: 150 })
  const dx = headN.x + headN.w / 2 - headA.x - headA.w / 2
  const dy = headN.y - headA.y

  if (dx || dy) {
    const aligned = copy(a)
    const ctx = a.getContext('2d')
    ctx.fillStyle = '#f6f6f6'
    ctx.fillRect(0, 0, W, H)
    ctx.drawImage(aligned, dx, dy)
  }
  colorize(n, 'neutral', material)
  colorize(a, 'angry', material)

  const angryMouth = { x: 445, y: 472, w: 95, h: 25 }
  const mouth = inkBounds(n, { x: 426, y: 472, w: 123, h: 33 })
  const eyes = [
    inkBounds(n, { x: 388, y: 343, w: 54, h: 51 }),
    inkBounds(n, { x: 538, y: 343, w: 53, h: 51 }),
  ]
  const angryEyes = [
    inkBounds(a, { x: 385, y: 345, w: 73, h: 28 }),
    inkBounds(a, { x: 532, y: 342, w: 64, h: 30 }),
  ]

  const make = (base, pose, blink) => {
    const out = copy(base)
    const ctx = out.getContext('2d')
    if ((base === n || base === a) && pose !== 0) {
      if (base === a) cleanAngryMouth(ctx)
      else erase(ctx, mouth)
      if (pose !== -1) {
        const cx = mouth.x + mouth.w / 2
        const cy = mouth.y + mouth.h * 0.47
        ctx.strokeStyle = '#24245e'
        ctx.fillStyle = '#24245e'
        ctx.lineWidth = 5
        ctx.lineCap = 'round'
        ctx.beginPath()
        if (pose === 1) {
          ctx.moveTo(cx - mouth.w * 0.39, cy)
          ctx.quadraticCurveTo(cx, cy + 5, cx + mouth.w * 0.39, cy)
          ctx.stroke()
        } else {
          const rx = pose === 4 ? mouth.w * 0.23 : mouth.w * (pose === 3 ? 0.44 : 0.34)
          const ry = pose === 4 ? 17 : pose === 3 ? 20 : 10
          ctx.ellipse(cx, cy + 3, rx, ry, 0, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = '#fff9eb'
          ctx.beginPath()
          ctx.ellipse(cx, cy - ry * 0.32, rx * 0.73, 3, 0, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
    if (blink) {
      for (const r of base === n ? eyes : angryEyes) {
        erase(ctx, r)
        ctx.strokeStyle = '#24245e'
        ctx.lineWidth = 4
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(r.x + 5, r.y + r.h * 0.6)
        ctx.quadraticCurveTo(r.x + r.w / 2, r.y + r.h * 0.78, r.x + r.w - 5, r.y + r.h * 0.6)
        ctx.stroke()
      }
    }
    return texture(out)
  }

  return {
    neutral: POSES.map((_, i) => [make(n, i, false), make(n, i, true)]),
    angry: [make(a, 0, false), make(a, 0, true)],
    thinking: [make(thinking, 0, false), make(thinking, 0, true)],
    clean: [make(n, -1, false), make(n, -1, true)],
    angryClean: [make(a, -1, false), make(a, -1, true)],
    mouth,
    angryMouth,
    registration: {
      neutral: headN,
      angry: headA,
      translation: { x: dx, y: dy },
      scale: 1,
    },
    dimensions: { width: W, height: H },
  }
}
