import * as THREE from 'three'

export interface PS1Opts {
  snapWidth:   number   // render target width in px
  snapHeight:  number   // render target height in px
  affine:      boolean  // perspective-incorrect UV mapping
  colorDepth:  number   // 2–256 steps per channel
  flatShading: boolean
  dithering:   boolean  // Bayer 4×4 dithering
  fog:         boolean  // draw distance fog
  fogNear:     number   // fog start distance
  fogFar:      number   // fog end distance
}

// ── Vertex shader ─────────────────────────────────────────────────────────────

const VERTEX_PREAMBLE = /* glsl */`
  uniform vec2  uSnapRes;
  varying float vW_PS1;
  varying vec2  vUv_PS1;
`

const VERTEX_MAIN_END = /* glsl */`
  // PS1 vertex snapping — snap to render-target pixel grid
  vec4  _ps1Clip = gl_Position;
  vec2  _ps1NDC  = _ps1Clip.xy / _ps1Clip.w;
  vec2  _ps1Px   = (_ps1NDC * 0.5 + 0.5) * uSnapRes;
  _ps1Px         = floor(_ps1Px);
  _ps1NDC        = (_ps1Px / uSnapRes) * 2.0 - 1.0;
  gl_Position    = vec4(_ps1NDC * _ps1Clip.w, _ps1Clip.zw);
  vW_PS1         = gl_Position.w;
  vUv_PS1        = uv * gl_Position.w;
`

// ── Fragment shader ───────────────────────────────────────────────────────────

const FRAGMENT_PREAMBLE = /* glsl */`
  uniform bool  uAffine;
  uniform float uColorDepth;
  uniform bool  uDithering;
  uniform bool  uFog;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec3  uFogColor;
  varying float vW_PS1;
  varying vec2  vUv_PS1;
`

// Bayer 4×4 ordered dithering matrix
const BAYER_DITHER = /* glsl */`
  float bayerDither() {
    int bayer[16];
    bayer[0]  =  0; bayer[1]  =  8; bayer[2]  =  2; bayer[3]  = 10;
    bayer[4]  = 12; bayer[5]  =  4; bayer[6]  = 14; bayer[7]  =  6;
    bayer[8]  =  3; bayer[9]  = 11; bayer[10] =  1; bayer[11] =  9;
    bayer[12] = 15; bayer[13] =  7; bayer[14] = 13; bayer[15] =  5;
    int x = int(mod(gl_FragCoord.x, 4.0));
    int y = int(mod(gl_FragCoord.y, 4.0));
    return float(bayer[y * 4 + x]) / 16.0 - 0.5;
  }
`

// ── patchWithPS1 ─────────────────────────────────────────────────────────────

export function patchWithPS1(mat: THREE.MeshStandardMaterial, opts: PS1Opts): void {
  ;(mat as PS1PatchedMaterial).__ps1opts = opts

  mat.flatShading = opts.flatShading

  // Only compile-time variants in the key — uniforms (snap, colorDepth) excluded
  // affine is now a runtime uniform — not a compile-time variant
  mat.customProgramCacheKey = () =>
    `ps1_flat${opts.flatShading}_dith${opts.dithering}_fog${opts.fog}`

  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uSnapRes']    = { value: new THREE.Vector2(opts.snapWidth, opts.snapHeight) }
    shader.uniforms['uAffine']     = { value: opts.affine }
    shader.uniforms['uColorDepth'] = { value: opts.colorDepth }
    shader.uniforms['uDithering']  = { value: opts.dithering }
    shader.uniforms['uFog']        = { value: opts.fog }
    shader.uniforms['uFogNear']    = { value: opts.fogNear }
    shader.uniforms['uFogFar']     = { value: opts.fogFar }
    shader.uniforms['uFogColor']   = { value: new THREE.Vector3(0, 0, 0) }

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
      `${FRAGMENT_PREAMBLE}\n${BAYER_DITHER}\nvoid main() {`
    )

    // Affine UV — always inject, controlled by uAffine uniform at runtime
    // This avoids needing shader recompilation when toggling affine on/off.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */`
      #ifdef USE_MAP
        vec4 sampledDiffuseColor;
        if (uAffine) {
          vec2 _affineUv = vUv_PS1 / vW_PS1;
          sampledDiffuseColor = texture2D(map, _affineUv);
        } else {
          sampledDiffuseColor = texture2D(map, vMapUv);
        }
        #ifdef DECODE_VIDEO_TEXTURE
          sampledDiffuseColor = sRGBTransferEOTF(sampledDiffuseColor);
        #endif
        diffuseColor *= sampledDiffuseColor;
      #endif
      `
    )

    // Post-processing: dithering + posterization + fog — injected before closing }
    shader.fragmentShader = shader.fragmentShader.replace(
      /}(\s*)$/,
      /* glsl */`
      // ── Dithering ─────────────────────────────────────────────────────────
      float _steps = max(uColorDepth, 2.0);
      if (uDithering) {
        float _threshold = bayerDither() / _steps;
        gl_FragColor.rgb += _threshold;
      }

      // ── Color posterization ───────────────────────────────────────────────
      gl_FragColor.rgb = floor(gl_FragColor.rgb * _steps + 0.5) / _steps;
      gl_FragColor.rgb = clamp(gl_FragColor.rgb, 0.0, 1.0);

      // ── Draw distance fog ─────────────────────────────────────────────────
      if (uFog) {
        float _depth     = gl_FragCoord.z / gl_FragCoord.w;
        float _fogFactor = clamp((_depth - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, _fogFactor);
      }
      }\n`
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
  if (partial.snapWidth  !== undefined) u['uSnapRes'].value.x  = partial.snapWidth
  if (partial.snapHeight !== undefined) u['uSnapRes'].value.y  = partial.snapHeight
  if (partial.colorDepth !== undefined) u['uColorDepth'].value = partial.colorDepth
  if (partial.affine     !== undefined) u['uAffine'].value     = partial.affine
  if (partial.fogNear    !== undefined) u['uFogNear'].value    = partial.fogNear
  if (partial.fogFar     !== undefined) u['uFogFar'].value     = partial.fogFar
}
