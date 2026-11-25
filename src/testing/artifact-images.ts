import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as transport from '@shared/public-image-request'
import { vi } from 'vitest'

export const TRUSTED_IMAGE_ORIGIN = 'https://test-enabler.oss-cn-hongkong.aliyuncs.com'
export const UNTRUSTED_IMAGE_ORIGIN = 'https://untrusted.example'
export const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+b3xkAAAAASUVORK5CYII=',
  'base64',
)

export function frameImageUrl(frame: string, version: number, target: string): string {
  return new URL(
    `_kettu/image?${new URLSearchParams({ version: String(version), url: target })}`,
    frame,
  ).href
}

/** Keeps the HTTPS URL seen by the policy and sends its network traffic to a local test server. */
export async function imageEndpoints() {
  const hits: string[] = []
  const server = createServer((request, response) => {
    const { pathname, search } = new URL(request.url ?? '/', 'http://test.invalid')
    hits.push(pathname + search)
    if (pathname === '/trusted/redirect.png') {
      response.writeHead(302, { Location: '/untrusted/redirected.png' }).end()
    } else {
      response.writeHead(200, { 'Content-Type': 'image/png' }).end(TEST_PNG)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const realFetch = globalThis.fetch
  const route = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.protocol !== 'https:') return realFetch(request)
    const endpoint = url.origin === TRUSTED_IMAGE_ORIGIN ? 'trusted' : 'untrusted'
    const local = new URL(`/${endpoint}${url.pathname}${url.search}`, `http://127.0.0.1:${port}`)
    const result = await realFetch(new Request(local, request))
    if (result.status === 302) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${UNTRUSTED_IMAGE_ORIGIN}/redirected.png` },
      })
    }
    return result
  })
  const transportRoute = vi
    .spyOn(transport, 'publicImageRequest')
    .mockImplementation((url, signal) => fetch(url, { signal, redirect: 'manual' }))
  return {
    hits,
    async close() {
      transportRoute.mockRestore()
      route.mockRestore()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
