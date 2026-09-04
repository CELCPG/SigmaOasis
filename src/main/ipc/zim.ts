import { promises as fs } from 'fs'
import { zstdDecompressSync } from 'zlib'

/**
 * v2.8: a reader for Kiwix ZIM files — offline Wikipedia, WikiMed, and the
 * rest of the Kiwix catalogue — as a pack the library retrieves from.
 *
 * The format (openzim.org, ZIM 5 and 6): a fixed header; a MIME-type list;
 * directory entries, each naming a namespace, a URL, a title and either a
 * (cluster, blob) pair or a redirect; a URL pointer list sorted by URL and a
 * title pointer list sorted by title, both for binary search; clusters of
 * blobs, each cluster compressed as a whole. Nothing here is loaded whole: a
 * lookup binary-searches the title list on disk, opens the few articles it
 * needs, and decompresses only their clusters, with a small cache.
 *
 * Compression: none and zstd, which every ZIM built since 2020 uses and
 * which Node's zlib has had since 22. An xz cluster — older files — is
 * refused with a sentence saying so rather than a vendored decoder; the
 * strategy allowed one, and the measurement of how many current files need
 * it came out at none of the ones this was tested against.
 *
 * Read-only, local, no network. A ZIM is the user's file at the user's path.
 */

export const ZIM_MAGIC = 72173914
const HEADER_BYTES = 80
const CLUSTER_CACHE = 8
const MAX_BLOB_BYTES = 8 * 1024 * 1024
const MAX_TITLE_SCAN = 200

export interface ZimHeader {
  majorVersion: number
  minorVersion: number
  uuid: string
  entryCount: number
  clusterCount: number
  urlPtrPos: bigint
  titlePtrPos: bigint
  clusterPtrPos: bigint
  mimeListPos: bigint
  mainPage: number
  checksumPos: bigint
}

export interface ZimEntry {
  /** Index into the URL pointer list — the entry's identity. */
  index: number
  namespace: string
  url: string
  title: string
  /** null for a redirect. */
  mimetype: string | null
  redirectIndex?: number
  cluster?: number
  blob?: number
}

/** The namespace articles live in: `C` in ZIM 6.1+, `A` before. */
export function contentNamespace(header: ZimHeader): string {
  return header.majorVersion >= 6 && header.minorVersion >= 1 ? 'C' : 'A'
}

export class ZimFile {
  private constructor(
    readonly path: string,
    private readonly fh: fs.FileHandle,
    readonly header: ZimHeader,
    readonly mimeTypes: string[]
  ) {}

  private readonly clusterCache = new Map<number, { offsets: number[]; data: Buffer }>()
  private readonly entryCache = new Map<number, ZimEntry>()

  static async open(path: string): Promise<ZimFile> {
    const fh = await fs.open(path, 'r')
    try {
      const head = Buffer.alloc(HEADER_BYTES)
      const { bytesRead } = await fh.read(head, 0, HEADER_BYTES, 0)
      if (bytesRead < HEADER_BYTES || head.readUInt32LE(0) !== ZIM_MAGIC) throw new Error('Not a ZIM file (bad magic number).')
      const header: ZimHeader = {
        majorVersion: head.readUInt16LE(4),
        minorVersion: head.readUInt16LE(6),
        uuid: head.subarray(8, 24).toString('hex'),
        entryCount: head.readUInt32LE(24),
        clusterCount: head.readUInt32LE(28),
        urlPtrPos: head.readBigUInt64LE(32),
        titlePtrPos: head.readBigUInt64LE(40),
        clusterPtrPos: head.readBigUInt64LE(48),
        mimeListPos: head.readBigUInt64LE(56),
        mainPage: head.readUInt32LE(64),
        checksumPos: head.readBigUInt64LE(72)
      }
      if (header.majorVersion < 5 || header.majorVersion > 6) throw new Error(`Unsupported ZIM major version ${header.majorVersion}.`)
      const mimeTypes = await readMimeList(fh, header.mimeListPos)
      return new ZimFile(path, fh, header, mimeTypes)
    } catch (err) {
      await fh.close().catch(() => undefined)
      throw err
    }
  }

