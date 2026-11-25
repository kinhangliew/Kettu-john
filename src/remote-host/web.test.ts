import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  frameImageUrl,
  imageEndpoints,
  TEST_PNG,
  TRUSTED_IMAGE_ORIGIN as IMAGE_ORIGIN,
  UNTRUSTED_IMAGE_ORIGIN as OTHER_ORIGIN,
} from '../testing/artifact-images'
import { HandshakeLimits } from './limits'
import { WebServer } from './web'

const TOKEN = 'A'.repeat(43)
const LOCAL_IMAGE = 'images/local.png'

let dir: string
let listener: Server
let web: WebServer
let base: string
let asked: { version: number | null; path: string }[]
let strict: boolean
let typed: boolean
let imageOrigins: string[]
let active: boolean
let connected: boolean
let permissionsReadable: boolean

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-web-frames-'))
  const files: Record<string, string> = {
    'index.html': '<!doctype html><html><head></head><body><p>hi</p></body></html>',
    'style.css': 'p{}',
  }
  mkdirSync(path.join(dir, 'images'))
  writeFileSync(path.join(dir, LOCAL_IMAGE), TEST_PNG)
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
  asked = []
  strict = false
  typed = false
  active = true
  connected = true
  permissionsReadable = true
  imageOrigins = []
  const live = (token: string) => active && connected && token === TOKEN
  web = new WebServer({
    root: null,
    server: {
      accept: () => {},
      refusedOne: () => {},
      frameFile: async (token, version, wanted) => {
        asked.push({ version, path: wanted })
        const size = wanted === LOCAL_IMAGE ? TEST_PNG.length : files[wanted]?.length
        return !live(token) || size === undefined
          ? null
          : { file: path.join(dir, wanted), size, strict, imageOrigins }
      },
      frameType: async (token, version) =>
        live(token) && typed
          ? { type: { name: 'document', format: 1 }, version: version ?? 2, strict, imageOrigins }
          : null,
      frameImagePolicy: async (token, version) => {
        if (!live(token) || (version !== 1 && version !== 2)) return null
        if (!permissionsReadable) throw new Error('Image permission lookup failed')
        return { strict, imageOrigins }
      },
    },
    limits: new HandshakeLimits(),
    log: () => {},
  })
  listener = createServer((socket) => web.take(socket))
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const address = listener.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterEach(async () => {
  web.endAll()
  await new Promise((resolve) => listener.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

function getFrameImage(frame: string, target: string, destination = 'image', version = 1) {
  return fetch(frameImageUrl(frame, version, target), {
    headers: { 'Sec-Fetch-Dest': destination },
    redirect: 'manual',
  })
}

describe("the direct port's artifact frames", () => {
  it.each(['HTML', 'document'])(
    'P06/P10/V03–V04/V07–V08 checks every image request of the same direct %s frame',
    async (format) => {
      typed = format === 'document'
      const upstream = await imageEndpoints()
      try {
        const frame = `${base}/frame/${TOKEN}/`
        const folder = `${frame}_kettu/v/1`
        const page = await fetch(`${folder}/index.html`)
        expect(page.status).toBe(200)
        await page.text()
        const local = async () => {
          const response = await fetch(`${folder}/${LOCAL_IMAGE}`)
          expect(response.headers.get('content-type')).toBe('image/png')
          expect(Buffer.from(await response.arrayBuffer())).toEqual(TEST_PNG)
        }
        const denied = async (target: string, from = frame) => {
          const before = [...upstream.hits]
          const response = await getFrameImage(from, target)
          expect(response.ok).toBe(false)
          await response.arrayBuffer()
          expect(upstream.hits).toEqual(before)
        }
        const trusted = `${IMAGE_ORIGIN}/t.png`
        const untrusted = `${OTHER_ORIGIN}/u.png`

        await local()
        await denied(trusted)
        await denied(untrusted)

        imageOrigins = [IMAGE_ORIGIN]
        const allowed = await getFrameImage(frame, trusted)
        expect.soft(allowed.status).toBe(200)
        expect.soft(allowed.headers.get('content-type')).toBe('image/png')
        expect.soft(allowed.headers.get('cache-control')).toContain('no-store')
        expect.soft(Buffer.from(await allowed.arrayBuffer())).toEqual(TEST_PNG)
        expect.soft(upstream.hits).toEqual(['/trusted/t.png'])
        await denied(untrusted)
        const fake = `${base}/frame/${'Z'.repeat(43)}/`
        await denied(trusted, fake)
        expect(await fetch(`${fake}_kettu/v/1/${LOCAL_IMAGE}`).then((r) => r.status)).toBe(404)

        permissionsReadable = false
        await denied(trusted)
        await local()
        permissionsReadable = true

        imageOrigins = []
        await denied(trusted)
        await denied(untrusted)
        await local()

        imageOrigins = [IMAGE_ORIGIN]
        connected = false
        await denied(trusted)
        await denied(untrusted)
        expect(await fetch(`${folder}/${LOCAL_IMAGE}`).then((r) => r.ok)).toBe(false)
        connected = true
        active = false
        await denied(trusted)
        expect(await fetch(`${folder}/${LOCAL_IMAGE}`).then((r) => r.ok)).toBe(false)
      } finally {
        await upstream.close()
      }
    },
  )

  it('P07 checks an HTTP redirect before making the next outbound request', async () => {
    const upstream = await imageEndpoints()
    try {
      const frame = `${base}/frame/${TOKEN}/`
      imageOrigins = [IMAGE_ORIGIN]
      const page = await fetch(`${frame}_kettu/v/1/index.html`)
      expect(page.status).toBe(200)
      await page.text()
      const imageSources = page.headers
        .get('content-security-policy')
        ?.split(';')
        .find((part) => part.trim().startsWith('img-src '))
        ?.trim()
        .split(/\s+/)
      expect(imageSources).toBeDefined()
      for (const source of [IMAGE_ORIGIN, OTHER_ORIGIN, 'https:', '*']) {
        expect(imageSources).not.toContain(source)
      }
      const result = await getFrameImage(frame, `${IMAGE_ORIGIN}/redirect.png`)
      expect(result.ok).toBe(false)
      expect(result.headers.has('location')).toBe(false)
      expect(upstream.hits).toEqual(['/trusted/redirect.png'])
    } finally {
      await upstream.close()
    }
  })

  it.each([
    'https://oss-cn-hongkong.aliyuncs.com/t.png',
    'https://sibling.oss-cn-hongkong.aliyuncs.com/t.png',
    'https://child.test-enabler.oss-cn-hongkong.aliyuncs.com/t.png',
    'https://test-enabler.oss-cn-hongkong.aliyuncs.com.example.org/t.png',
    `${IMAGE_ORIGIN}:8443/t.png`,
  ])('P03 a granted origin cannot extend the live request to %s', async (target) => {
    const upstream = await imageEndpoints()
    try {
      const frame = `${base}/frame/${TOKEN}/`
      imageOrigins = [IMAGE_ORIGIN]
      const allowed = await getFrameImage(frame, `${IMAGE_ORIGIN}/t.png`)
      expect.soft(allowed.status).toBe(200)
      await allowed.arrayBuffer()
      const denied = await getFrameImage(frame, target)
      expect(denied.ok).toBe(false)
      expect(upstream.hits).toEqual(['/trusted/t.png'])
    } finally {
      await upstream.close()
    }
  })

  it.each(['script', 'style', 'font', 'video', 'iframe', 'empty'])(
    'P08 image permission does not authorize a %s request',
    async (destination) => {
      const upstream = await imageEndpoints()
      try {
        const frame = `${base}/frame/${TOKEN}/`
        const trusted = `${IMAGE_ORIGIN}/t.png`
        imageOrigins = [IMAGE_ORIGIN]
        const allowed = await getFrameImage(frame, trusted)
        expect.soft(allowed.status).toBe(200)
        await allowed.arrayBuffer()
        const denied = await getFrameImage(frame, trusted, destination)
        expect(denied.ok).toBe(false)
        expect(upstream.hits).toEqual(['/trusted/t.png'])
      } finally {
        await upstream.close()
      }
    },
  )

  it.each(['HTML', 'document'])(
    'P09 keeps every %s frame strict from its first load',
    async (format) => {
      typed = format === 'document'
      strict = true
      imageOrigins = [IMAGE_ORIGIN]
      const upstream = await imageEndpoints()
      try {
        const frame = `${base}/frame/${TOKEN}/`
        for (const version of [1, 2]) {
          const folder = `${frame}_kettu/v/${version}`
          const page = await fetch(`${folder}/index.html`)
          expect(page.status).toBe(200)
          await page.text()
          expect.soft(page.headers.get('content-security-policy')).not.toMatch(/https:/)
          const local = await fetch(`${folder}/${LOCAL_IMAGE}`)
          expect(Buffer.from(await local.arrayBuffer())).toEqual(TEST_PNG)
          const external = await getFrameImage(frame, `${IMAGE_ORIGIN}/t.png`, 'image', version)
          expect(external.ok).toBe(false)
          await external.arrayBuffer()
        }
        expect(upstream.hits).toEqual([])
      } finally {
        await upstream.close()
      }
    },
  )

  it("serves a frame's files with their types, sandboxed to the frame's own folder", async () => {
    const page = await fetch(`${base}/frame/${TOKEN}/_kettu/v/2/index.html?page=0.1`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await page.text()).toContain('<style>')
    const csp = page.headers.get('content-security-policy')!
    expect(csp).toMatch(/^sandbox allow-scripts /)
    const own = `${new URL(base).host}/frame/${TOKEN}/`
    expect(csp).toContain(`script-src ${own} 'unsafe-inline'`)
    expect(csp).toContain(`connect-src ${own} `)
    expect(csp).not.toContain("'self' ")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(page.headers.get('access-control-allow-origin')).toBeNull()
    const css = await fetch(`${base}/frame/${TOKEN}/style.css`, { headers: { Origin: 'null' } })
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(css.headers.get('x-content-type-options')).toBe('nosniff')
    expect(css.headers.get('access-control-allow-origin')).toBe('null')
    expect(css.headers.get('cross-origin-resource-policy')).toBeNull()
    expect(await css.text()).toBe('p{}')
    expect(asked).toEqual([
      { version: 2, path: 'index.html' },
      { version: null, path: 'style.css' },
    ])
  })

  it('names no CDN in the frames of an artifact that reads beyond it', async () => {
    const loose = await fetch(`${base}/frame/${TOKEN}/index.html`)
    expect(loose.headers.get('content-security-policy')).toContain('https://cdn.jsdelivr.net')
    strict = true
    const tight = (await fetch(`${base}/frame/${TOKEN}/index.html`)).headers.get(
      'content-security-policy',
    )!
    expect(tight).toMatch(/^sandbox allow-scripts /)
    expect(tight).not.toContain('https:')
    expect(tight).toContain(`connect-src ${new URL(base).host}/frame/${TOKEN}/;`)
  })

  it.each([
    `/frame/${'B'.repeat(43)}/index.html`,
    `/frame/${TOKEN}/missing.css`,
    `/frame/${TOKEN}/_kettu/runtime.js`,
  ])('answers %s with not found, which the frame may read', async (pathname) => {
    const missing = await fetch(`${base}${pathname}`, { headers: { Origin: 'null' } })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('access-control-allow-origin')).toBe('null')
  })
})
