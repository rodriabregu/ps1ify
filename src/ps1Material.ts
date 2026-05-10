import * as THREE from 'three'

export interface PS1Opts {
  snapWidth:   number   // render target width in px
  snapHeight:  number   // render target height in px
  affine:      boolean  // perspective-incorrect UV mapping
  colorDepth:  number   // 2–256 steps per channel
  flatShading: boolean
}

// ── Vertex shader injections ─────────────────────────────────────────────────

const VERTEX_PREAMBLE = /* glsl */`
  uniform vec2  uSnapRes;
  varying float vW_PS1;
  varying vec2  vUv_PS1;
`

const VERTEX_MAIN_END = /* glsl */`
  // PS1 vertex snapping
  vec4  _ps1Clip = gl_Position;
  vec2  _ps1NDC  = _ps1Clip.xy / _ps1Clip.w;
  vec2  _ps1Px   = (_ps1NDC * 0.5 + 0.5) * uSnapRes;
  _ps1Px         = floor(_ps1Px);
  _ps1NDC        = (_ps1Px / uSnapRes) * 2.0 - 1.0;
  gl_Position    = vec4(_ps1NDC * _ps1Clip.w, _ps1Clip.zw);

  // Pass w and UV for affine correction in fragment shader
  vW_PS1  = gl_Position.w;
  vUv_PS1 = uv * gl_Position.w;   // pre-multiply by w for affine
`

// ── Fragment shader injections ───────────────────────────────────────────────

const FRAGMENT_PREAMBLE = /* glsl */`
  uniform bool  uAffine;
  uniform float uColorDepth;
  varying float vW_PS1;
  varying vec2  vUv_PS1;
`

// Applied right after #include <map_fragment> to override the UV used for texture sampling
// We can't easily intercept map_fragment's UV, so we re-sample and override gl_FragColor
const FRAGMENT_POST = /* glsl */`
  // Color posterization
  float _steps = max(uColorDepth, 2.0);
  gl_FragColor.rgb = floor(gl_FragColor.rgb * _steps + 0.5) / _steps;
`

// ── patchWithPS1 ─────────────────────────────────────────────────────────────

export function patchWithPS1(mat: THREE.MeshStandardMaterial, opts: PS1Opts): void {
  ;(mat as PS1PatchedMaterial).__ps1opts = opts

  mat.flatShading = opts.flatShading

  // Each unique combination of compile-time opts gets its own shader program.
  // affine and flatShading affect the generated GLSL so they must be in the key.
  mat.customProgramCacheKey = () =>
    `ps1_${opts.snapWidth}x${opts.snapHeight}_aff${opts.affine}_cd${Math.round(opts.colorDepth)}_flat${opts.flatShading}`

  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uSnapRes']    = { value: new THREE.Vector2(opts.snapWidth, opts.snapHeight) }
    shader.uniforms['uAffine']     = { value: opts.affine }
    shader.uniforms['uColorDepth'] = { value: opts.colorDepth }

    ;(mat as PS1PatchedMaterial).__ps1shader = shader

    // ── Vertex shader ──────────────────────────────────────────────────────

    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      `${VERTEX_PREAMBLE}\nvoid main() {`
    )
    shader.vertexShader = shader.vertexShader.replace(
      /}(\s*)$/,
      `${VERTEX_MAIN_END}\n}\n`
    )

    // ── Fragment shader ────────────────────────────────────────────────────

    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      `${FRAGMENT_PREAMBLE}\nvoid main() {`
    )

    // Affine UV: override the vMapUv varying that Three.js uses internally
    // for texture sampling. We replace it right before map_fragment runs.
    if (opts.affine) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        /* glsl */`
        #ifdef USE_MAP
          vec2 _affineUv = vUv_PS1 / vW_PS1;
          vec4 sampledDiffuseColor = texture2D( map, _affineUv );
          #ifdef DECODE_VIDEO_TEXTURE
            sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
          #endif
          diffuseColor *= sampledDiffuseColor;
        #endif
        `
      )
    }

    // Posterization at the very end
    shader.fragmentShader = shader.fragmentShader.replace(
      /}(\s*)$/,
      `${FRAGMENT_POST}\n}\n`
    )
  }

  mat.needsUpdate = true
}

// ── Texture downscale ─────────────────────────────────────────────────────────

export function downscaleTexture(src: THREE.Texture, size: number): THREE.Texture {
  const image = src.image as HTMLImageElement | ImageBitmap | HTMLCanvasElement | null
  if (!image) return src

  const canvas  = document.createElement('canvas')
  canvas.width  = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(image as CanvasImageSource, 0, 0, size, size)

  const newTex = new THREE.CanvasTexture(canvas)
  newTex.minFilter   = THREE.NearestFilter
  newTex.magFilter   = THREE.NearestFilter
  newTex.colorSpace  = src.colorSpace
  newTex.wrapS       = src.wrapS
  newTex.wrapT       = src.wrapT
  newTex.needsUpdate = true
  return newTex
}

// ── Runtime uniform updates ───────────────────────────────────────────────────

export interface PS1PatchedMaterial extends THREE.MeshStandardMaterial {
  __ps1opts?:   PS1Opts
  __ps1shader?: { uniforms: Record<string, THREE.IUniform> }
}

export function updatePS1Uniforms(
  mat: PS1PatchedMaterial,
  partial: Partial<PS1Opts>
): void {
  if (!mat.__ps1shader) return
  const u = mat.__ps1shader.uniforms
  if (partial.snapWidth  !== undefined && u['uSnapRes']) u['uSnapRes'].value.x  = partial.snapWidth
  if (partial.snapHeight !== undefined && u['uSnapRes']) u['uSnapRes'].value.y  = partial.snapHeight
  if (partial.affine     !== undefined && u['uAffine'])  u['uAffine'].value     = partial.affine
  if (partial.colorDepth !== undefined && u['uColorDepth']) u['uColorDepth'].value = partial.colorDepth
}
