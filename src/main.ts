import './style.css'
import { PS1Viewer } from './viewer'
import type { PS1Settings } from './viewer'

// ── DOM refs ─────────────────────────────────────────────────────────────────

const canvas         = document.getElementById('canvas') as HTMLCanvasElement
const dropZone       = document.getElementById('dropZone') as HTMLDivElement
const fileInput      = document.getElementById('fileInput') as HTMLInputElement
const loadingOverlay = document.getElementById('loadingOverlay') as HTMLDivElement
const loadingMsg     = document.getElementById('loadingMsg') as HTMLParagraphElement
const btnReset       = document.getElementById('resetSettings') as HTMLButtonElement

// Geometry
const sliderPolygon  = document.getElementById('polygonReduction') as HTMLInputElement
const checkWelding   = document.getElementById('vertexWelding') as HTMLInputElement
// Texture Mapping
const sliderTexture  = document.getElementById('textureResolution') as HTMLInputElement
const sliderColor    = document.getElementById('colorDepth') as HTMLInputElement
const checkAffine    = document.getElementById('affineMapping') as HTMLInputElement
// Hardware Quirks
const sliderSnapping = document.getElementById('vertexSnapping') as HTMLInputElement
const checkFlat      = document.getElementById('flatShading') as HTMLInputElement
const checkDithering = document.getElementById('dithering') as HTMLInputElement
const checkFog       = document.getElementById('fog') as HTMLInputElement
const fogControls    = document.getElementById('fogControls') as HTMLDivElement
const sliderFogNear  = document.getElementById('fogNear') as HTMLInputElement
const sliderFogFar   = document.getElementById('fogFar') as HTMLInputElement
// Lighting
const sliderAmbientIntensity = document.getElementById('ambientIntensity') as HTMLInputElement
const inputAmbientColor      = document.getElementById('ambientColor') as HTMLInputElement
const sliderDirIntensity     = document.getElementById('dirIntensity') as HTMLInputElement
const inputDirColor          = document.getElementById('dirColor') as HTMLInputElement
const sliderFillIntensity    = document.getElementById('fillIntensity') as HTMLInputElement
const inputFillColor         = document.getElementById('fillColor') as HTMLInputElement
// Render
const sliderRender   = document.getElementById('renderResolution') as HTMLInputElement
const checkAutoRotate = document.getElementById('autoRotate') as HTMLInputElement
const checkWireframe  = document.getElementById('wireframe') as HTMLInputElement
// Export
const btnExportGLB = document.getElementById('exportGLB') as HTMLButtonElement
const btnExportOBJ = document.getElementById('exportOBJ') as HTMLButtonElement
const btnExportPNG = document.getElementById('exportPNG') as HTMLButtonElement

// Value displays
const valPolygon          = document.getElementById('polygonReductionValue')!
const valTexture          = document.getElementById('textureResolutionValue')!
const valColor            = document.getElementById('colorDepthValue')!
const valSnapping         = document.getElementById('vertexSnappingValue')!
const valFogNear          = document.getElementById('fogNearValue')!
const valFogFar           = document.getElementById('fogFarValue')!
const valAmbientIntensity = document.getElementById('ambientIntensityValue')!
const valDirIntensity     = document.getElementById('dirIntensityValue')!
const valFillIntensity    = document.getElementById('fillIntensityValue')!
const valRender           = document.getElementById('renderResolutionValue')!

// ── Labels ────────────────────────────────────────────────────────────────────

const TEXTURE_LABELS = ['full', '256px', '128px', '64px', '32px', '16px', '8px']
const RENDER_LABELS  = ['0.25x (320p)', '0.33x', '0.50x', '0.75x', '1.00x']
const snapLabel      = (v: number) => v === 1 ? 'off' : `÷${v}`

// ── Default settings (source of truth for reset) ──────────────────────────────

