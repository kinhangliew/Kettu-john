import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_CDNS,
  ARTIFACT_CSP,
  ARTIFACT_STRICT_CSP,
  artifactHeaders,
  mayRequest,
  WINDOW_PROXY,
} from './policy'

const HOST = '0123456789abcdef0123456789'
const IMAGE_ORIGIN = 'https://test-enabler.oss-cn-hongkong.aliyuncs.com'
const IMAGE = `${IMAGE_ORIGIN}/t.png`
const granted = { resourceType: 'image', origins: [IMAGE_ORIGIN] }

describe('mayRequest', () => {
  it.each([
    `kettu-artifact://${HOST}/`,
    `kettu-artifact://${HOST}/index.html?v=2`,
    'data:image/png;base64,AAAA',
    `blob:kettu-artifact://${HOST}/0b1c`,
    ...ARTIFACT_CDNS.map((origin) => `${origin}/lib.js`),
    'https://cdn.jsdelivr.net:443/npm/chart.js',
  ])('lets a page load %s', (url) => {
    expect(mayRequest(HOST, url)).toBe(true)
  })

  it.each([
    'kettu-artifact://ffffffffffffffffffffffffff/',
    'https://example.com/collect?d=secret',
    'http://cdn.jsdelivr.net/npm/x',
    'https://cdn.jsdelivr.net:8443/npm/x',
    'https://user:pass@cdn.jsdelivr.net/npm/x',
    'https://cdn.jsdelivr.net.example.com/x',
    'wss://cdn.jsdelivr.net/socket',
    'ws://127.0.0.1:5173/',
    'http://localhost:5173/src/main.tsx',
    'file:///etc/passwd',
    'devtools://devtools/bundled/inspector.html',
    'chrome://gpu',
    'about:blank',
    'not a url',
  ])('stops a page from loading %s', (url) => {
    expect(mayRequest(HOST, url)).toBe(false)
  })
})

describe('mayRequest for a strict artifact', () => {
  it('lets a page load only its own origin, data: and blob:', () => {
    expect(mayRequest(HOST, `kettu-artifact://${HOST}/_kettu/v1`, true)).toBe(true)
    expect(mayRequest(HOST, 'data:text/plain,a', true)).toBe(true)
    expect(mayRequest(HOST, `blob:kettu-artifact://${HOST}/0b1c`, true)).toBe(true)
    for (const origin of ARTIFACT_CDNS) expect(mayRequest(HOST, `${origin}/x.js`, true)).toBe(false)
    expect(mayRequest(HOST, 'kettu-artifact://ffffffffffffffffffffffffff/', true)).toBe(false)
  })
})

describe('project image request policy', () => {
  it('W03 never allows a disk image as an artifact request', () => {
    for (const url of ['file:///tmp/photo.png', '/Users/example/photo.png', 'C:/photos/p.png']) {
      expect(mayRequest(HOST, url, false, granted)).toBe(false)
    }
    expect(
      mayRequest(HOST, `kettu-artifact://${HOST}/_kettu/v/1/images/local.png`, false, granted),
    ).toBe(true)
  })

  it('P01/P06 uses the current grant when the same page makes a new image request', () => {
    const origins: string[] = []
    const request = () => mayRequest(HOST, IMAGE, false, { resourceType: 'image', origins })
    expect(request()).toBe(false)
    origins.push(IMAGE_ORIGIN)
    expect(request()).toBe(true)
    origins.pop()
    expect(request()).toBe(false)
  })

  it.each([
    'https://oss-cn-hongkong.aliyuncs.com/t.png',
    'https://sibling.oss-cn-hongkong.aliyuncs.com/t.png',
    'https://child.test-enabler.oss-cn-hongkong.aliyuncs.com/t.png',
    'https://test-enabler.oss-cn-hongkong.aliyuncs.com.example.org/t.png',
    `${IMAGE_ORIGIN}:8443/t.png`,
  ])('P03 does not extend the grant to %s', (url) => {
    expect(mayRequest(HOST, IMAGE, false, granted)).toBe(true)
    expect(mayRequest(HOST, url, false, granted)).toBe(false)
  })

  it('P07 checks the redirect destination against the same exact grant', () => {
    expect(mayRequest(HOST, IMAGE, false, granted)).toBe(true)
    expect(mayRequest(HOST, 'https://other.example/redirected.png', false, granted)).toBe(false)
  })

  it.each(['script', 'stylesheet', 'font', 'media', 'subFrame', 'xhr'])(
    'P08 permits images of the granted origin while still blocking %s',
    (resourceType) => {
      expect(mayRequest(HOST, IMAGE, false, { ...granted, resourceType })).toBe(false)
      expect(mayRequest(HOST, IMAGE, false, granted)).toBe(true)
      expect(
        mayRequest(HOST, 'https://cdn.jsdelivr.net/npm/chart.js', false, {
          ...granted,
          resourceType: 'script',
        }),
      ).toBe(true)
    },
  )

  it('P09 suppresses external images and CDNs for a strict artifact even after granting the origin', () => {
    expect(mayRequest(HOST, IMAGE, true, granted)).toBe(false)
    expect(mayRequest(HOST, 'https://cdn.jsdelivr.net/t.png', true, granted)).toBe(false)
    expect(mayRequest(HOST, IMAGE, false, granted)).toBe(true)
  })
})

describe('the policy', () => {
  it('allows nothing by default and names the CDNs only where the design does', () => {
    const directives = new Map(
      ARTIFACT_CSP.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]),
    )
    expect(directives.get('default-src')).toEqual(["'none'"])
    expect(directives.get('frame-src')).toEqual(["'self'"])
    expect(directives.get('form-action')).toEqual(["'none'"])
    expect(directives.get('media-src')).toEqual(["'self'", 'data:', 'blob:'])
    for (const name of ['script-src', 'style-src', 'font-src', 'img-src', 'connect-src']) {
      expect(directives.get(name)).toEqual(expect.arrayContaining([...ARTIFACT_CDNS]))
    }
  })

  it('names no host but its own for an artifact that reads what is outside it', () => {
    const directives = new Map(
      ARTIFACT_STRICT_CSP.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]),
    )
    expect(ARTIFACT_STRICT_CSP).not.toMatch(/https?:/)
    expect(directives.get('default-src')).toEqual(["'none'"])
    expect(directives.get('connect-src')).toEqual(["'self'"])
    expect(directives.get('img-src')).toEqual(["'self'", 'data:', 'blob:'])
    expect(directives.get('form-action')).toEqual(["'none'"])
    expect(artifactHeaders(true)['Content-Security-Policy']).toBe(ARTIFACT_STRICT_CSP)
  })

  it('goes out with every header the design lists', () => {
    const headers = artifactHeaders()
    expect(headers['Content-Security-Policy']).toBe(ARTIFACT_CSP)
    expect(headers['Permissions-Policy']).toContain('camera=()')
    expect(headers['Permissions-Policy']).toContain('fullscreen=()')
    expect(headers).toMatchObject({
      'Content-Type': 'text/html; charset=utf-8',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    })
  })
})

describe('WINDOW_PROXY', () => {
  it('lets the CDNs and loopback past the proxy that refuses everything else', () => {
    const bypass = WINDOW_PROXY.proxyBypassRules?.split(',') ?? []
    for (const origin of ARTIFACT_CDNS) expect(bypass).toContain(new URL(origin).host)
    expect(bypass).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '[::1]']))
    expect(bypass).not.toContain('*')
    expect(WINDOW_PROXY.proxyRules).toBe('http://127.0.0.1:9')
  })
})
