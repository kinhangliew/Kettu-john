import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startThreadService } from '../threads/service'
import { ThreadStoreError, type ThreadStore } from '../threads/store'
import { ArtifactStore, type ArtifactStoreDeps } from './store'
import { ArtifactTools, type Caller } from './tools'
import { ArtifactTypes } from './types/registry'
import { writeContent } from './types/writes'

let dir: string
let work: string
let tools: ArtifactTools
let store: ArtifactStore
let caller: Caller

const IMAGE_ORIGIN = 'https://test-enabler.oss-cn-hongkong.aliyuncs.com'
const OTHER_ORIGIN = 'https://other.example'
const LOCAL_IMAGE = 'images/local.png'

/** The thread service in this thread, answering as the worker would. */
function threadsAt(folder: string): ThreadStore {
  const pending = new Map<number, { resolve(value: unknown): void; reject(e: unknown): void }>()
  let next = 0
  const handle = startThreadService(
    { file: path.join(folder, 'threads.db'), contentDir: path.join(folder, 'content') },
    (reply) => {
      if (reply.type !== 'result' && reply.type !== 'error') return
      const waiting = pending.get(reply.id)
      pending.delete(reply.id)
      if (reply.type === 'result') waiting?.resolve(reply.value)
      else waiting?.reject(new ThreadStoreError(reply.message, reply.code, reply.data))
    },
  )
  const ask =
    (op: 'artifact' | 'runtime') =>
    (name: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = ++next
        pending.set(id, { resolve, reject })
        handle({ id, op, call: { name, params } as never })
      })
  return { artifact: ask('artifact'), runtime: ask('runtime') } as unknown as ThreadStore
}

