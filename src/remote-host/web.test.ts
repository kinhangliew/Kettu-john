import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HandshakeLimits } from './limits'
import { WebServer } from './web'

const TOKEN = 'A'.repeat(43)
const IMAGE_ORIGIN = 'https://test-enabler.oss-cn-hongkong.aliyuncs.com'
const OTHER_ORIGIN = 'https://other.example'
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

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-web-frames-'))
  const files: Record<string, string> = {
    'index.html': '<!doctype html><html><head></head><body><p>hi</p></body></html>',
    'style.css': 'p{}',
    [LOCAL_IMAGE]: 'local image bytes',
  }
  mkdirSync(path.join(dir, 'images'))
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
  asked = []
  strict = false
  typed = false
  active = true
  imageOrigins = []
  web = new WebServer({
    root: null,
    server: {
      accept: () => {},
      refusedOne: () => {},
      frameFile: async (token, version, wanted) => {
        asked.push({ version, path: wanted })
        const text = active && token === TOKEN ? files[wanted] : undefined
        return text === undefined
          ? null
          : { file: path.join(dir, wanted), size: text.length, strict, imageOrigins }
      },
      frameType: async (token, version) =>
        active && token === TOKEN && typed
          ? { type: { name: 'document', format: 1 }, version: version ?? 2, strict, imageOrigins }
          : null,
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

describe("the direct port's artifact frames", () => {
  it.each(['HTML', 'document'])(
    'V03/V04/V07/V08 scopes the %s frame to its token and current image permission',
    async (format) => {
      typed = format === 'document'
      const folder = `${base}/frame/${TOKEN}/_kettu/v/1`
      const readPolicy = async () => {
        const page = await fetch(`${folder}/index.html`)
        expect(page.status).toBe(200)
        expect(page.headers.get('cache-control')).toBe('no-store')
        const local = await fetch(`${folder}/${LOCAL_IMAGE}`)
        expect(local.status).toBe(200)
        expect(local.headers.get('content-type')).toBe('image/png')
        expect(await local.text()).toBe('local image bytes')
        const csp = page.headers.get('content-security-policy')!
        expect(csp).not.toContain(OTHER_ORIGIN)
        return csp.split('; ').filter((directive) => directive.includes(IMAGE_ORIGIN))
      }
      expect(await readPolicy()).toEqual([])
      imageOrigins = [IMAGE_ORIGIN]
      expect(await readPolicy()).toEqual([expect.stringMatching(/^img-src /)])
      imageOrigins = []
      expect(await readPolicy()).toEqual([])
      expect(
        await fetch(`${base}/frame/${'Z'.repeat(43)}/_kettu/v/1/${LOCAL_IMAGE}`).then(
          (r) => r.status,
        ),
      ).toBe(404)
      active = false
      expect(await fetch(`${folder}/${LOCAL_IMAGE}`).then((r) => r.status)).toBe(404)
    },
  )

  it.each(['HTML', 'document'])(
    'P09 keeps every %s frame strict from its first load',
    async (format) => {
      typed = format === 'document'
      strict = true
      imageOrigins = [IMAGE_ORIGIN]
      for (const version of [1, 2]) {
        const folder = `${base}/frame/${TOKEN}/_kettu/v/${version}`
        const page = await fetch(`${folder}/index.html`)
        expect(page.status).toBe(200)
        expect(page.headers.get('content-security-policy')).not.toMatch(/https:/)
        expect(await fetch(`${folder}/${LOCAL_IMAGE}`).then((r) => r.text())).toBe(
          'local image bytes',
        )
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
