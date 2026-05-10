import './style.css'
import { PS1Viewer } from './viewer'
import type { PS1Settings } from './viewer'

// ── DOM refs ────────────────────────────────────────────────────────────────
const canvas    = document.getElementById('canvas') as HTMLCanvasElement
const dropZone  = document.getElementById('dropZone') as HTMLDivElement
const fileInput = document.getElementById('fileInput') as HTMLInputElement

// Geometry
const sliderPolygon    = document.getElementById('polygonReduction') as HTMLInputElement
const checkWelding     = document.getElementById('vertexWelding') as HTMLInputElement
// Texture Mapping
const sliderTexture    = document.getElementById('textureResolution') as HTMLInputElement
const sliderColor      = document.getElementById('colorDepth') as HTMLInputElement
const checkAffine      = document.getElementById('affineMapping') as HTMLInputElement
// Hardware Quirks
const sliderSnapping   = document.getElementById('vertexSnapping') as HTMLInputElement
const checkFlat        = document.getElementById('flatShading') as HTMLInputElement
const checkDithering   = document.getElementById('dithering') as HTMLInputElement
const checkFog         = document.getElementById('fog') as HTMLInputElement
const fogControls      = document.getElementById('fogControls') as HTMLDivElement
const sliderFogNear    = document.getElementById('fogNear') as HTMLInputElement
const sliderFogFar     = document.getElementById('fogFar') as HTMLInputElement
// Render
const sliderRender     = document.getElementById('renderResolution') as HTMLInputElement

// Value displays
const valPolygon  = document.getElementById('polygonReductionValue')!
const valTexture  = document.getElementById('textureResolutionValue')!
const valColor    = document.getElementById('colorDepthValue')!
const valSnapping = document.getElementById('vertexSnappingValue')!
const valFogNear  = document.getElementById('fogNearValue')!
const valFogFar   = document.getElementById('fogFarValue')!
const valRender   = document.getElementById('renderResolutionValue')!

// ── Labels ───────────────────────────────────────────────────────────────────
const TEXTURE_LABELS = ['full', '256px', '128px', '64px', '32px', '16px', '8px']
const RENDER_LABELS  = ['0.25x (320p)', '0.33x', '0.50x', '0.75x', '1.00x']
const snapLabel      = (v: number) => v === 1 ? 'off' : `÷${v}`

// ── Initial settings ─────────────────────────────────────────────────────────
const initialSettings: PS1Settings = {
  polygonReduction:  0,
  vertexWelding:     false,
  vertexSnapping:    1,
  dithering:         false,
  fog:               false,
  fogNear:           2,
  fogFar:            8,
  textureResolution: 0,
  colorDepth:        256,
  affineMapping:     true,
  renderResolution:  1,
  flatShading:       true,
}

// ── Viewer ───────────────────────────────────────────────────────────────────
const viewer = new PS1Viewer(canvas, initialSettings)

// Sync initial display values
valPolygon.textContent  = `${initialSettings.polygonReduction}%`
valTexture.textContent  = TEXTURE_LABELS[initialSettings.textureResolution]
valColor.textContent    = `${initialSettings.colorDepth}`
valSnapping.textContent = snapLabel(initialSettings.vertexSnapping)
valFogNear.textContent  = `${initialSettings.fogNear}`
valFogFar.textContent   = `${initialSettings.fogFar}`
valRender.textContent   = RENDER_LABELS[initialSettings.renderResolution - 1]

// ── Control events ────────────────────────────────────────────────────────────

// Geometry
sliderPolygon.addEventListener('input', () => {
  const v = Number(sliderPolygon.value)
  valPolygon.textContent = `${v}%`
  viewer.updateSettings({ polygonReduction: v })
})

checkWelding.addEventListener('change', () => {
  viewer.updateSettings({ vertexWelding: checkWelding.checked })
})

// Texture Mapping
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

checkAffine.addEventListener('change', () => {
  viewer.updateSettings({ affineMapping: checkAffine.checked })
})

// Hardware Quirks
sliderSnapping.addEventListener('input', () => {
  const v = Number(sliderSnapping.value)
  valSnapping.textContent = snapLabel(v)
  viewer.updateSettings({ vertexSnapping: v })
})

checkFlat.addEventListener('change', () => {
  viewer.updateSettings({ flatShading: checkFlat.checked })
})

checkDithering.addEventListener('change', () => {
  viewer.updateSettings({ dithering: checkDithering.checked })
})

checkFog.addEventListener('change', () => {
  fogControls.classList.toggle('hidden', !checkFog.checked)
  viewer.updateSettings({ fog: checkFog.checked })
})

sliderFogNear.addEventListener('input', () => {
  const v = Number(sliderFogNear.value)
  valFogNear.textContent = `${v}`
  viewer.updateSettings({ fogNear: v })
})

sliderFogFar.addEventListener('input', () => {
  const v = Number(sliderFogFar.value)
  valFogFar.textContent = `${v}`
  viewer.updateSettings({ fogFar: v })
})

// Render
sliderRender.addEventListener('input', () => {
  const v = Number(sliderRender.value)
  valRender.textContent = RENDER_LABELS[v - 1]
  viewer.updateSettings({ renderResolution: v })
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

dropZone.addEventListener('dragover', e => {
  e.preventDefault()
  dropZone.classList.add('drag-over')
})
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
dropZone.addEventListener('drop', e => {
  e.preventDefault()
  dropZone.classList.remove('drag-over')
  const file = e.dataTransfer?.files[0]
  if (file) loadFile(file)
})

canvas.addEventListener('dragover', e => e.preventDefault())
canvas.addEventListener('drop', e => {
  e.preventDefault()
  const file = e.dataTransfer?.files[0]
  if (file) loadFile(file)
})

// ── Resize ────────────────────────────────────────────────────────────────────
new ResizeObserver(() => {
  viewer.resize(canvas.clientWidth, canvas.clientHeight)
}).observe(canvas)
