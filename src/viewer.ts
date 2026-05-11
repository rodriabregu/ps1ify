import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import {
  patchWithPS1,
  downscaleTexture,
  updatePS1Uniforms,
  type PS1PatchedMaterial,
} from './ps1Material'

export interface PS1Settings {
  // Geometry
  polygonReduction:  number
  vertexWelding:     boolean
  // Hardware Quirks
  vertexSnapping:    number
  dithering:         boolean
  fog:               boolean
  fogNear:           number
  fogFar:            number
  // Texture Mapping
  textureResolution: number
  colorDepth:        number
  affineMapping:     boolean
  // Render
  renderResolution:  number
  flatShading:       boolean
}

export interface LightSettings {
  ambientIntensity: number   // 0–2
  ambientColor:     string   // hex string e.g. '#ffffff'
  dirIntensity:     number   // 0–3
  dirColor:         string
  fillIntensity:    number   // 0–2
  fillColor:        string
}

const TEXTURE_SIZES: (number | null)[] = [null, 256, 128, 64, 32, 16, 8]
const RENDER_SCALES = [0.25, 0.33, 0.5, 0.75, 1.0]

export class PS1Viewer {
  private renderer:    THREE.WebGLRenderer
  private scene:       THREE.Scene
  private camera:      THREE.PerspectiveCamera
  private controls:    OrbitControls
  private settings:    PS1Settings
  private animFrameId: number | null = null

  private originalModel:    THREE.Group | null = null
  private currentMesh:      THREE.Object3D | null = null
  private originalTextures: Map<string, THREE.Texture> = new Map()

  // Lights — kept as class properties so updateLighting() can reach them
  private ambientLight: THREE.AmbientLight
  private dirLight:     THREE.DirectionalLight
  private fillLight:    THREE.DirectionalLight

  private renderTarget: THREE.WebGLRenderTarget
  private postScene:    THREE.Scene
  private postCamera:   THREE.OrthographicCamera

  // Auto-rotate & wireframe state
  private wireframeGroup: THREE.Group | null = null

