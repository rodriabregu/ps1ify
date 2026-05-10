import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
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
  polygonReduction:  number   // 0–95 (% vertices to remove)
  vertexWelding:     boolean  // fuse duplicate vertices before simplify
  // Hardware Quirks
  vertexSnapping:    number   // 1–16: divisor on RT res (higher = more wobble)
  dithering:         boolean  // Bayer 4×4 ordered dithering
  fog:               boolean  // draw distance fog
  fogNear:           number   // fog start distance
  fogFar:            number   // fog end distance
  // Texture Mapping
  textureResolution: number   // index 0–6 → [full,256,128,64,32,16,8]
  colorDepth:        number   // 2–256 steps per channel
  affineMapping:     boolean
  // Render
  renderResolution:  number   // index 1–5 → [0.25,0.33,0.5,0.75,1.0]
  flatShading:       boolean
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

  private renderTarget: THREE.WebGLRenderTarget
  private postScene:    THREE.Scene
  private postCamera:   THREE.OrthographicCamera

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
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5))
    const dir = new THREE.DirectionalLight(0xffffff, 1.5)
    dir.position.set(3, 5, 3)
    this.scene.add(dir)
    const fill = new THREE.DirectionalLight(0x4466ff, 0.4)
    fill.position.set(-3, 0, -3)
    this.scene.add(fill)

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

    // Geometry changes → full rebuild (welding must happen before simplify)
    const needsRebuild =
      partial.polygonReduction !== undefined ||
      partial.vertexWelding    !== undefined

    if (needsRebuild && this.originalModel) {
      this.rebuildMesh()
      return
    }

    // Shader recompile or new textures needed
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

    // Uniforms only — cheapest path
    this.updateShaderUniforms()
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

    // Snapshot original textures keyed by texture.uuid (stable across clones)
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

      // 1. Vertex welding — fuse duplicates before simplify for cleaner topology
      if (this.settings.vertexWelding) {
        try {
          mesh.geometry = mergeVertices(mesh.geometry, 1e-4)
          mesh.geometry.computeVertexNormals()
        } catch { /* skip on degenerate geometry */ }
      }

      // 2. Polygon reduction
      if (reduction > 0) {
        const modifier = new SimplifyModifier()
        const count    = mesh.geometry.attributes.position.count
        const remove   = Math.floor(count * reduction)
        if (remove > 0 && remove < count - 3) {
          try {
            mesh.geometry = modifier.modify(mesh.geometry, remove)
          } catch { /* skip */ }
        }
      }
    })

    this.currentMesh = clone
    this.scene.add(clone)
    this.applyPS1Materials()
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
