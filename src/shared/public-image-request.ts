// Fetch one hop with no ambient credentials and with DNS checked at connection time.
import { get } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { isPublicAddress, publicLookup } from './public-lookup'

export function publicImageRequest(target: string, signal: AbortSignal): Promise<Response> {
  const url = new URL(target)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (isIP(host) && !isPublicAddress(host))
  ) {
    return Promise.reject(new Error('Expected a public HTTPS image URL'))
  }
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        agent: false,
        lookup: publicLookup(),
        signal,
        headers: { accept: 'image/*', 'accept-encoding': 'identity' },
      },
      (incoming) => {
        const headers = new Headers()
        for (const key of ['content-type', 'content-length', 'location']) {
          const value = incoming.headers[key]
          if (typeof value === 'string') headers.set(key, value)
        }
        const status = incoming.statusCode ?? 0
        if (status < 200 || [204, 205, 304].includes(status)) {
          incoming.destroy()
          reject(new Error('No image body'))
          return
        }
        resolve(
          new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers }),
        )
      },
    )
    request.on('error', reject)
  })
}
