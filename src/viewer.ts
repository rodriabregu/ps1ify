import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js'
import {
  patchWithPS1,
  downscaleTexture,
  updatePS1Uniforms,
  type PS1PatchedMaterial,
} from './ps1Material'

export interface PS1Settings {
  polygonReduction:  number  // 0–95 (% vertices to remove)
  vertexSnapping:    number  // 1–16: divisor applied to render target res (higher = more wobble)
  textureResolution: number  // index 0–5 → [256,128,64,32,16,8]
  colorDepth:        number  // 2–256 steps per channel
  renderResolution:  number  // index 1–5 → [0.25, 0.33, 0.5, 0.75, 1.0]
  flatShading:       boolean
  affineMapping:     boolean
}

// Index 0 = no downscale (null), then progressively smaller
const TEXTURE_SIZES: (number | null)[] = [null, 256, 128, 64, 32, 16, 8]
const RENDER_SCALES  = [0.25, 0.33, 0.5, 0.75, 1.0]

export class PS1Viewer {
  private renderer:     THREE.WebGLRenderer
  private scene:        THREE.Scene
  private camera:       THREE.PerspectiveCamera
  private controls:     OrbitControls
  private settings:     PS1Settings
  private animFrameId:  number | null = null

  private originalModel:    THREE.Group | null = null
  private currentMesh:      THREE.Object3D | null = null
  // Original textures keyed by material uuid — always downscale from here
  private originalTextures: Map<string, THREE.Texture> = new Map()

  // Low-res render target pipeline
  private renderTarget: THREE.WebGLRenderTarget
  private postScene:    THREE.Scene
  private postCamera:   THREE.OrthographicCamera

  constructor(canvas: HTMLCanvasElement, settings: PS1Settings) {
    this.settings = { ...settings }

    // Renderer — antialias off on purpose
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight)
    this.renderer.shadowMap.enabled = false

