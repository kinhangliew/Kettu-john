// `network.fetch`: the one way a plugin's script reaches the network. It reaches only the domains
// its `network:<domain>` permissions name, over https on the default port, with no redirect
// followed and no address on this computer or a private network, so what the plugin was granted
// is all it can reach. The standard `fetch` cannot refuse an address at connect time, so the
// request goes through `node:https` with its own lookup.

import { publicLookup } from '@shared/public-lookup'
export { isPublicAddress, publicLookup } from '@shared/public-lookup'
import https from 'node:https'
import { domainCovers } from '@shared/plugins'
import { grantedDomains, type PluginApiCall } from './call'

export const FETCH_URL_CHARS = 2048
export const FETCH_REQUEST_BYTES = 256 * 1024
export const FETCH_RESPONSE_BYTES = 256 * 1024
export const FETCH_TIMEOUT_MS = 20_000
const MAX_HEADERS = 50
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/
// The connection's own fields, which the transport sets.
const FORBIDDEN_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'expect',
])
// As the manifest writes a domain: lowercase labels and a letters-only last one.
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export interface HttpRequest {
  url: URL
  method: string
  headers: Record<string, string>
  body: string | null
  signal: AbortSignal
}

export interface HttpResponse {
  status: number
  /** Lowercase names; a header sent more than once is joined with ", ". */
  headers: Record<string, string>
  /** The body as UTF-8 text. */
  body: string
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>

/** Sends the request over https, to a public address, and reads at most `FETCH_RESPONSE_BYTES`. */
export const httpsTransport: HttpTransport = (request) =>
  new Promise((resolve, reject) => {
    const outgoing = https.request(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        lookup: publicLookup(),
        agent: false,
        signal: request.signal,
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        const tooLarge = (): void => {
          response.destroy()
          reject(new Error(`The response is larger than ${FETCH_RESPONSE_BYTES / 1024} KB`))
        }
        if (Number(response.headers['content-length']) > FETCH_RESPONSE_BYTES) return tooLarge()
        const encoding = response.headers['content-encoding']
        if (typeof encoding === 'string' && encoding.toLowerCase() !== 'identity') {
          response.destroy()
          return reject(new Error(`The response is encoded as ${encoding.slice(0, 40)}`))
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > FETCH_RESPONSE_BYTES) return tooLarge()
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
          }
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    outgoing.on('error', reject)
    outgoing.end(request.body ?? undefined)
  })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sentHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (value === undefined) return out
  if (!isRecord(value) || Object.keys(value).length > MAX_HEADERS) {
    throw new Error(`headers must be an object of at most ${MAX_HEADERS} strings`)
  }
  for (const [name, text] of Object.entries(value)) {
    if (!HEADER_NAME.test(name) || typeof text !== 'string' || text.length > 8192) {
      throw new Error(`The header "${name.slice(0, 100)}" is not a name and a string`)
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new Error(`The header "${name}" is set by Kettu`)
    }
    out[name.toLowerCase()] = text
  }
  return out
}

/** The call's checks and its answer; `transport` sends the request that passed them. */
export function networkFetch(transport: HttpTransport): PluginApiCall {
  return {
    permission: 'network',
    async run({ permissions }, [target, init]) {
      if (typeof target !== 'string' || target.length > FETCH_URL_CHARS) {
        throw new Error(`The address must be text of at most ${FETCH_URL_CHARS} characters`)
      }
      const url = URL.parse(target)
      if (url === null) throw new Error('The address is not a valid URL')
      if (url.protocol !== 'https:') throw new Error('Only https addresses can be reached')
      if (url.username !== '' || url.password !== '') {
        throw new Error('An address with a user name or password cannot be reached')
      }
      if (url.port !== '') throw new Error('Only the default https port can be reached')
      const host = url.hostname
      const domains = grantedDomains(permissions)
      if (!HOST_NAME.test(host) || !domains.some((domain) => domainCovers(domain, host))) {
        throw new Error(
          `${host} is not among the domains this plugin may reach (${domains.join(', ')}). ` +
            `It needs the permission "network:${host}".`,
        )
      }
      if (init !== undefined && !isRecord(init)) throw new Error('The options must be an object')
      const options = init ?? {}
      if (options.method !== undefined && typeof options.method !== 'string') {
        throw new Error('The method must be text')
      }
      const method = options.method?.toUpperCase() ?? 'GET'
      if (!(METHODS as readonly string[]).includes(method)) {
        throw new Error(`The method must be one of ${METHODS.join(', ')}`)
      }
      const body = options.body
      if (body !== undefined && typeof body !== 'string') throw new Error('The body must be text')
      if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
        throw new Error(`A ${method} request has no body`)
      }
      if (body !== undefined && Buffer.byteLength(body) > FETCH_REQUEST_BYTES) {
        throw new Error(`The body is larger than ${FETCH_REQUEST_BYTES / 1024} KB`)
      }
      const headers = {
        'user-agent': 'Kettu',
        'accept-encoding': 'identity',
        ...sentHeaders(options.headers),
      }
      return transport({
        url,
        method,
        headers,
        body: body ?? null,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    },
  }
}