  async close(): Promise<void> {
    await this.fh.close().catch(() => undefined)
  }

  private async readAt(pos: bigint | number, length: number): Promise<Buffer> {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await this.fh.read(buf, 0, length, Number(pos))
    return bytesRead === length ? buf : buf.subarray(0, bytesRead)
  }

  /** The directory entry at a URL-pointer index. */
  async entryAt(index: number): Promise<ZimEntry> {
    const cached = this.entryCache.get(index)
    if (cached) return cached
    if (index < 0 || index >= this.header.entryCount) throw new Error(`Entry index ${index} out of range.`)
    const ptr = (await this.readAt(this.header.urlPtrPos + BigInt(index) * 8n, 8)).readBigUInt64LE(0)
    // An entry is small; 1 KB covers any URL and title that fit a sane file.
    let buf = await this.readAt(ptr, 1024)
    const mime = buf.readUInt16LE(0)
    const namespace = String.fromCharCode(buf[3]!)
    const isRedirect = mime === 0xffff
    let off = isRedirect ? 12 : 16
    let zero = buf.indexOf(0, off)
    if (zero < 0) {
      buf = await this.readAt(ptr, 8192)
      zero = buf.indexOf(0, off)
      if (zero < 0) throw new Error(`Entry ${index} is malformed.`)
    }
    const url = buf.toString('utf-8', off, zero)
    off = zero + 1
    let zero2 = buf.indexOf(0, off)
    if (zero2 < 0) zero2 = buf.length
    const rawTitle = buf.toString('utf-8', off, zero2)
    const entry: ZimEntry = {
      index,
      namespace,
      url,
      title: rawTitle || url,
      mimetype: isRedirect ? null : (this.mimeTypes[mime] ?? 'application/octet-stream'),
      ...(isRedirect ? { redirectIndex: buf.readUInt32LE(8) } : { cluster: buf.readUInt32LE(8), blob: buf.readUInt32LE(12) })
    }
    if (this.entryCache.size > 4096) this.entryCache.clear()
    this.entryCache.set(index, entry)
    return entry
  }

  /** The entry at a title-pointer index (the title-sorted order). */
  async entryByTitleIndex(i: number): Promise<ZimEntry> {
    const urlIndex = (await this.readAt(this.header.titlePtrPos + BigInt(i) * 4n, 4)).readUInt32LE(0)
    return this.entryAt(urlIndex)
  }

  /** Follow redirects to a content entry (bounded). */
  async resolve(entry: ZimEntry): Promise<ZimEntry> {
    let e = entry
    for (let hops = 0; hops < 8 && e.redirectIndex !== undefined; hops++) e = await this.entryAt(e.redirectIndex)
    return e
  }

  /** A metadata value (M namespace): Title, Description, Language, Date, Counter… */
  async metadata(name: string): Promise<string | null> {
    const e = await this.findByUrl('M', name)
    if (!e || e.redirectIndex !== undefined) return null
    return (await this.readBlob(e)).toString('utf-8')
  }

