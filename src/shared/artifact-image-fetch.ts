// Node-side delivery for image destinations. The artifact never receives the upstream headers.
import { publicImageRequest } from './public-image-request'
import { imageOrigin, type ImagePolicy } from './artifact-image'

const MAX_BYTES = 8 * 1024 * 1024
export interface ArtifactImage {
  type: string
  bytes: Uint8Array<ArrayBuffer>
}

export function imageType(value: unknown): value is string {
  return typeof value === 'string' && /^image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)$/.test(value)
}

export async function fetchArtifactImage(
  target: string,
  policy: () => Promise<ImagePolicy | null>,
): Promise<ArtifactImage | null> {
  try {
    const signal = AbortSignal.timeout(10000)
    for (let redirects = 0; redirects <= 4; redirects++) {
      const origin = imageOrigin(target)
      if (!origin || target.length > 16384) return null
      const current = await policy()
      if (current?.strict !== false || !current.imageOrigins?.includes(origin)) return null
      const response = await publicImageRequest(target, signal)
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location) return null
        target = new URL(location, target).href
        continue
      }
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (
        !response.ok ||
        !imageType(type) ||
        Number(response.headers.get('content-length')) > MAX_BYTES
      ) {
        await response.body?.cancel()
        return null
      }
      const reader = response.body?.getReader()
      if (!reader) return null
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_BYTES) {
          await reader.cancel()
          return null
        }
        chunks.push(value)
      }
      return { type, bytes: Uint8Array.from(Buffer.concat(chunks, size)) }
    }
  } catch {
    // Includes disconnects, invalid redirects, policy lookup errors and timeouts.
  }
  return null
}

export function imageVersion(value: string | null): number | null {
  return value && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null
}
