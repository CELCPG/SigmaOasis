// A reader for the .xlsx the writer makes and the ones Excel makes: shared or inline strings, numbers, booleans.
const { inflateRawSync } = require('node:zlib')

function unzip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('not a zip')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + size)
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data))
  }
  return out
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const col = (ref) => { let n = 0; for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1 }

/** Every sheet as { name, rows }, cells as strings or numbers (blank: null). */
function readXlsx(buf) {
  const files = unzip(buf)
  const wb = files.get('xl/workbook.xml').toString('utf8')
  const rels = (files.get('xl/_rels/workbook.xml.rels') || Buffer.alloc(0)).toString('utf8')
  const targets = new Map()
  for (const m of rels.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = /\sId="([^"]*)"/.exec(m[0]); const t = /\sTarget="([^"]*)"/.exec(m[0])
    if (id && t) targets.set(id[1], t[1].replace(/^\/?xl\//, '').replace(/^\//, ''))
  }
  const shared = []
  const sst = files.get('xl/sharedStrings.xml')
  if (sst) for (const si of sst.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(decode([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')))
  const sheets = []
  for (const m of wb.matchAll(/<sheet\s[^>]*>/g)) {
    const name = decode(/\sname="([^"]*)"/.exec(m[0])[1])
    const rid = (/\sr:id="([^"]*)"/.exec(m[0]) || [])[1]
    const xml = (files.get('xl/' + (targets.get(rid) || 'worksheets/sheet' + (sheets.length + 1) + '.xml')) || Buffer.alloc(0)).toString('utf8')
    const rows = []
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = []
      for (const c of r[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const open = c[1]; const inner = c[2] || ''
        const ref = (/\sr="([^"]*)"/.exec(' ' + open) || [])[1]
        const type = (/\st="([^"]*)"/.exec(' ' + open) || [])[1]
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1]
        const i = ref ? col(ref) : row.length
        let value = null
        if (type === 's') value = shared[Number(v)]
        else if (type === 'inlineStr') value = decode([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''))
        else if (type === 'b') value = v === '1'
        else if (type === 'str') value = decode(v || '')
        else if (v !== undefined) value = Number(v)
        while (row.length < i) row.push(null)
        row[i] = value
      }
      rows.push(row)
    }
    sheets.push({ name, rows })
  }
  return sheets
}

module.exports = { readXlsx }