  constructor(canvas: HTMLCanvasElement, settings: PS1Settings) {
    this.settings = { ...settings }

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight)
    this.renderer.shadowMap.enabled = false

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x111111)

    this.camera = new THREE.PerspectiveCamera(
      50, canvas.clientWidth / canvas.clientHeight, 0.1, 1000
    )
    this.camera.position.set(0, 1.5, 4)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping    = true
    this.controls.dampingFactor    = 0.08
    this.controls.autoRotate       = false
    this.controls.autoRotateSpeed  = 2.0

    // Lights
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.5)
    this.scene.add(this.ambientLight)

    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.5)
    this.dirLight.position.set(3, 5, 3)
    this.scene.add(this.dirLight)

    this.fillLight = new THREE.DirectionalLight(0x4466ff, 0.4)
    this.fillLight.position.set(-3, 0, -3)
    this.scene.add(this.fillLight)

    this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format:    THREE.RGBAFormat,
    })

    this.postScene  = new THREE.Scene()
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const blit = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: this.renderTarget.texture })
    )
    this.postScene.add(blit)

    this.updateRenderTargetSize()
    this.startLoop()
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async loadFile(file: File): Promise<void> {
    const ext = file.name.split('.').pop()?.toLowerCase()
    const url = URL.createObjectURL(file)
    try {
      let group: THREE.Group
      if (ext === 'glb' || ext === 'gltf') {
        group = await this.loadGLTF(url)
      } else if (ext === 'obj') {
        group = await this.loadOBJ(url)
      } else {
        throw new Error(`Unsupported format: .${ext}`)
      }
      this.setModel(group)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  updateSettings(partial: Partial<PS1Settings>): void {
    this.settings = { ...this.settings, ...partial }

    const needsRebuild =
      partial.polygonReduction !== undefined ||
      partial.vertexWelding    !== undefined

    if (needsRebuild && this.originalModel) {
      this.rebuildMesh()
      return
    }

    this._applyNonRebuildSettings(partial)
  }

  // Async variant — lets the caller show a loading state before the heavy rebuild
  async updateSettingsAsync(partial: Partial<PS1Settings>): Promise<void> {
    this.settings = { ...this.settings, ...partial }

    const needsRebuild =
      partial.polygonReduction !== undefined ||
      partial.vertexWelding    !== undefined

    if (needsRebuild && this.originalModel) {
      // Yield to the browser so it can paint the loading overlay first
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      this.rebuildMesh()
      return
    }

    this._applyNonRebuildSettings(partial)
  }

  private _applyNonRebuildSettings(partial: Partial<PS1Settings>): void {

    const needsMaterialRebuild =
      partial.textureResolution !== undefined ||
      partial.flatShading       !== undefined ||
      partial.dithering         !== undefined ||
      partial.fog               !== undefined

    if (needsMaterialRebuild) {
      this.applyPS1Materials()
      return
    }

    if (partial.renderResolution !== undefined) {
      this.updateRenderTargetSize()
      return
    }

    this.updateShaderUniforms()
  }

  updateLighting(partial: Partial<LightSettings>): void {
    if (partial.ambientIntensity !== undefined)
      this.ambientLight.intensity = partial.ambientIntensity
    if (partial.ambientColor !== undefined)
      this.ambientLight.color.set(partial.ambientColor)
    if (partial.dirIntensity !== undefined)
      this.dirLight.intensity = partial.dirIntensity
    if (partial.dirColor !== undefined)
      this.dirLight.color.set(partial.dirColor)
    if (partial.fillIntensity !== undefined)
      this.fillLight.intensity = partial.fillIntensity
    if (partial.fillColor !== undefined)
      this.fillLight.color.set(partial.fillColor)
  }

  setAutoRotate(enabled: boolean): void {
    this.controls.autoRotate = enabled
  }

  setWireframe(enabled: boolean): void {
    // Remove existing wireframe group
    if (this.wireframeGroup) {
      this.scene.remove(this.wireframeGroup)
      this.wireframeGroup.traverse(obj => {
        if ((obj as THREE.LineSegments).isLineSegments) {
          (obj as THREE.LineSegments).geometry.dispose()
          ;((obj as THREE.LineSegments).material as THREE.Material).dispose()
        }
      })
      this.wireframeGroup = null
    }

    if (!enabled || !this.currentMesh) return

    const group = new THREE.Group()
    const wireMat = new THREE.LineBasicMaterial({
      color:       0x00ff88,
      transparent: true,
      opacity:     0.25,
      depthTest:   true,
    })

    this.currentMesh.traverse(obj => {
      if (!(obj as THREE.Mesh).isMesh) return
      const mesh = obj as THREE.Mesh
      const wireGeo  = new THREE.WireframeGeometry(mesh.geometry)
      const lines    = new THREE.LineSegments(wireGeo, wireMat)
      // Match the mesh's world transform
      lines.matrix.copy(mesh.matrixWorld)
      lines.matrixAutoUpdate = false
      group.add(lines)
    })

    this.wireframeGroup = group
    this.scene.add(group)
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  async exportGLB(): Promise<void> {
    if (!this.currentMesh) return

    // Wrap in a temporary scene so GLTFExporter gets the right matrix context
    const exportScene = new THREE.Scene()
    const clone = this.currentMesh.clone(true)
    clone.updateWorldMatrix(true, true)
    exportScene.add(clone)

    const exporter = new GLTFExporter()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = await (exporter as any).parseAsync(exportScene, { binary: true }) as ArrayBuffer
    this.triggerDownload(new Blob([buffer], { type: 'model/gltf-binary' }), 'model-ps1.glb')
  }

  exportOBJ(): void {
    if (!this.currentMesh) return
    const exporter = new OBJExporter()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const str = (exporter as any).parse(this.currentMesh) as string
    this.triggerDownload(new Blob([str], { type: 'text/plain' }), 'model-ps1.obj')
  }

  exportTexturePNG(): void {
    if (!this.currentMesh) return

    let canvas: HTMLCanvasElement | null = null
    this.currentMesh.traverse(obj => {
      if (canvas) return
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      const std = mat as THREE.MeshStandardMaterial
      if (std?.map?.image instanceof HTMLCanvasElement) {
        canvas = std.map.image
      }
    })

    if (!canvas) {
      alert('No downscaled texture found. Lower the Texture Resolution slider first.')
      return
    }

    ;(canvas as HTMLCanvasElement).toBlob((blob: Blob | null) => {
      if (blob) this.triggerDownload(blob, 'texture-ps1.png')
    }, 'image/png')
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.updateRenderTargetSize()
  }

  dispose(): void {
    if (this.animFrameId !== null) cancelAnimationFrame(this.animFrameId)
    this.renderer.dispose()
    this.renderTarget.dispose()
  }

  // ── Model loading ───────────────────────────────────────────────────────────

  private loadGLTF(url: string): Promise<THREE.Group> {
    return new Promise((resolve, reject) =>
      new GLTFLoader().load(url, gltf => resolve(gltf.scene), undefined, reject)
    )
  }

  private loadOBJ(url: string): Promise<THREE.Group> {
    return new Promise((resolve, reject) => {
      try { new OBJLoader().load(url, resolve, undefined, reject) }
      catch (e) { reject(e) }
    })
  }

  private setModel(group: THREE.Group): void {
    if (this.currentMesh) this.scene.remove(this.currentMesh)

    const box    = new THREE.Box3().setFromObject(group)
    const center = box.getCenter(new THREE.Vector3())
    const size   = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    group.position.sub(center)
    group.scale.setScalar(2 / maxDim)

    this.originalTextures.clear()
    group.traverse(obj => {
      if (!(obj as THREE.Mesh).isMesh) return
      const mats = Array.isArray((obj as THREE.Mesh).material)
        ? (obj as THREE.Mesh).material as THREE.Material[]
        : [(obj as THREE.Mesh).material as THREE.Material]
      mats.forEach(mat => {
        const std = mat as THREE.MeshStandardMaterial
        if (std.map) this.originalTextures.set(std.map.uuid, std.map)
      })
    })

    this.originalModel = group
    this.rebuildMesh()
  }

  // ── Mesh rebuild ────────────────────────────────────────────────────────────

  private rebuildMesh(): void {
    if (!this.originalModel) return
    if (this.currentMesh) this.scene.remove(this.currentMesh)

    const clone     = this.originalModel.clone(true)
    const reduction = this.settings.polygonReduction / 100

    clone.traverse(obj => {
      if (!(obj as THREE.Mesh).isMesh) return
      const mesh = obj as THREE.Mesh

      if (this.settings.vertexWelding) {
        try {
          mesh.geometry = mergeVertices(mesh.geometry, 1e-4)
          mesh.geometry.computeVertexNormals()
        } catch { /* skip */ }
      }

      if (reduction > 0) {
        const modifier = new SimplifyModifier()
        const count    = mesh.geometry.attributes.position.count
        const remove   = Math.floor(count * reduction)
        if (remove > 0 && remove < count - 3) {
          try { mesh.geometry = modifier.modify(mesh.geometry, remove) }
          catch { /* skip */ }
        }
      }
    })

    this.currentMesh = clone
    this.scene.add(clone)
    this.applyPS1Materials()

    // Rebuild wireframe if it was active
    if (this.wireframeGroup) this.setWireframe(true)
  }

  // ── PS1 materials ───────────────────────────────────────────────────────────

  private applyPS1Materials(): void {
    if (!this.currentMesh || !this.originalModel) return

    const texSize = TEXTURE_SIZES[this.settings.textureResolution] ?? null

    const originalMats: THREE.Material[] = []
    this.originalModel.traverse(obj => {
      if (!(obj as THREE.Mesh).isMesh) return
      const mats = (obj as THREE.Mesh).material
      if (Array.isArray(mats)) originalMats.push(...mats)
      else originalMats.push(mats)
    })

    let matIndex = 0
    const [sw, sh] = this.snapResolution()

    this.currentMesh.traverse(obj => {
      if (!(obj as THREE.Mesh).isMesh) return
      const mesh = obj as THREE.Mesh

      const process = (_mat: THREE.Material): THREE.MeshStandardMaterial => {
        const srcMat = originalMats[matIndex++] ?? _mat

        let std: THREE.MeshStandardMaterial
        if (srcMat instanceof THREE.MeshStandardMaterial) {
          std = srcMat.clone()
        } else {
          std = new THREE.MeshStandardMaterial()
          const src = srcMat as THREE.MeshPhongMaterial
          if (src.map)   std.map   = src.map
          if (src.color) std.color = src.color.clone()
        }

        if (std.map && texSize !== null) {
          std.map = downscaleTexture(std.map, texSize)
        }

        patchWithPS1(std, {
          snapWidth:   sw,
          snapHeight:  sh,
          affine:      this.settings.affineMapping,
          colorDepth:  this.settings.colorDepth,
          flatShading: this.settings.flatShading,
          dithering:   this.settings.dithering,
          fog:         this.settings.fog,
          fogNear:     this.settings.fogNear,
          fogFar:      this.settings.fogFar,
        })

        return std
      }

      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(process)
        : process(mesh.material)
    })
  }

  private updateShaderUniforms(): void {
    if (!this.currentMesh) return
    const [sw, sh] = this.snapResolution()

    this.currentMesh.traverse(obj => {
      if (!(obj as THREE.Mesh).isMesh) return
      const mats = Array.isArray((obj as THREE.Mesh).material)
        ? (obj as THREE.Mesh).material as THREE.Material[]
        : [(obj as THREE.Mesh).material as THREE.Material]

      mats.forEach(mat => {
        updatePS1Uniforms(mat as PS1PatchedMaterial, {
          snapWidth:  sw,
          snapHeight: sh,
          colorDepth: this.settings.colorDepth,
          affine:     this.settings.affineMapping,
          fogNear:    this.settings.fogNear,
          fogFar:     this.settings.fogFar,
        })
      })
    })
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private snapResolution(): [number, number] {
    const scale   = RENDER_SCALES[this.settings.renderResolution - 1] ?? 0.25
    const canvas  = this.renderer.domElement
    const rtW     = Math.max(Math.floor(canvas.clientWidth  * scale), 1)
    const rtH     = Math.max(Math.floor(canvas.clientHeight * scale), 1)
    const divisor = this.settings.vertexSnapping
    return [
      Math.max(Math.floor(rtW / divisor), 1),
      Math.max(Math.floor(rtH / divisor), 1),
    ]
  }

  private updateRenderTargetSize(): void {
    const scale  = RENDER_SCALES[this.settings.renderResolution - 1] ?? 0.25
    const canvas = this.renderer.domElement
    const w      = Math.floor(canvas.clientWidth  * scale)
    const h      = Math.floor(canvas.clientHeight * scale)
    this.renderTarget.setSize(Math.max(w, 1), Math.max(h, 1))
  }

  private triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const a   = Object.assign(document.createElement('a'), { href: url, download: filename })
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Render loop ─────────────────────────────────────────────────────────────

  private startLoop(): void {
    const tick = () => {
      this.animFrameId = requestAnimationFrame(tick)
      this.controls.update()
      this.renderer.setRenderTarget(this.renderTarget)
      this.renderer.render(this.scene, this.camera)
      this.renderer.setRenderTarget(null)
      this.renderer.render(this.postScene, this.postCamera)
    }
    tick()
  }
}
