import { zstdCompressSync } from 'node:zlib'

/**
 * A minimal ZIM writer for the tests: enough of the format (ZIM 6.1, `C`
 * namespace, `M` metadata, redirects, one cluster per compression setting)
 * to prove the reader against files it built itself. Not a general writer.
 */

export interface FixtureArticle {
  url: string
  title: string
  html: string
  /** A redirect to another article's url instead of content. */
  redirectTo?: string
}

export interface FixtureOptions {
  compression?: 'none' | 'zstd'
  metadata?: Record<string, string>
}

const MAGIC = 72173914

export function buildZim(articles: FixtureArticle[], options: FixtureOptions = {}): Buffer {
  const compression = options.compression ?? 'none'
  const metadata = { Title: 'Fixture', Language: 'eng', ...(options.metadata ?? {}) }
  const mimeTypes = ['text/html', 'text/plain']

  // Entries: content articles and metadata in one cluster; redirects point by url index.
  type Entry = { namespace: string; url: string; title: string; mime: number; blob?: number; redirectUrl?: string }
  const entries: Entry[] = []
  const blobs: Buffer[] = []
  for (const a of articles) {
    if (a.redirectTo) entries.push({ namespace: 'C', url: a.url, title: a.title, mime: 0xffff, redirectUrl: a.redirectTo })
    else {
      entries.push({ namespace: 'C', url: a.url, title: a.title, mime: 0, blob: blobs.length })
      blobs.push(Buffer.from(a.html, 'utf-8'))
    }
  }
  for (const [k, v] of Object.entries(metadata)) {
    entries.push({ namespace: 'M', url: k, title: k, mime: 1, blob: blobs.length })
    blobs.push(Buffer.from(v, 'utf-8'))
  }
  // URL order: namespace, then url bytes. Title order: namespace, then title bytes.
  const byUrl = entries.map((e, i) => ({ e, i })).sort((a, b) => cmp(a.e.namespace, a.e.url, b.e.namespace, b.e.url))
  const urlIndexOf = new Map<string, number>()
  byUrl.forEach(({ e }, idx) => urlIndexOf.set(`${e.namespace}/${e.url}`, idx))
  const byTitle = byUrl.map((x, idx) => ({ ...x, urlIndex: idx })).sort((a, b) => cmp(a.e.namespace, a.e.title, b.e.namespace, b.e.title))

  // Directory entry bytes.
  const dirEntries = byUrl.map(({ e }) => {
    const isRedirect = e.mime === 0xffff
    const head = Buffer.alloc(isRedirect ? 12 : 16)
    head.writeUInt16LE(e.mime, 0)
    head.writeUInt8(0, 2) // parameter length
    head.write(e.namespace, 3, 1, 'latin1')
    head.writeUInt32LE(0, 4) // revision
    if (isRedirect) head.writeUInt32LE(urlIndexOf.get(`C/${e.redirectUrl}`)!, 8)
    else {
      head.writeUInt32LE(0, 8) // cluster 0
      head.writeUInt32LE(e.blob!, 12)
    }
    return Buffer.concat([head, Buffer.from(e.url, 'utf-8'), Buffer.from([0]), Buffer.from(e.title === e.url ? '' : e.title, 'utf-8'), Buffer.from([0])])
  })

  // Cluster 0: offsets (u32) then blobs.
  const offsets = Buffer.alloc((blobs.length + 1) * 4)
  let cursor = (blobs.length + 1) * 4
  blobs.forEach((b, i) => {
    offsets.writeUInt32LE(cursor, i * 4)
    cursor += b.length
  })
  offsets.writeUInt32LE(cursor, blobs.length * 4)
  const clusterBody = Buffer.concat([offsets, ...blobs])
  const cluster = Buffer.concat([Buffer.from([compression === 'zstd' ? 5 : 1]), compression === 'zstd' ? zstdCompressSync(clusterBody) : clusterBody])

  // Layout: header | mime list | dir entries | url ptrs | title ptrs | cluster ptrs | cluster | checksum(16)
  const mimeList = Buffer.concat([...mimeTypes.map((m) => Buffer.concat([Buffer.from(m, 'utf-8'), Buffer.from([0])])), Buffer.from([0])])
  const headerLen = 80
  const mimeListPos = headerLen
  const dirPos = mimeListPos + mimeList.length
  const dirOffsets: number[] = []
  let p = dirPos
  for (const d of dirEntries) {
    dirOffsets.push(p)
    p += d.length
  }
  const urlPtrPos = p
  const urlPtrs = Buffer.alloc(dirEntries.length * 8)
  dirOffsets.forEach((o, i) => urlPtrs.writeBigUInt64LE(BigInt(o), i * 8))
  const titlePtrPos = urlPtrPos + urlPtrs.length
  const titlePtrs = Buffer.alloc(dirEntries.length * 4)
  byTitle.forEach((t, i) => titlePtrs.writeUInt32LE(t.urlIndex, i * 4))
  const clusterPtrPos = titlePtrPos + titlePtrs.length
  const clusterPtrs = Buffer.alloc(8)
  const clusterPos = clusterPtrPos + 8
  clusterPtrs.writeBigUInt64LE(BigInt(clusterPos), 0)
  const checksumPos = clusterPos + cluster.length

  const header = Buffer.alloc(headerLen)
  header.writeUInt32LE(MAGIC, 0)
  header.writeUInt16LE(6, 4)
  header.writeUInt16LE(1, 6)
  Buffer.from('0123456789abcdef', 'latin1').copy(header, 8)
  header.writeUInt32LE(dirEntries.length, 24)
  header.writeUInt32LE(1, 28)
  header.writeBigUInt64LE(BigInt(urlPtrPos), 32)
  header.writeBigUInt64LE(BigInt(titlePtrPos), 40)
  header.writeBigUInt64LE(BigInt(clusterPtrPos), 48)
  header.writeBigUInt64LE(BigInt(mimeListPos), 56)
  header.writeUInt32LE(0xffffffff, 64)
  header.writeUInt32LE(0xffffffff, 68)
  header.writeBigUInt64LE(BigInt(checksumPos), 72)

  return Buffer.concat([header, mimeList, ...dirEntries, urlPtrs, titlePtrs, clusterPtrs, cluster, Buffer.alloc(16)])
}

function cmp(ns1: string, s1: string, ns2: string, s2: string): number {
  if (ns1 !== ns2) return ns1 < ns2 ? -1 : 1
  return Buffer.compare(Buffer.from(s1, 'utf-8'), Buffer.from(s2, 'utf-8'))
}