    // Main scene
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x111111)

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      50,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      1000
    )
    this.camera.position.set(0, 1.5, 4)

    // Orbit controls
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping  = true
    this.controls.dampingFactor  = 0.08

    // Lights — keep them so MeshStandardMaterial PBR works
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5))
    const dir = new THREE.DirectionalLight(0xffffff, 1.5)
    dir.position.set(3, 5, 3)
    this.scene.add(dir)
    const fill = new THREE.DirectionalLight(0x4466ff, 0.4)
    fill.position.set(-3, 0, -3)
    this.scene.add(fill)

    // Low-res render target (NearestFilter = blocky upscale)
    this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format:    THREE.RGBAFormat,
    })

    // Full-screen blit quad
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
    const prev = { ...this.settings }
    this.settings = { ...this.settings, ...partial }

    // Polygon reduction → full geometry rebuild
    if (
      partial.polygonReduction !== undefined &&
      partial.polygonReduction !== prev.polygonReduction &&
      this.originalModel
    ) {
      this.rebuildMesh()
      return
    }

    // These require shader recompilation or new textures → full material rebuild
    const needsMaterialRebuild =
      partial.textureResolution !== undefined ||
      partial.flatShading       !== undefined ||
      partial.affineMapping     !== undefined

    if (needsMaterialRebuild) {
      this.applyPS1Materials()
      return
    }

    // Render resolution → just resize the render target
    if (partial.renderResolution !== undefined) {
      this.updateRenderTargetSize()
      return
    }

    // Snapping / colorDepth → update uniforms only (no rebuild, no recompile)
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
      try {
        new OBJLoader().load(url, resolve, undefined, reject)
      } catch (e) {
        reject(e)
      }
    })
  }

  private setModel(group: THREE.Group): void {
    if (this.currentMesh) this.scene.remove(this.currentMesh)

    // Normalize to 2-unit bounding box centered at origin
    const box    = new THREE.Box3().setFromObject(group)
    const center = box.getCenter(new THREE.Vector3())
    const size   = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    group.position.sub(center)
    group.scale.setScalar(2 / maxDim)

    // Snapshot original textures keyed by texture.uuid (stable across material clones)
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

  // ── Mesh rebuild (polygon reduction) ───────────────────────────────────────

  private rebuildMesh(): void {
    if (!this.originalModel) return
    if (this.currentMesh) this.scene.remove(this.currentMesh)

    const clone      = this.originalModel.clone(true)
    const reduction  = this.settings.polygonReduction / 100

    if (reduction > 0) {
      const modifier = new SimplifyModifier()
      clone.traverse(obj => {
        if (!(obj as THREE.Mesh).isMesh) return
        const mesh  = obj as THREE.Mesh
        const count = mesh.geometry.attributes.position.count
        const remove = Math.floor(count * reduction)
        if (remove > 0 && remove < count - 3) {
          try {
            mesh.geometry = modifier.modify(mesh.geometry, remove)
          } catch {
            // Degenerate geometry — skip
          }
        }
      })
    }

    this.currentMesh = clone
    this.scene.add(clone)
    this.applyPS1Materials()
  }

  // ── PS1 material patching ───────────────────────────────────────────────────

  /**
   * Walk every mesh, ensure its material is a MeshStandardMaterial,
   * downscale its textures, then patch with PS1 effects via onBeforeCompile.
   */
  private applyPS1Materials(): void {
    if (!this.currentMesh || !this.originalModel) return

    const texSize = TEXTURE_SIZES[this.settings.textureResolution] ?? null

    // Build a flat list of original materials in traversal order — same order
    // as currentMesh since it's a clone of originalModel.
    const originalMats: THREE.Material[] = []
    this.originalModel.traverse(obj => {
      if (!(obj as THREE.Mesh).isMesh) return
      const mats = (obj as THREE.Mesh).material
      if (Array.isArray(mats)) originalMats.push(...mats)
      else originalMats.push(mats)
    })

    let matIndex = 0

    this.currentMesh.traverse(obj => {
      if (!(obj as THREE.Mesh).isMesh) return
      const mesh = obj as THREE.Mesh

      const process = (_mat: THREE.Material): THREE.MeshStandardMaterial => {
        // Always take from originalModel — never from currentMesh which may
        // already have downscaled textures from a previous applyPS1Materials call.
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

        // std.map is now the original texture — downscale from it directly
        if (std.map && texSize !== null) {
          std.map = downscaleTexture(std.map, texSize)
        }

        // Patch with PS1 vertex snapping + posterization
        const [sw, sh] = this.snapResolution()
        patchWithPS1(std, {
          snapWidth:   sw,
          snapHeight:  sh,
          affine:      this.settings.affineMapping,
          colorDepth:  this.settings.colorDepth,
          flatShading: this.settings.flatShading,
        })

        return std
      }

      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(process)
        : process(mesh.material)
    })
  }

  /**
   * Update only shader uniforms — no material or geometry rebuild needed.
   */
  private updateShaderUniforms(): void {
    if (!this.currentMesh) return

    this.currentMesh.traverse(obj => {
      if (!(obj as THREE.Mesh).isMesh) return
      const mesh = obj as THREE.Mesh
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]

      const [sw, sh] = this.snapResolution()
      mats.forEach(mat => {
        updatePS1Uniforms(mat as PS1PatchedMaterial, {
          snapWidth:  sw,
          snapHeight: sh,
          affine:     this.settings.affineMapping,
          colorDepth: this.settings.colorDepth,
        })
      })
    })
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Returns the [width, height] the vertex snapper should use.
   * vertexSnapping is a divisor (1 = full RT res, 16 = very coarse grid).
   * Higher divisor = fewer snap points = more wobble.
   */
  private snapResolution(): [number, number] {
    const scale   = RENDER_SCALES[this.settings.renderResolution - 1] ?? 0.25
    const canvas  = this.renderer.domElement
    const rtW     = Math.max(Math.floor(canvas.clientWidth  * scale), 1)
    const rtH     = Math.max(Math.floor(canvas.clientHeight * scale), 1)
    const divisor = this.settings.vertexSnapping  // 1–16
    return [
      Math.max(Math.floor(rtW / divisor), 1),
      Math.max(Math.floor(rtH / divisor), 1),
    ]
  }

  // ── Render target ───────────────────────────────────────────────────────────

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

      // 1. Render scene at low resolution
      this.renderer.setRenderTarget(this.renderTarget)
      this.renderer.render(this.scene, this.camera)

      // 2. Upscale to screen with nearest-neighbor (blocky pixels)
      this.renderer.setRenderTarget(null)
      this.renderer.render(this.postScene, this.postCamera)
    }
    tick()
  }
}
