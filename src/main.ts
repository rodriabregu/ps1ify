import './style.css'
import { PS1Viewer } from './viewer'
import type { PS1Settings } from './viewer'

// ── DOM refs ────────────────────────────────────────────────────────────────
const canvas    = document.getElementById('canvas') as HTMLCanvasElement
const dropZone  = document.getElementById('dropZone') as HTMLDivElement
const fileInput = document.getElementById('fileInput') as HTMLInputElement

const sliderPolygon   = document.getElementById('polygonReduction') as HTMLInputElement
const sliderSnapping  = document.getElementById('vertexSnapping') as HTMLInputElement
const sliderTexture   = document.getElementById('textureResolution') as HTMLInputElement
const sliderColor     = document.getElementById('colorDepth') as HTMLInputElement
const sliderRender    = document.getElementById('renderResolution') as HTMLInputElement
const checkFlat       = document.getElementById('flatShading') as HTMLInputElement
const checkAffine     = document.getElementById('affineMapping') as HTMLInputElement

const valPolygon  = document.getElementById('polygonReductionValue')!
const valSnapping = document.getElementById('vertexSnappingValue')!
const valTexture  = document.getElementById('textureResolutionValue')!
const valColor    = document.getElementById('colorDepthValue')!
const valRender   = document.getElementById('renderResolutionValue')!

// ── Initial settings ─────────────────────────────────────────────────────────
// Index 0 = full res (no downscale), then progressively smaller
const TEXTURE_LABELS = ['full', '256px', '128px', '64px', '32px', '16px', '8px']
const RENDER_LABELS  = ['0.25x (320p)', '0.33x', '0.50x', '0.75x', '1.00x']

// vertexSnapping is a divisor: 1 = off, 16 = maximum wobble
const snapLabel = (v: number) => v === 1 ? 'off' : `÷${v}`

const initialSettings: PS1Settings = {
  polygonReduction:  0,
  vertexSnapping:    1,
  textureResolution: 0,   // 0 = full res (no downscale)
  colorDepth:        256, // max = no posterization by default
  renderResolution:  1,
  flatShading:       true,
  affineMapping:     true,
}

// ── Viewer ────────────────────────────────────────────────────────────────────
const viewer = new PS1Viewer(canvas, initialSettings)

// Sync initial display values
valPolygon.textContent  = `${initialSettings.polygonReduction}%`
valSnapping.textContent = snapLabel(initialSettings.vertexSnapping)
valTexture.textContent  = TEXTURE_LABELS[initialSettings.textureResolution] // 'full'
valColor.textContent    = `${initialSettings.colorDepth}`
valRender.textContent   = RENDER_LABELS[initialSettings.renderResolution - 1]

// ── Control events ────────────────────────────────────────────────────────────

sliderPolygon.addEventListener('input', () => {
  const v = Number(sliderPolygon.value)
  valPolygon.textContent = `${v}%`
  viewer.updateSettings({ polygonReduction: v })
})

sliderSnapping.addEventListener('input', () => {
  const v = Number(sliderSnapping.value)
  valSnapping.textContent = snapLabel(v)
  viewer.updateSettings({ vertexSnapping: v })
})

sliderTexture.addEventListener('input', () => {
  const v = Number(sliderTexture.value)
  valTexture.textContent = TEXTURE_LABELS[v]
  viewer.updateSettings({ textureResolution: v })
})

sliderColor.addEventListener('input', () => {
  const v = Number(sliderColor.value)
  valColor.textContent = `${v}`
  viewer.updateSettings({ colorDepth: v })
})

sliderRender.addEventListener('input', () => {
  const v = Number(sliderRender.value)
  valRender.textContent = RENDER_LABELS[v - 1]
  viewer.updateSettings({ renderResolution: v })
})

checkFlat.addEventListener('change', () => {
  viewer.updateSettings({ flatShading: checkFlat.checked })
})

checkAffine.addEventListener('change', () => {
  viewer.updateSettings({ affineMapping: checkAffine.checked })
})

// ── File loading ──────────────────────────────────────────────────────────────

async function loadFile(file: File) {
  const allowed = ['glb', 'gltf', 'obj']
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!allowed.includes(ext)) {
    alert(`Unsupported format: .${ext}\nPlease use GLB, GLTF or OBJ.`)
    return
  }

  dropZone.classList.add('hidden')
  await viewer.loadFile(file)
}

fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) loadFile(fileInput.files[0])
})

// Drag & drop
dropZone.addEventListener('dragover', e => {
  e.preventDefault()
  dropZone.classList.add('drag-over')
})

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over')
})

dropZone.addEventListener('drop', e => {
  e.preventDefault()
  dropZone.classList.remove('drag-over')
  const file = e.dataTransfer?.files[0]
  if (file) loadFile(file)
})

// Allow dropping anywhere on the viewer panel when model is loaded
canvas.addEventListener('dragover', e => e.preventDefault())
canvas.addEventListener('drop', e => {
  e.preventDefault()
  const file = e.dataTransfer?.files[0]
  if (file) loadFile(file)
})

// ── Resize ────────────────────────────────────────────────────────────────────
const resizeObserver = new ResizeObserver(() => {
  viewer.resize(canvas.clientWidth, canvas.clientHeight)
})
resizeObserver.observe(canvas)
