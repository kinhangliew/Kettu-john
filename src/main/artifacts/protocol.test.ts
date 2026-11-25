import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ERROR_MESSAGE_CHARS,
  MESSAGE_BYTES,
  type PageErrorMessage,
  type SelectMessage,
} from '@shared/artifact-runtime/page-messages'
import type { RuntimeAnswer } from '@shared/artifact-capabilities'
import type { ArtifactContentFile } from '@shared/host-control'
import {
  frameImageUrl,
  imageEndpoints,
  TEST_PNG,
  TRUSTED_IMAGE_ORIGIN as IMAGE_ORIGIN,
  UNTRUSTED_IMAGE_ORIGIN as OTHER_ORIGIN,
} from '../../testing/artifact-images'
import { ARTIFACT_CSP, ARTIFACT_STRICT_CSP } from './policy'
import { respond, type ArtifactSource } from './protocol'
import { readBody, type RuntimeRelay } from './runtime'

const HOST = '0123456789abcdef0123456789'
const ORIGIN = `kettu-artifact://${HOST}`
const ID = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'

let dir: string
let asked: (number | null)[]
let source: ArtifactSource
let picks: { host: string; message: SelectMessage }[]
let strict: boolean

function file(name: string, bytes: string | Buffer): ArtifactContentFile {
  const at = path.join(dir, 'content', name)
  mkdirSync(path.dirname(at), { recursive: true })
  writeFileSync(at, bytes)
  return { path: name, file: at, size: Buffer.byteLength(bytes) }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-protocol-'))
  asked = []
  picks = []
  strict = false
  const outside = path.join(dir, 'outside.txt')
  writeFileSync(outside, 'secret')
  const files = [
    file('index.html', '<html><head></head><body><section data-page="A"></section></body></html>'),
    file('styles/app.css', 'p{}'),
    file('img/my photo.png', Buffer.from([0x89, 0x50])),
    file('data.bin', Buffer.from([0, 1, 2])),
    { path: 'leak.txt', file: outside, size: 6 },
  ]
  source = {
    contentDir: path.join(dir, 'content'),
    artifactOf: (host) => (host === HOST ? ID : undefined),
    content: async (_, version) => {
      asked.push(version)
      return { kind: 'found', version: version ?? 3, title: 'T', key: 'k', strict, files }
    },
    selected: (host, message) => picks.push({ host, message }),
  }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const get = (url: string) => respond(new Request(url), source)

describe('the artifact protocol', () => {
  it("serves a version's files under its path, each with its type and the artifact policy", async () => {
    const page = await get(`${ORIGIN}/_kettu/v/2/index.html`)
    expect(page.status).toBe(200)
    expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    const css = await get(`${ORIGIN}/_kettu/v/2/styles/app.css`)
    expect(css.headers.get('Content-Type')).toBe('text/css; charset=utf-8')
    expect(await css.text()).toBe('p{}')
    expect(asked).toEqual([2, 2])
  })

  it('serves an unknown type as bytes the page may not sniff, and decodes escaped paths', async () => {
    const bin = await get(`${ORIGIN}/data.bin`)
    expect(bin.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(bin.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const image = await get(`${ORIGIN}/_kettu/v/1/img/my%20photo.png`)
    expect(image.status).toBe(200)
    expect(image.headers.get('Content-Type')).toBe('image/png')
  })

  it.each([
    '/missing.css',
    '/_kettu/runtime.js',
    '/_kettu/v/0/index.html',
    '/_kettu/v/x/index.html',
    '/_kettu/v/2',
    '/styles/../../outside.txt',
    '/%E0%A4%A.css',
    '/leak.txt',
  ])('answers %s with not found', async (pathname) => {
    expect((await get(`${ORIGIN}${pathname}`)).status).toBe(404)
  })

  it('refuses another origin and any method but GET', async () => {
    expect((await get('kettu-artifact://ffffffffffffffffffffffffff/')).status).toBe(404)
    expect((await respond(new Request(`${ORIGIN}/`, { method: 'POST' }), source)).status).toBe(405)
  })
})

const post = (body: string, url = `${ORIGIN}/_kettu/v1`) =>
  respond(new Request(url, { method: 'POST', body }), source)

const pick = {
  v: 1,
  id: 'k1',
  kind: 'select',
  channel: 'abcdefgh12',
  selection: {
    path: 'index.html',
    src: 26,
    tag: 'section',
    text: 'A\n  page',
    textOnly: true,
    style: { color: '#FFFFFF', fontSize: 12.5, textAlign: 'center', padding: [0, 14, 0, 14] },
  },
}

describe('the page runtime on an artifact origin', () => {
  it.each([
    ['text that is not JSON', 'not json'],
    ['another version', JSON.stringify({ ...pick, v: 2 })],
    ['a pick without a channel', JSON.stringify({ ...pick, channel: 'x' })],
    [
      'a pick in a file that is not HTML',
      JSON.stringify({ ...pick, selection: { ...pick.selection, path: 'a.css' } }),
    ],
    [
      'a pick of a path outside',
      JSON.stringify({ ...pick, selection: { ...pick.selection, path: '../a.html' } }),
    ],
    [
      'a pick with a tag that is no name',
      JSON.stringify({ ...pick, selection: { ...pick.selection, tag: '<b>' } }),
    ],
    [
      'a pick at no whole offset',
      JSON.stringify({ ...pick, selection: { ...pick.selection, src: 1.5 } }),
    ],
    ['a message too large', JSON.stringify({ ...pick, pad: 'x'.repeat(MESSAGE_BYTES) })],
  ])('refuses %s', async (_, body) => {
    expect((await post(body)).status).toBe(400)
    expect(picks).toEqual([])
  })

  it("passes a page's own error on, as plain data capped in length", async () => {
    const errors: PageErrorMessage[] = []
    source.pageError = (_, message) => errors.push(message)
    const report = {
      v: 1,
      id: 'k2',
      kind: 'page-error',
      path: 'index.html',
      load: 'abcdefgh12',
      error: {
        kind: 'error',
        message: `TypeError: <b>x</b>\n${'y'.repeat(1000)}`,
        source: '/_kettu/v/3/app.js',
        line: 12,
        column: -1,
      },
    }
    expect((await post(JSON.stringify(report))).status).toBe(200)
    expect(errors).toHaveLength(1)
    const [error] = errors
    expect(error!.error.message).toHaveLength(ERROR_MESSAGE_CHARS)
    expect(error!.error.message.startsWith('TypeError: <b>x</b> yyy')).toBe(true)
    expect(error!.error).toMatchObject({ source: '/_kettu/v/3/app.js', line: 12, column: null })
    for (const bad of [
      { ...report, path: '../x.html' },
      { ...report, load: 'short' },
      { ...report, error: 'boom' },
    ]) {
      expect((await post(JSON.stringify(bad))).status).toBe(400)
    }
    expect(errors).toHaveLength(1)
    expect(picks).toEqual([])
  })

  it('takes messages only by POST, and only on an origin it serves', async () => {
    expect((await get(`${ORIGIN}/_kettu/v1`)).status).toBe(405)
    const other = await post(
      JSON.stringify(pick),
      'kettu-artifact://ffffffffffffffffffffffffff/_kettu/v1',
    )
    expect(other.status).toBe(404)
    expect(picks).toEqual([])
  })
})

describe("an artifact's policy", () => {
  it.each([null, { name: 'document' as const, format: 1 }])(
    'P06/V01/V02 checks current permissions for image requests from the same desktop origin for %j',
    async (type) => {
      const content = source.content
      let imageOrigins: string[] = []
      source.content = async (id, version) => {
        const result = await content(id, version)
        return result.kind === 'found' ? { ...result, type, imageOrigins } : result
      }
      const upstream = await imageEndpoints()
      try {
        const response = await get(`${ORIGIN}/_kettu/v/2/index.html`)
        expect(response.status).toBe(200)
        await response.text()
        const local = async () => {
          const image = await get(`${ORIGIN}/_kettu/v/2/img/my%20photo.png`)
          expect(image.headers.get('content-type')).toBe('image/png')
          expect(await image.arrayBuffer()).toEqual(Uint8Array.of(0x89, 0x50).buffer)
        }
        const request = (target: string) =>
          respond(
            new Request(frameImageUrl(`${ORIGIN}/`, 2, target), {
              headers: { 'Sec-Fetch-Dest': 'image' },
            }),
            source,
          )
        const trusted = `${IMAGE_ORIGIN}/t.png`
        const denied = async (target: string) => {
          const before = [...upstream.hits]
          expect((await request(target)).ok).toBe(false)
          expect(upstream.hits).toEqual(before)
        }
        await local()
        await denied(trusted)
        imageOrigins = [IMAGE_ORIGIN]
        const allowed = await request(trusted)
        expect.soft(allowed.status).toBe(200)
        expect.soft(allowed.headers.get('content-type')).toBe('image/png')
        expect.soft(Buffer.from(await allowed.arrayBuffer())).toEqual(TEST_PNG)
        expect.soft(upstream.hits).toEqual(['/trusted/t.png'])
        await denied(`${OTHER_ORIGIN}/u.png`)
        imageOrigins = []
        await denied(trusted)
        await local()
        expect(asked.every((version) => version === 2)).toBe(true)
      } finally {
        await upstream.close()
      }
    },
  )

  it('keeps the CDNs out of the pages of an artifact that declares reading beyond it', async () => {
    const declared: [string, boolean][] = []
    source.declared = (id, value) => declared.push([id, value])
    const loose = await get(`${ORIGIN}/`)
    expect(loose.headers.get('Content-Security-Policy')).toBe(ARTIFACT_CSP)
    strict = true
    const tight = await get(`${ORIGIN}/styles/app.css`)
    expect(tight.headers.get('Content-Security-Policy')).toBe(ARTIFACT_STRICT_CSP)
    expect(declared).toEqual([
      [ID, false],
      [ID, true],
    ])
  })
})

describe("the runtime's requests", () => {
  let sent: { artifactId: string; message: unknown }[]
  let reading: string[]
  let answers: (message: { id: string }) => RuntimeAnswer[]

  beforeEach(() => {
    sent = []
    reading = []
    answers = (message) => [{ v: 1, id: message.id, ok: true, value: { ops: ['get'] } }]
    const relay: RuntimeRelay = {
      send(artifactId, message, answer) {
        sent.push({ artifactId, message })
        // The host's answers arrive later, as over the port.
        setTimeout(() => {
          for (const a of answers(message as { id: string })) answer(a)
        }, 0)
        return () => {}
      },
      reading: (artifactId) => reading.push(artifactId),
    }
    source.runtime = relay
  })

  const post = (message: unknown, origin: string | null = ORIGIN) =>
    respond(
      new Request(`${ORIGIN}/_kettu/v1`, {
        method: 'POST',
        body: JSON.stringify(message),
        headers: origin ? { Origin: origin } : {},
      }),
      source,
    )

  it('passes a message to the host with the artifact its origin names', async () => {
    const response = await post({ v: 1, id: 'u1', kind: 'use', cap: 'db' })
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Security-Policy')).toBe(ARTIFACT_STRICT_CSP)
    expect(await response.json()).toEqual({ v: 1, id: 'u1', ok: true, value: { ops: ['get'] } })
    expect(sent).toEqual([{ artifactId: ID, message: { v: 1, id: 'u1', kind: 'use', cap: 'db' } }])
    expect(reading).toEqual([])
  })

  it('marks the origin as reading beyond it once a page asks for files or sample', async () => {
    await post({ v: 1, id: 'u1', kind: 'use', cap: 'files' })
    await post({ v: 1, id: 'u2', kind: 'use', cap: 'sample' })
    expect(reading).toEqual([ID, ID])
  })

  it('refuses a request from another origin, and every method but POST', async () => {
    const other = await post(
      { v: 1, id: 'u1', kind: 'use', cap: 'db' },
      'kettu-artifact://ffffffffffffffffffffffffff',
    )
    expect(other.status).toBe(404)
    expect((await post({ v: 1, id: 'u1', kind: 'use', cap: 'db' }, 'null')).status).toBe(404)
    expect((await get(`${ORIGIN}/_kettu/v1`)).status).toBe(405)
    expect(sent).toEqual([])
  })

  it('reads a body only up to the limit', async () => {
    const body = (text: string) =>
      new Request(`${ORIGIN}/_kettu/v1`, { method: 'POST', body: text })
    expect(await readBody(body('x'.repeat(10)), 10)).toBe('x'.repeat(10))
    expect(await readBody(body('x'.repeat(11)), 10)).toBeNull()
  })
})