  /** Binary search of the URL-sorted list for an exact (namespace, url). */
  async findByUrl(namespace: string, url: string): Promise<ZimEntry | null> {
    let lo = 0
    let hi = this.header.entryCount - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const e = await this.entryAt(mid)
      const cmp = compareKeys(e.namespace, e.url, namespace, url)
      if (cmp === 0) return e
      if (cmp < 0) lo = mid + 1
      else hi = mid - 1
    }
    return null
  }

  /**
   * Titles in a namespace starting with `prefix`, in title order, at most
   * `limit`. The title list is sorted by (namespace, title), so the first
   * match is a lower bound and the rest follow it.
   */
  async searchTitles(prefix: string, namespace: string, limit = 20): Promise<ZimEntry[]> {
    let lo = 0
    let hi = this.header.entryCount
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const e = await this.entryByTitleIndex(mid)
      if (compareKeys(e.namespace, e.title, namespace, prefix) < 0) lo = mid + 1
      else hi = mid
    }
    const out: ZimEntry[] = []
    for (let i = lo; i < this.header.entryCount && out.length < limit && i - lo < MAX_TITLE_SCAN; i++) {
      const e = await this.entryByTitleIndex(i)
      if (e.namespace !== namespace || !e.title.startsWith(prefix)) break
      out.push(e)
    }
    return out
  }

  private async cluster(n: number): Promise<{ offsets: number[]; data: Buffer }> {
    const cached = this.clusterCache.get(n)
    if (cached) return cached
    if (n < 0 || n >= this.header.clusterCount) throw new Error(`Cluster ${n} out of range.`)
    const ptrs = await this.readAt(this.header.clusterPtrPos + BigInt(n) * 8n, 16)
    const start = ptrs.readBigUInt64LE(0)
    const end = n + 1 < this.header.clusterCount ? ptrs.readBigUInt64LE(8) : this.header.checksumPos
    const raw = await this.readAt(start, Number(end - start))
    const info = raw[0]!
    const compression = info & 0x0f
    const extended = (info & 0x10) !== 0
    let data: Buffer
    if (compression === 1 || compression === 0) data = raw.subarray(1)
    else if (compression === 5) data = zstdDecompressSync(raw.subarray(1))
    else if (compression === 4) throw new Error('This ZIM uses xz compression, which this build does not read; a zstd-compressed ZIM (any Kiwix file built since 2020) works.')
    else throw new Error(`Unknown ZIM cluster compression ${compression}.`)
    const width = extended ? 8 : 4
    const first = extended ? Number(data.readBigUInt64LE(0)) : data.readUInt32LE(0)
    const count = Math.floor(first / width)
    const offsets: number[] = []
    for (let i = 0; i < count; i++) offsets.push(extended ? Number(data.readBigUInt64LE(i * width)) : data.readUInt32LE(i * width))
    const parsed = { offsets, data }
    if (this.clusterCache.size >= CLUSTER_CACHE) this.clusterCache.delete(this.clusterCache.keys().next().value!)
    this.clusterCache.set(n, parsed)
    return parsed
  }

  async readBlob(entry: ZimEntry): Promise<Buffer> {
    if (entry.cluster === undefined || entry.blob === undefined) throw new Error(`Entry ${entry.index} is a redirect.`)
    const { offsets, data } = await this.cluster(entry.cluster)
    const start = offsets[entry.blob]
    const end = offsets[entry.blob + 1]
    if (start === undefined || end === undefined || end < start) throw new Error(`Blob ${entry.blob} of cluster ${entry.cluster} is out of range.`)
    if (end - start > MAX_BLOB_BYTES) throw new Error('Blob too large.')
    return data.subarray(start, end)
  }

  /** An article's text: the HTML stripped, or the text as is. */
  async articleText(entry: ZimEntry): Promise<{ title: string; text: string }> {
    const e = await this.resolve(entry)
    const body = (await this.readBlob(e)).toString('utf-8')
    const html = (e.mimetype ?? '').startsWith('text/html')
    return { title: e.title, text: html ? htmlToText(body) : body }
  }
}

async function readMimeList(fh: fs.FileHandle, pos: bigint): Promise<string[]> {
  const buf = Buffer.alloc(8192)
  const { bytesRead } = await fh.read(buf, 0, buf.length, Number(pos))
  const out: string[] = []
  let off = 0
  while (off < bytesRead) {
    const zero = buf.indexOf(0, off)
    if (zero < 0) break
    if (zero === off) break
    out.push(buf.toString('utf-8', off, zero))
    off = zero + 1
  }
  return out
}

/** ZIM sorts by namespace, then by the byte string. */
function compareKeys(ns1: string, s1: string, ns2: string, s2: string): number {
  if (ns1 !== ns2) return ns1 < ns2 ? -1 : 1
  return Buffer.compare(Buffer.from(s1, 'utf-8'), Buffer.from(s2, 'utf-8'))
}

/** HTML to readable text: scripts, styles and navigation dropped; headings kept as Markdown so section chunking works. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|aside|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag: string, inner: string) => `\n\n${'#'.repeat(Number(tag[1]))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<(li)[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|section|article|blockquote|ul|ol|table)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  return s
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', deg: '°', times: '×' }
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => safeChar(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m)
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
}