function openStore(imagePermissions?: ArtifactStoreDeps['imagePermissions']): ArtifactStore {
  return new ArtifactStore({
    threads: threadsAt(dir),
    ...(imagePermissions ? { imagePermissions } : {}),
    contentDir: path.join(dir, 'content'),
    log: () => {},
    changed: () => {},
    version: () => {},
    activity: () => {},
  })
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-artifact-tools-'))
  work = path.join(dir, 'work')
  mkdirSync(path.join(work, 'assets'), { recursive: true })
  writeFileSync(path.join(work, 'app.js'), 'console.log(1)')
  writeFileSync(
    path.join(work, 'assets', 'local.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+b3xkAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  writeFileSync(path.join(dir, 'secret.txt'), 'secret')
  store = openStore()
  tools = new ArtifactTools({ store, sessionTitle: () => 'Session', runningTurn: () => null })
  caller = { sessionId: 's1', project: work }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function call(name: string, input: unknown) {
  const result = await tools.call(caller, name, input)
  return {
    error: result.isError ? (result.structuredContent as { code: string; message: string }) : null,
    value: result.structuredContent as Record<string, unknown>,
    text: result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
  }
}

async function create(input: Record<string, unknown>): Promise<string> {
  const { error, value } = await call('create_artifact', { title: 'Report', ...input })
  expect(error).toBeNull()
  return value.id as string
}

async function count(): Promise<number> {
  return (await store.list({ project: work })).length
}

describe('HTML image packaging', () => {
  it('W01 warns in the successful tool response when the image only exists in the work directory', async () => {
    const { error, value, text } = await call('create_artifact', {
      title: 'Mixed images',
      html: '<img src="assets/local.png">',
    })
    expect(error).toBeNull()
    expect(value.version).toBe(1)
    expect(text).toMatch(/index\.html.*assets\/local\.png/)
    expect(text).toMatch(/source.*update_artifact/)
  })

  it('W02 checks nested HTML against the complete updated version', async () => {
    const id = await create({
      html: '<a href="pages/detail.html">Details</a>',
      files: [
        { path: 'pages/detail.html', content: '<p>Details</p>' },
        { path: 'pages/images/first photo.png', content: 'first' },
        { path: 'pages/images/removed.png', content: 'removed' },
      ],
    })
    const { error, value, text } = await call('update_artifact', {
      id,
      base_version: 1,
      files: [
        {
          path: 'pages/detail.html',
          content:
            '<img src="images/first%20photo.png?rev=1#photo">' +
            '<img src="../images/new%20photo.png#photo"><img src="images/removed.png?rev=2">',
        },
        { path: 'images/new photo.png', content: 'new' },
        { path: 'pages/images/removed.png', remove: true },
      ],
    })
    expect(error).toBeNull()
    expect(value.version).toBe(2)
    expect(text).toMatch(/pages\/detail\.html.*images\/removed\.png\?rev=2/)
    expect(text).not.toMatch(/first%20photo|new%20photo/)
  })

  it.each(['/Users/example/photo.png', 'C:/example/photo.png', 'file:///tmp/p.png', '../p.png'])(
    'W03 reports that %s needs a relative path inside the version',
    async (url) => {
      const { error, text } = await call('create_artifact', {
        title: 'Outside image',
        html: `<img src="${url}">`,
      })
      expect(error).toBeNull()
      expect(text).toContain(url)
      expect(text).toMatch(/relative (?:path|URL)/i)
    },
  )

  it('W04 deduplicates and caps missing image diagnostics without warning about HTTPS images', async () => {
    const urls = Array.from({ length: 10 }, (_, index) => `missing-${index}.png`)
    const { error, text } = await call('create_artifact', {
      title: 'Mixed images',
      html: [urls[0], urls[0], `${IMAGE_ORIGIN}/trusted.png`, ...urls.slice(1)]
        .map((url) => `<img src="${url}">`)
        .join(''),
    })
    expect(error).toBeNull()
    expect(text.match(/missing-\d+\.png/g)).toEqual(urls.slice(0, 8))
    expect(text).not.toContain(IMAGE_ORIGIN)
  })

  it('W05 suppresses static diagnostics only when the base can change relative resolution', async () => {
    const html = '<img src="absent.png">'
    for (const [base, warning] of [
      ['<base href="images/">', false],
      ['<base target="_blank">', true],
    ] as const) {
      const { error, text } = await call('create_artifact', { title: 'Base', html: base + html })
      expect(error).toBeNull()
      expect(text.includes('absent.png')).toBe(warning)
    }
  })
})

function documentInput(markdown: string) {
  return {
    type: 'document',
    title: 'Mixed images',
    files: [
      { path: 'document.md', content: markdown },
      { path: LOCAL_IMAGE, source: 'assets/local.png' },
    ],
  }
}

describe('document image writes', () => {
  it.each([
    ['inline', 'create'],
    ['reference', 'create'],
    ['inline', 'update'],
    ['reference', 'update'],
  ])('W06 keeps mixed %s image references unchanged on %s', async (syntax, operation) => {
    const images = [LOCAL_IMAGE, `${IMAGE_ORIGIN}/t.png?x=1`, `${OTHER_ORIGIN}/u.png`]
    const lines =
      syntax === 'inline'
        ? images.map((url, index) => `![Picture ${index}](${url})`)
        : [
            ...images.map((_, index) => `![Picture ${index}][pic${index}]`),
            '',
            ...images.map((url, index) => `[pic${index}]: ${url}`),
          ]
    const markdown = `# Pictures\n\n${lines.join('\n')}\n`
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected download'))
    try {
      // Even a project with no authorization can write the document.
      if (operation === 'create') {
        const created = await call('create_artifact_from_type', documentInput(markdown))
        expect(created.error, created.error?.message).toBeNull()
        const id = created.value.id as string
        expect((await call('read_artifact', { id, version: 1 })).value.text).toBe(markdown)
      } else {
        const first = await call('create_artifact_from_type', documentInput('# Before\n'))
        expect(first.error, first.error?.message).toBeNull()
        const id = first.value.id as string
        const updated = await call('update_artifact', {
          id,
          base_version: 1,
          files: [{ path: 'document.md', content: markdown }],
        })
        expect(updated.error, updated.error?.message).toBeNull()
        expect((await call('read_artifact', { id, version: 2 })).value.text).toBe(markdown)
      }
      expect(fetch).not.toHaveBeenCalled()
      expect(await store.imageOrigins(work)).toEqual([])
    } finally {
      fetch.mockRestore()
    }
  })

  it.each(['images/missing.png', '../images/outside.png'])(
    'W07 rejects %s and keeps the earlier version readable',
    async (url) => {
      const markdown = `# Before\n\n![Local](${LOCAL_IMAGE})\n`
      const invalid = `# Invalid\n\n![Wrong](${url})\n`
      const created = await call('create_artifact_from_type', documentInput(markdown))
      expect(created.error).toBeNull()
      const id = created.value.id as string
      for (const refused of [
        await call('create_artifact_from_type', documentInput(invalid)),
        await call('update_artifact', {
          id,
          base_version: 1,
          files: [{ path: 'document.md', content: invalid }],
        }),
      ]) {
        expect(refused.error?.code).toBe('invalid')
        expect(refused.error?.message).toContain(`document.md line 3 shows ${url}`)
      }
      const read = await call('read_artifact', { id })
      expect(read.value).toMatchObject({ version: 1, text: markdown })
    },
  )

  it('W07 refuses a supplied SVG as an unsupported format and keeps the earlier version', async () => {
    const svg = { path: 'images/vector.svg', source: 'assets/vector.svg' }
    writeFileSync(
      path.join(work, svg.source),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0h1v1z"/></svg>',
    )
    const markdown = `# Before\n\n![Local](${LOCAL_IMAGE})\n`
    const invalid = `# Invalid\n\n![Vector](${svg.path})\n`
    const first = await call('create_artifact_from_type', documentInput(markdown))
    expect(first.error).toBeNull()
    const id = first.value.id as string
    const draft = documentInput(invalid)
    for (const { error } of [
      await call('create_artifact_from_type', { ...draft, files: [...draft.files, svg] }),
      await call('update_artifact', { id, base_version: 1, files: [...draft.files, svg] }),
    ]) {
      expect(error?.code).toBe('invalid')
      expect(error?.message).toContain(svg.path)
      expect(error?.message).toMatch(/PNG, JPEG or GIF/)
    }
    expect((await call('read_artifact', { id })).value).toMatchObject({
      version: 1,
      text: markdown,
    })
  })

  it.each([
    'http://example.org/a.png',
    '//example.org/a.png',
    'https://user:pass@example.org/a.png',
  ])('W08 rejects %s as a direct image URL', async (url) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected download'))
    try {
      const { error } = await call(
        'create_artifact_from_type',
        documentInput(`# Pictures\n\n![Bad](${url})\n`),
      )
      expect(error?.code).toBe('invalid')
      expect(error?.message).toContain('document.md line 3')
      expect(error?.message.replaceAll(url, '')).toMatch(/\bHTTPS\b/i)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })

  it('W09 reads each version from its saved bytes after the source is moved', async () => {
    const local = path.join(work, 'local.png')
    writeFileSync(local, 'version one')
    const id = await create({
      html: `<img src="${LOCAL_IMAGE}">`,
      files: [{ path: LOCAL_IMAGE, source: 'local.png' }],
    })
    writeFileSync(local, 'version two')
    const { error } = await call('update_artifact', {
      id,
      base_version: 1,
      files: [{ path: LOCAL_IMAGE, source: 'local.png' }],
    })
    expect(error).toBeNull()
    rmSync(local)
    for (const [version, expected] of [
      [1, 'version one'],
      [2, 'version two'],
    ] as const) {
      const found = await store.read(id, { version })
      const image = found.files.find((file) => file.path === LOCAL_IMAGE)!
      expect(Buffer.from(await store.bytes(found, image)).toString()).toBe(expected)
    }
  })
})

describe('project image permissions', () => {
  it('P01 uses an explicit project grant for an existing version', async () => {
    const id = await create({ html: `<img src="${IMAGE_ORIGIN}/t.png">` })
    expect(await store.imageOrigins(work)).toEqual([])
    await store.setImageOrigin(work, IMAGE_ORIGIN, true)
    expect(await store.imageOrigins(work)).toEqual([IMAGE_ORIGIN])
    await expect(store.content(id, 1)).resolves.toMatchObject({ imageOrigins: [IMAGE_ORIGIN] })
  })

  it('P02 stores one canonical origin for paths, query strings, case and port 443', async () => {
    for (const url of [
      IMAGE_ORIGIN,
      `${IMAGE_ORIGIN}/a.png?signature=one`,
      `${IMAGE_ORIGIN.toUpperCase()}:443/b.png?signature=two`,
    ]) {
      await store.setImageOrigin(work, url, true)
    }
    expect(await store.imageOrigins(work)).toEqual([IMAGE_ORIGIN])
  })

  it.each([
    'https://*.example.org',
    'http://example.org',
    'https://',
    '//example.org',
    'https://user:pass@example.org',
  ])('P03 refuses an invalid grant for %s', async (url) => {
    await expect(store.setImageOrigin(work, url, true)).rejects.toMatchObject({
      code: 'invalid_params',
    })
    expect(await store.imageOrigins(work)).toEqual([])
  })

  it('P04 persists across store instances and reaches old and new sessions', async () => {
    const old = await create({ html: '<p>Old session</p>' })
    await store.setImageOrigin(work, IMAGE_ORIGIN, true)
    store = openStore()
    tools = new ArtifactTools({ store, sessionTitle: () => 'Session', runningTurn: () => null })
    caller = { ...caller, sessionId: 's2' }
    const fresh = await create({ html: '<p>New session</p>' })
    for (const id of [old, fresh]) {
      await expect(store.content(id, 1)).resolves.toMatchObject({ imageOrigins: [IMAGE_ORIGIN] })
    }
  })

  it('P05 keeps grants within the owning project even when paths have the same basename', async () => {
    const html = `<img src="${IMAGE_ORIGIN}/t.png">`
    const first = await create({ html })
    const other = path.join(dir, 'elsewhere', 'work')
    mkdirSync(other, { recursive: true })
    caller = { ...caller, project: other }
    const second = await create({ html })
    await store.setImageOrigin(work, IMAGE_ORIGIN, true)
    await expect(store.content(first, 1)).resolves.toMatchObject({ imageOrigins: [IMAGE_ORIGIN] })
    await expect(store.content(second, 1)).resolves.toMatchObject({ imageOrigins: [] })
  })

  it('P06 revokes access when reading a historical version and a new artifact', async () => {
    const old = await create({ html: '<p>First</p>' })
    await store.setImageOrigin(work, IMAGE_ORIGIN, true)
    await expect(store.content(old, 1)).resolves.toMatchObject({ imageOrigins: [IMAGE_ORIGIN] })
    await store.setImageOrigin(work, IMAGE_ORIGIN, false)
    const fresh = await create({ html: '<p>New</p>' })
    for (const id of [old, fresh]) {
      await expect(store.content(id, 1)).resolves.toMatchObject({ imageOrigins: [] })
    }
  })

  it('P08 refuses project image permissions supplied by an artifact author', async () => {
    const html = `<img src="${IMAGE_ORIGIN}/t.png">`
    const id = await create({ html })
    const imageOrigins = [IMAGE_ORIGIN]
    for (const { error } of [
      await call('create_artifact', { title: 'Image', html, imageOrigins }),
      await call('update_artifact', { id, base_version: 1, html, imageOrigins }),
    ]) {
      expect(error?.code).toBe('invalid')
      expect(error?.message).toContain('imageOrigins')
    }
    expect(await store.imageOrigins(work)).toEqual([])
  })

  it.each(['files', 'sample'])(
    'P09 applies the latest %s declaration to both versions',
    async (capability) => {
      const id = await create({ html: '<p>First</p>' })
      await store.setImageOrigin(work, IMAGE_ORIGIN, true)
      const { error } = await call('update_artifact', {
        id,
        base_version: 1,
        capabilities: [capability],
      })
      expect(error).toBeNull()
      for (const version of [1, 2]) {
        await expect(store.content(id, version)).resolves.toMatchObject({
          strict: true,
          imageOrigins: [],
        })
      }
    },
  )

  it('P11 reports persistence errors and serves the saved files without external grants when reading fails', async () => {
    const id = await create({ html: '<p>Local content</p>' })
    const failed = new Error('Permission storage unavailable')
    const permissions = {
      list: vi.fn().mockRejectedValue(failed),
      set: vi.fn().mockRejectedValue(failed),
    }
    const unavailable = openStore(permissions)
    await expect.soft(unavailable.imageOrigins(work)).rejects.toThrow(failed.message)
    expect.soft(permissions.list).toHaveBeenCalledExactlyOnceWith(work)
    for (const allowed of [true, false]) {
      await expect
        .soft(unavailable.setImageOrigin(work, IMAGE_ORIGIN, allowed))
        .rejects.toThrow(failed.message)
      expect.soft(permissions.set).toHaveBeenCalledWith(work, IMAGE_ORIGIN, allowed)
    }
    permissions.list.mockClear()
    const found = await unavailable.content(id, 1)
    expect(found).toMatchObject({
      files: [expect.objectContaining({ path: 'index.html' })],
    })
    expect(found.imageOrigins ?? []).toEqual([])
    expect(permissions.list).toHaveBeenCalledWith(work)
  })
})

describe('the artifact tools', () => {
  it.each([
    ['a path out of it', '../secret.txt'],
    ['an absolute path out of it', '__SECRET__'],
    ['a link inside that points out', 'leak.txt'],
    ['a folder', 'assets'],
    ['a file that is not there', 'missing.png'],
  ])('refuse a source that is %s, and make nothing', async (_, source) => {
    symlinkSync(path.join(dir, 'secret.txt'), path.join(work, 'leak.txt'))
    const given = source === '__SECRET__' ? path.join(dir, 'secret.txt') : source
    const { error } = await call('create_artifact', {
      title: 'Report',
      files: [
        { path: 'index.html', content: '<p>hi</p>' },
        { path: 'data.txt', source: given },
      ],
    })
    expect(error?.code).toBe('invalid')
    expect(await count()).toBe(0)
  })

  it('take a link inside the working directory that stays inside it', async () => {
    symlinkSync(path.join(work, 'app.js'), path.join(work, 'alias.js'))
    const id = await create({ html: '<p>hi</p>', files: [{ path: 'a.js', source: 'alias.js' }] })
    const { value } = await call('read_artifact', { id, path: 'a.js' })
    expect(value.text).toBe('console.log(1)')
  })

  it.each([
    ['_kettu/runtime.js', 'Kettu keeps'],
    ['_kettuish.css', 'Kettu keeps'],
    ['/abs.css', 'relative'],
    ['a/../b.css', '..'],
    ['a\\b.css', 'backslash'],
    ['a//b.css', 'empty segment'],
    ['what?.css', 'backslash'],
  ])('refuse the path %s', async (bad, says) => {
    const { error } = await call('create_artifact', {
      title: 'Report',
      files: [
        { path: 'index.html', content: '<p>hi</p>' },
        { path: bad, content: 'x' },
      ],
    })
    expect(error?.code).toBe('invalid')
    expect(error?.message).toContain(says)
    expect(await count()).toBe(0)
  })
})

describe("the host's records of an artifact", () => {
  it('compares any two of its versions from their stored files', async () => {
    const id = await create({ html: '<p>1</p>', files: [{ path: 'a.css', content: 'a' }] })
    for (const [base, html] of [
      [1, '<p>2</p>'],
      [2, '<p>3</p>'],
    ] as const) {
      const { error } = await call('update_artifact', { id, base_version: base, html })
      expect(error).toBeNull()
    }
    expect(await store.changes(id, 1, 3)).toEqual({ kind: 'files', paths: ['index.html'] })
    expect(await store.changes(id, 3, 1)).toEqual({ kind: 'files', paths: ['index.html'] })
    await expect(store.changes(id, 1, 9)).rejects.toMatchObject({ reason: 'not_found' })
    // Another project's session reaches none of it.
    await expect(store.changes(id, 1, 2, { project: '/elsewhere' })).rejects.toMatchObject({
      reason: 'not_found',
    })
  })
})

describe('the links in the artifact tools results', () => {
  const page = (id: string, file: string, x: number) => ({
    id,
    canvas: 'c1',
    name: id.toUpperCase(),
    file,
    x,
    y: 0,
    width: 390,
    height: 844,
    locked: false,
  })

  it('name every frame on create and read, and the frames a version changed on update', async () => {
    const doc = {
      format: 1,
      canvases: [{ id: 'c1', name: 'Home' }],
      pages: [page('pa', 'a.html', 0), page('pb', 'b.html', 500)],
      notes: [],
    }
    const { error, value } = await call('create_artifact', {
      title: 'App',
      files: [
        { path: 'canvas.json', content: JSON.stringify(doc) },
        { path: 'a.html', content: '<p>a</p>' },
        { path: 'b.html', content: '<p>b</p>' },
      ],
    })
    expect(error).toBeNull()
    const id = value.id as string
    expect(value.link).toBe(`kettu://artifact/${id}`)
    expect(value.places).toEqual([
      { kind: 'frame', name: 'Home · PA', link: `kettu://artifact/${id}/frame/pa` },
      { kind: 'frame', name: 'Home · PB', link: `kettu://artifact/${id}/frame/pb` },
    ])
    expect(value.places_more).toBe(0)
    expect((await call('read_artifact', { id })).value.places).toHaveLength(2)
    const updated = await call('update_artifact', {
      id,
      base_version: 1,
      files: [{ path: 'b.html', content: '<p>b2</p>' }],
    })
    expect(updated.value.places).toEqual([
      { kind: 'frame', name: 'Home · PB', link: `kettu://artifact/${id}/frame/pb` },
    ])
  })

  it("name a document's sections", async () => {
    const { value } = await call('create_artifact_from_type', {
      type: 'document',
      title: 'Plan',
      files: [{ path: 'document.md', content: '# Plan\n\nText.\n\n## Risks\n\nNone.\n' }],
    })
    const id = value.id as string
    expect(value.places).toEqual([
      { kind: 'section', name: 'Plan', link: `kettu://artifact/${id}/section/plan` },
      { kind: 'section', name: 'Risks', link: `kettu://artifact/${id}/section/risks` },
    ])
  })
})

describe('the pieces an agent holds while its turn writes', () => {
  let turn: object | null
  let held: unknown[]

  beforeEach(() => {
    turn = {}
    held = []
    store = new ArtifactStore({
      threads: threadsAt(dir),
      contentDir: path.join(dir, 'content'),
      log: () => {},
      changed: () => {},
      version: () => {},
      activity: (_, activity) => held.push(activity.sessions.map((s) => s.held ?? [])),
      canvasQuietMs: 60_000,
    })
    tools = new ArtifactTools({ store, sessionTitle: () => 'Session', runningTurn: () => turn })
  })

  /** Ends the turn, which lets go of what it held, and starts the next one. */
  function nextTurn(): void {
    store.stopUsing('s1')
    turn = {}
  }

  const page = (id: string, file: string) => ({
    id,
    canvas: 'c1',
    name: id,
    file,
    x: 0,
    y: 0,
    width: 390,
    height: 844,
    locked: false,
  })

  it("refuses the user's edits of a frame the turn wrote, and lets the rest and comments be", async () => {
    const doc = {
      format: 1,
      canvases: [{ id: 'c1', name: 'Home' }],
      pages: [page('pa', 'a.html'), page('pb', 'b.html')],
      notes: [],
    }
    const id = await create({
      files: [
        { path: 'canvas.json', content: JSON.stringify(doc) },
        { path: 'a.html', content: '<p>a</p>' },
        { path: 'b.html', content: '<p>b</p>' },
      ],
    })
    // A new artifact is the turn's whole.
    expect(store.held(id)).toEqual([{ sessionId: 's1', pieces: [{ kind: 'whole' }] }])
    await expect(
      store.canvases.apply(id, [{ op: 'set', id: 'pa', key: 'x', value: 9 }], 'c', 1),
    ).rejects.toMatchObject({ reason: 'conflict' })
    nextTurn()
    expect(store.held(id)).toEqual([])

    const { error } = await call('update_artifact', {
      id,
      base_version: 1,
      files: [{ path: 'b.html', content: '<p>b2</p>' }],
    })
    expect(error).toBeNull()
    expect(store.held(id)).toEqual([
      { sessionId: 's1', pieces: [{ kind: 'frame', id: 'pb', file: 'b.html' }] },
    ])
    const refused = { reason: 'conflict', state: { version: 2, held: [{ sessionId: 's1' }] } }
    await expect(
      store.editElement({
        id,
        baseVersion: 2,
        path: 'b.html',
        offset: 0,
        change: { style: null, text: 'x' },
      }),
    ).rejects.toMatchObject(refused)
    await expect(
      store.canvases.apply(id, [{ op: 'remove', id: 'pb' }], 'c', 2),
    ).rejects.toMatchObject(refused)
    // Removing the sheet would remove the held frame with it.
    await expect(
      store.canvases.apply(id, [{ op: 'remove', id: 'c1' }], 'c', 3),
    ).rejects.toMatchObject(refused)
    // The frame the turn did not write stays the user's.
    await expect(
      store.canvases.apply(id, [{ op: 'set', id: 'pa', key: 'x', value: 9 }], 'c', 4),
    ).resolves.toMatchObject({ seq: expect.any(Number) })
    const anchor = { version: 2, path: 'b.html', page: null, offset: null, tag: null, text: '' }
    await expect(
      store.addThread(id, {
        anchor: { ...anchor, missing: false },
        author: { person: 'owner', session: null },
        body: 'Nice',
      }),
    ).resolves.toMatchObject({ comments: [{ body: 'Nice' }] })

    nextTurn()
    await expect(
      store.canvases.apply(id, [{ op: 'remove', id: 'pb' }], 'c', 5),
    ).resolves.toMatchObject({ seq: expect.any(Number) })
  })

  it("refuses the user's edits of a section the turn wrote, by what the edit changes", async () => {
    const types = new ArtifactTypes()
    const { value } = await call('create_artifact_from_type', {
      type: 'document',
      title: 'Plan',
      files: [{ path: 'document.md', content: '# Plan\n\nText.\n\n## Risks\n\nNone.\n' }],
    })
    const id = value.id as string
    nextTurn()
    await store.watch(id, 'port')
    const { error } = await call('update_artifact', {
      id,
      base_version: 1,
      files: [{ path: 'document.md', content: '# Plan\n\nText.\n\n## Risks\n\nSome.\n' }],
    })
    expect(error).toBeNull()
    expect(store.held(id)[0]?.pieces).toEqual([{ kind: 'section', slug: 'risks' }])
    expect(held.at(-1)).toEqual([[{ kind: 'section', slug: 'risks' }]])

    await expect(
      writeContent(store, types, {
        id,
        baseVersion: 2,
        text: '# Plan\n\nText.\n\n## Risks\n\nMany.\n',
      }),
    ).rejects.toMatchObject({ reason: 'conflict', english: expect.stringContaining('turn') })
    await expect(
      writeContent(store, types, {
        id,
        baseVersion: 2,
        text: '# Plan\n\nMore text.\n\n## Risks\n\nSome.\n',
      }),
    ).resolves.toEqual({ version: 3 })
  })

  it('holds the slides a turn wrote, one removed from the end included', async () => {
    const types = new ArtifactTypes()
    const deck = (...titles: string[]) =>
      JSON.stringify({ slides: titles.map((title) => ({ layout: 'title', title })) })
    const { value, error } = await call('create_artifact_from_type', {
      type: 'slides',
      title: 'Deck',
      files: [{ path: 'slides.json', content: deck('A', 'B', 'C') }],
    })
    expect(error).toBeNull()
    const id = value.id as string
    nextTurn()
    await call('update_artifact', {
      id,
      base_version: 1,
      files: [{ path: 'slides.json', content: deck('A', 'B', 'C2') }],
    })
    expect(store.held(id)[0]?.pieces).toEqual([{ kind: 'slide', number: 3 }])
    await expect(
      writeContent(store, types, { id, baseVersion: 2, text: deck('A', 'B') }),
    ).rejects.toMatchObject({ reason: 'conflict' })
    await expect(
      writeContent(store, types, { id, baseVersion: 2, text: deck('A2', 'B', 'C2') }),
    ).resolves.toEqual({ version: 3 })
  })
})

describe('pinning a thread again', () => {
  it('keeps the thread with its new anchor, found again from then on', async () => {
    const id = await create({ html: '<h1>Title</h1><p>Body</p>' })
    const anchor = {
      version: 1,
      path: 'index.html',
      page: null,
      offset: null,
      tag: null,
      text: '',
      missing: false,
    }
    const thread = await store.addThread(id, {
      anchor,
      author: { person: 'owner', session: null },
      body: 'Shorter',
    })
    const placed = await store.repin(id, thread.id, {
      ...anchor,
      offset: 0,
      tag: 'h1',
      text: 'Title',
      missing: true,
    })
    expect(placed.anchor).toMatchObject({ offset: 0, tag: 'h1', missing: false })
    const [kept] = await store.threads(id)
    expect(kept).toMatchObject({ id: thread.id, anchor: { offset: 0, tag: 'h1', missing: false } })
    expect(kept?.comments).toHaveLength(1)
    await expect(store.repin(id, 'thr_01J9Z3K4V5W6X7Y8Z9A0B1C2D3', anchor)).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('a thread whose element a version removed', () => {
  it('is looked for again in each new version, and placed once the element is back', async () => {
    const id = await create({ html: '<h1>Title</h1><p>Body</p>' })
    const thread = await store.addThread(id, {
      anchor: {
        version: 1,
        path: 'index.html',
        page: null,
        offset: 14,
        tag: 'p',
        text: 'Body',
        missing: false,
      },
      author: { person: 'owner', session: null },
      body: 'Shorter',
    })
    await call('update_artifact', { id, base_version: 1, html: '<h1>Title</h1>' })
    const [gone] = await store.threads(id)
    expect(gone?.anchor).toMatchObject({ version: 2, missing: true })

    // A version that still lacks the element is recorded once, not on every read.
    await call('update_artifact', { id, base_version: 2, html: '<h1>Other</h1>' })
    await store.threads(id)
    const calls: string[] = []
    const threads = (store as unknown as { deps: { threads: ThreadStore } }).deps.threads
    const artifact = threads.artifact
    threads.artifact = ((name: string, params: unknown) => {
      calls.push(name)
      return artifact(name as never, params as never)
    }) as ThreadStore['artifact']
    const [still] = await store.threads(id)
    expect(still?.anchor).toMatchObject({ version: 3, missing: true })
    expect(calls).not.toContain('reanchor')

    await store.restore({ id, version: 1, baseVersion: 3, author: null })
    const [back] = await store.threads(id)
    expect(back).toMatchObject({
      id: thread.id,
      anchor: { version: 4, offset: 14, tag: 'p', text: 'Body', missing: false },
    })
    const [stored] = await store.threads(id)
    expect(stored?.anchor).toMatchObject({ version: 4, offset: 14, missing: false })
  })
})

describe('a thread in a frame the canvas no longer lists', () => {
  it('is marked removed though the file stays, and placed once the frame is back', async () => {
    const page = (id: string, file: string) => ({
      id,
      canvas: 'c1',
      name: id,
      file,
      x: 0,
      y: 0,
      width: 390,
      height: 844,
      locked: false,
    })
    const doc = {
      format: 1,
      canvases: [{ id: 'c1', name: 'Home' }],
      pages: [page('pa', 'a.html'), page('pb', 'b.html')],
      notes: [],
    }
    const id = await create({
      files: [
        { path: 'canvas.json', content: JSON.stringify(doc) },
        { path: 'a.html', content: '<p>a</p>' },
        { path: 'b.html', content: '<h1>B</h1><p>Body</p>' },
      ],
    })
    const anchor = { version: 1, page: null, missing: false }
    const author = { person: 'owner' as const, session: null }
    const inB = await store.addThread(id, {
      anchor: { ...anchor, path: 'b.html', offset: 10, tag: 'p', text: 'Body' },
      author,
      body: 'Shorter',
    })
    const inA = await store.addThread(id, {
      anchor: { ...anchor, path: 'a.html', offset: 0, tag: 'p', text: 'a' },
      author,
      body: 'Longer',
    })
    const removed = await call('update_artifact', {
      id,
      base_version: 1,
      canvas: [{ op: 'remove', id: 'pb' }],
    })
    expect(removed.error).toBeNull()
    const found = await store.get(id)
    expect(found.files.map((f) => f.path)).toContain('b.html')

    const gone = await store.threads(id)
    expect(gone.find((t) => t.id === inB.id)?.anchor).toMatchObject({ version: 2, missing: true })
    expect(gone.find((t) => t.id === inA.id)?.anchor).toMatchObject({
      version: 2,
      offset: 0,
      missing: false,
    })

    await store.restore({ id, version: 1, baseVersion: 2, author: null })
    const back = await store.threads(id)
    expect(back.find((t) => t.id === inB.id)?.anchor).toMatchObject({
      version: 3,
      offset: 10,
      missing: false,
    })
  })
})
