import dns from 'node:dns'
import { BlockList, isIP, type LookupFunction } from 'node:net'

// 198.18/15 is left out: proxy tools in fake-IP mode answer every name from it and route what
// follows, so blocking it would cut off every user of one.
const PRIVATE = new BlockList()
for (const [network, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(network, bits, 'ipv4')
}
for (const [network, bits] of [
  ['::', 96],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(network, bits, 'ipv6')
}

/** Whether an address is outside this computer and its private networks, so a plugin may reach it. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  return !PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

type Resolve = (
  hostname: string,
  options: dns.LookupOptions & { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void

/** A lookup that resolves as usual and then keeps only the public addresses, or fails. */
export function publicLookup(resolve: Resolve = dns.lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0)
      const allowed = addresses.filter((item) => isPublicAddress(item.address))
      const first = allowed[0]
      if (!first) {
        const refused = new Error(
          `${hostname} resolves to an address on this computer or a private network`,
        ) as NodeJS.ErrnoException
        refused.code = 'EACCES'
        return callback(refused, '', 0)
      }
      if (options.all) return callback(null, allowed)
      callback(null, first.address, first.family)
    })
  }
}