const DEFAULT_SETTINGS: PS1Settings = {
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

// ── Viewer ────────────────────────────────────────────────────────────────────

const viewer = new PS1Viewer(canvas, { ...DEFAULT_SETTINGS })

syncUIToSettings(DEFAULT_SETTINGS)
setExportEnabled(false)

// ── Loading helpers ───────────────────────────────────────────────────────────

function showLoading(msg = 'LOADING...') {
  loadingMsg.textContent = msg
  loadingOverlay.classList.remove('hidden')
}

function hideLoading() {
  loadingOverlay.classList.add('hidden')
}

// ── Geometry ──────────────────────────────────────────────────────────────────

sliderPolygon.addEventListener('change', async () => {
  // Use 'change' (not 'input') so we only process when the user releases the slider
  const v = Number(sliderPolygon.value)
  valPolygon.textContent = `${v}%`
  showLoading('PROCESSING...')
  await viewer.updateSettingsAsync({ polygonReduction: v })
  hideLoading()
})

// Update the display value while dragging, but don't process yet
sliderPolygon.addEventListener('input', () => {
  valPolygon.textContent = `${sliderPolygon.value}%`
})

checkWelding.addEventListener('change', async () => {
  showLoading('PROCESSING...')
  await viewer.updateSettingsAsync({ vertexWelding: checkWelding.checked })
  hideLoading()
})

// ── Texture Mapping ───────────────────────────────────────────────────────────

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

// ── Hardware Quirks ───────────────────────────────────────────────────────────

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

// ── Lighting ──────────────────────────────────────────────────────────────────

sliderAmbientIntensity.addEventListener('input', () => {
  const v = Number(sliderAmbientIntensity.value)
  valAmbientIntensity.textContent = v.toFixed(2)
  viewer.updateLighting({ ambientIntensity: v })
})

inputAmbientColor.addEventListener('input', () => {
  viewer.updateLighting({ ambientColor: inputAmbientColor.value })
})

sliderDirIntensity.addEventListener('input', () => {
  const v = Number(sliderDirIntensity.value)
  valDirIntensity.textContent = v.toFixed(2)
  viewer.updateLighting({ dirIntensity: v })
})

inputDirColor.addEventListener('input', () => {
  viewer.updateLighting({ dirColor: inputDirColor.value })
})

sliderFillIntensity.addEventListener('input', () => {
  const v = Number(sliderFillIntensity.value)
  valFillIntensity.textContent = v.toFixed(2)
  viewer.updateLighting({ fillIntensity: v })
})

inputFillColor.addEventListener('input', () => {
  viewer.updateLighting({ fillColor: inputFillColor.value })
})

// ── Render ────────────────────────────────────────────────────────────────────

sliderRender.addEventListener('input', () => {
  const v = Number(sliderRender.value)
  valRender.textContent = RENDER_LABELS[v - 1]
  viewer.updateSettings({ renderResolution: v })
})

checkAutoRotate.addEventListener('change', () => {
  viewer.setAutoRotate(checkAutoRotate.checked)
})

checkWireframe.addEventListener('change', () => {
  viewer.setWireframe(checkWireframe.checked)
})

// ── Reset ─────────────────────────────────────────────────────────────────────

btnReset.addEventListener('click', () => {
  viewer.updateSettings({ ...DEFAULT_SETTINGS })
  syncUIToSettings(DEFAULT_SETTINGS)
})

// ── Export ────────────────────────────────────────────────────────────────────

btnExportGLB.addEventListener('click', async () => {
  btnExportGLB.disabled = true
  btnExportGLB.textContent = 'EXPORTING...'
  try {
    await viewer.exportGLB()
  } finally {
    btnExportGLB.disabled = false
    btnExportGLB.textContent = 'EXPORT GLB'
  }
})

btnExportOBJ.addEventListener('click', () => viewer.exportOBJ())
btnExportPNG.addEventListener('click', () => viewer.exportTexturePNG())

// ── File loading ──────────────────────────────────────────────────────────────

async function loadFile(file: File) {
  const allowed = ['glb', 'gltf', 'obj']
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!allowed.includes(ext)) {
    alert(`Unsupported format: .${ext}\nPlease use GLB, GLTF or OBJ.`)
    return
  }
  dropZone.classList.add('hidden')
  showLoading('LOADING...')
  try {
    await viewer.loadFile(file)
    setExportEnabled(true)
  } catch (e) {
    console.error(e)
    alert('Failed to load model. Check the console for details.')
    dropZone.classList.remove('hidden')
  } finally {
    hideLoading()
  }
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function setExportEnabled(enabled: boolean) {
  btnExportGLB.disabled = !enabled
  btnExportOBJ.disabled = !enabled
  btnExportPNG.disabled = !enabled
}

/** Sync all UI controls to match a given settings object */
function syncUIToSettings(s: PS1Settings) {
  sliderPolygon.value        = String(s.polygonReduction)
  valPolygon.textContent     = `${s.polygonReduction}%`
  checkWelding.checked       = s.vertexWelding

  sliderTexture.value        = String(s.textureResolution)
  valTexture.textContent     = TEXTURE_LABELS[s.textureResolution]
  sliderColor.value          = String(s.colorDepth)
  valColor.textContent       = String(s.colorDepth)
  checkAffine.checked        = s.affineMapping

  sliderSnapping.value       = String(s.vertexSnapping)
  valSnapping.textContent    = snapLabel(s.vertexSnapping)
  checkFlat.checked          = s.flatShading
  checkDithering.checked     = s.dithering
  checkFog.checked           = s.fog
  fogControls.classList.toggle('hidden', !s.fog)
  sliderFogNear.value        = String(s.fogNear)
  valFogNear.textContent     = String(s.fogNear)
  sliderFogFar.value         = String(s.fogFar)
  valFogFar.textContent      = String(s.fogFar)

  sliderRender.value         = String(s.renderResolution)
  valRender.textContent      = RENDER_LABELS[s.renderResolution - 1]

  checkAutoRotate.checked = false
  viewer.setAutoRotate(false)
  checkWireframe.checked  = false
  viewer.setWireframe(false)
}

// ── Resize ────────────────────────────────────────────────────────────────────

new ResizeObserver(() => {
  viewer.resize(canvas.clientWidth, canvas.clientHeight)
}).observe(canvas)
