/** True when a WebGL2 context can be created (false in jsdom and very old browsers). */
export function supportsWebGL(): boolean {
  if (typeof window === 'undefined' || typeof WebGL2RenderingContext === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    // Release the probe context right away: browsers cap live contexts.
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return Boolean(gl)
  } catch {
    return false
  }
}
