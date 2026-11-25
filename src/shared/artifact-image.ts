export const ARTIFACT_IMAGE_PATH = '/_kettu/image'

/** The exact HTTPS origin the user can authorize for images. */
export function imageOrigin(target: string): string | null {
  if (!/^https:\/\//i.test(target) || /[\s\\]/.test(target)) return null
  const url = URL.parse(target)
  return url && !url.username && !url.password && !url.hostname.includes('*') ? url.origin : null
}

export interface ImagePolicy {
  strict: boolean
  imageOrigins?: readonly string[]
}
