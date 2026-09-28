// The stand-in for LM Studio and for a web page, in its own process — so its
// clock keeps time while the process being measured is blocked, and a late
// chunk is the measured process's lateness, not the server's.
//
//   GET /stream   an SSE reply over http: one token every TOKEN_MS until the client leaves
//   GET /page/:n  a small article for render.ts, over https (render.ts loads nothing else),
//                 with the throwaway certificate in TLS_KEY / TLS_CERT
//
// Prints "<http port> <https port>" on stdout as its first line (https port 0 when no certificate).
import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'

const TOKEN_MS = Number(process.env.TOKEN_MS || 25)

function handle(req, res) {
  if (req.url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
    let n = 0
    const timer = setInterval(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: ` tok${n++}` } }] })}\n\n`)
    }, TOKEN_MS)
    req.on('close', () => clearInterval(timer))
    return
  }
  const page = /^\/page\/(\d+)$/.exec(req.url || '')
  if (page) {
    const paras = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i} of page ${page[1]}: the quick brown fox jumps over the lazy dog, and the render window reads it.</p>`).join('')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>Page ${page[1]}</title></head><body><article><h1>Page ${page[1]}</h1>${paras}</article></body></html>`)
    return
  }
  res.writeHead(404)
  res.end()
}

const plain = http.createServer(handle)
const secure =
  process.env.TLS_KEY && process.env.TLS_CERT
    ? https.createServer({ key: readFileSync(process.env.TLS_KEY), cert: readFileSync(process.env.TLS_CERT) }, handle)
    : null

plain.listen(0, '127.0.0.1', () => {
  if (!secure) return process.stdout.write(`${plain.address().port} 0\n`)
  secure.listen(0, '127.0.0.1', () => process.stdout.write(`${plain.address().port} ${secure.address().port}\n`))
})
