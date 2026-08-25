#!/usr/bin/env node
/**
 * Render docs/head-to-head/progress.html from rounds.json.
 *
 * The page is a log, not a report: it is regenerated after every round and
 * shows only what has actually been measured. Run:
 *
 *   node docs/head-to-head/build-progress.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const data = JSON.parse(readFileSync(join(HERE, 'rounds.json'), 'utf8'))

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )

// ---------------------------------------------------------------- fragments

const invariants = data.invariants
  .map(
    (i) => `        <div class="inv inv--${esc(i.state)}">
          <span class="inv__dot" aria-hidden="true"></span>
          <span class="inv__name">${esc(i.name)}</span>
          <span class="inv__val">${esc(i.value)}</span>
        </div>`
  )
  .join('\n')

const routes = data.referenceArm.routes
  .map(
    (r) => `          <tr>
            <th scope="row">${esc(r.route)}</th>
            <td>${esc(r.result)}</td>
          </tr>`
  )
  .join('\n')

const dims = data.dimensions
  .map((d) => {
    const pct = d.high > 0 ? Math.round((d.closed / d.high) * 100) : 0
    return `        <article class="dim">
          <h3 class="dim__title">${esc(d.title)}</h3>
          <div class="dim__bar" role="img" aria-label="${d.closed} of ${d.high} high-severity gaps closed">
            <span class="dim__fill" style="width:${pct}%"></span>
          </div>
          <dl class="dim__stats">
            <div><dt>closed</dt><dd class="num">${d.closed}<span class="of">/${d.high}</span></dd></div>
            <div><dt>high</dt><dd class="num">${d.high}</dd></div>
            <div><dt>total</dt><dd class="num">${d.gaps}</dd></div>
          </dl>
        </article>`
  })
  .join('\n')

function roundBlock(r) {
  const state = esc(r.state || 'pending')
  const rows = []
  if (r.what) rows.push(['what ran', esc(r.what)])
  if (r.findings) rows.push(['findings', esc(r.findings)])
  if (r.verdict) rows.push(['blind verdict', esc(r.verdict)])
  if (r.gap) rows.push(['biggest gap', esc(r.gap)])
  if (r.fix) rows.push(['fix', esc(r.fix)])

  const pair = r.pair
    ? `          <div class="pair">
            <span class="pair__side">${esc(r.pair.A)}</span>
            <span class="pair__vs">vs</span>
            <span class="pair__side">${esc(r.pair.B)}</span>
          </div>`
    : ''

  const evals = r.evals && Object.keys(r.evals).length
    ? `          <div class="evals">
${Object.entries(r.evals)
  .map(
    ([k, v]) =>
      `            <div class="ev"><span class="ev__k">${esc(k)}</span><span class="ev__v num">${esc(v)}</span></div>`
  )
  .join('\n')}
          </div>`
    : ''

  return `      <li class="round round--${state}">
        <div class="round__mark"><span class="round__n num">${r.n}</span></div>
        <div class="round__body">
          <header class="round__head">
            <h3>${esc(r.label || (r.dimension ?? 'Round ' + r.n))}</h3>
            <span class="tag tag--${state}">${state}</span>
          </header>
${pair}
          <dl class="facts">
${rows.map(([k, v]) => `            <div><dt>${k}</dt><dd>${v}</dd></div>`).join('\n')}
          </dl>
${evals}
        </div>
      </li>`
}

const roundsHtml = data.rounds.map(roundBlock).join('\n')

const historyHtml = data.evalHistory.length
  ? `      <div class="tablewrap">
        <table class="hist">
          <thead><tr><th>round</th><th>suite</th><th>metric</th><th class="r">value</th><th class="r">delta</th></tr></thead>
          <tbody>
${data.evalHistory
  .map(
    (h) =>
      `            <tr><td class="num">${esc(h.round)}</td><td>${esc(h.suite)}</td><td>${esc(h.metric)}</td><td class="r num">${esc(h.value)}</td><td class="r num ${
        String(h.delta ?? '').startsWith('-') ? 'down' : String(h.delta ?? '').startsWith('+') ? 'up' : ''
      }">${esc(h.delta ?? '—')}</td></tr>`
  )
  .join('\n')}
          </tbody>
        </table>
      </div>`
  : `      <p class="empty">No eval numbers yet. This table stays empty until a suite has actually been run — it is not seeded with expectations.</p>`

// ---------------------------------------------------------------- document

const html = `<title>Sigma Oasis Bench Log</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root {
    --ground: #f4f7f6;
    --panel: #ffffff;
    --panel-2: #eef2f1;
    --ink: #0f1c18;
    --ink-2: #3c4d48;
    --ink-3: #64756f;
    --rule: #d8e0dd;
    --accent: #12786a;
    --accent-soft: #d6ebe6;
    --good: #2c7a55;
    --bad: #ac3e2b;
    --warn: #8d6417;
    --shadow: 0 1px 2px rgba(15, 28, 24, .05), 0 8px 24px -12px rgba(15, 28, 24, .16);
    --f-display: "Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif;
    --f-body: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    --f-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #0b1210;
      --panel: #121b19;
      --panel-2: #182320;
      --ink: #e8efec;
      --ink-2: #b3c2bd;
      --ink-3: #879791;
      --rule: #24322e;
      --accent: #4fbfab;
      --accent-soft: #10312c;
      --good: #57b483;
      --bad: #e0705a;
      --warn: #cfa04a;
      --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 10px 30px -14px rgba(0, 0, 0, .7);
    }
  }
  :root[data-theme="dark"] {
    --ground: #0b1210;
    --panel: #121b19;
    --panel-2: #182320;
    --ink: #e8efec;
    --ink-2: #b3c2bd;
    --ink-3: #879791;
    --rule: #24322e;
    --accent: #4fbfab;
    --accent-soft: #10312c;
    --good: #57b483;
    --bad: #e0705a;
    --warn: #cfa04a;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 10px 30px -14px rgba(0, 0, 0, .7);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--f-body);
    font-size: 15px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .num { font-family: var(--f-mono); font-variant-numeric: tabular-nums; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 40px 24px 96px; display: flex; flex-direction: column; gap: 40px; }

  /* masthead */
  .mast { display: flex; flex-direction: column; gap: 14px; }
  .eyebrow {
    font-family: var(--f-mono); font-size: 11px; letter-spacing: .16em;
    text-transform: uppercase; color: var(--accent);
  }
  h1 {
    font-family: var(--f-display); font-weight: 800;
    font-size: clamp(30px, 5vw, 46px); line-height: 1.05; margin: 0;
    letter-spacing: -.02em; text-wrap: balance;
  }
  .dek { margin: 0; max-width: 62ch; color: var(--ink-2); font-size: 16px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 20px; font-family: var(--f-mono); font-size: 12px; color: var(--ink-3); }
  .meta b { color: var(--ink-2); font-weight: 600; }

  /* invariants band */
  .band { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); border-radius: 10px; overflow: hidden; }
  .inv { background: var(--panel); padding: 12px 14px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .inv__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); flex: none; transform: translateY(-1px); }
  .inv--red .inv__dot { background: var(--bad); }
  .inv__name { font-size: 12.5px; color: var(--ink-3); }
  .inv__val { font-family: var(--f-mono); font-size: 12.5px; color: var(--ink); margin-left: auto; }

  section { display: flex; flex-direction: column; gap: 16px; }
  h2 {
    font-family: var(--f-display); font-weight: 600; font-size: 20px; margin: 0;
    letter-spacing: -.01em;
    padding-bottom: 10px; border-bottom: 1px solid var(--rule);
  }
  .lede { margin: 0; color: var(--ink-2); max-width: 68ch; }

  /* reference-arm notice */
  .notice { border: 1px solid var(--rule); border-left: 3px solid var(--warn); border-radius: 8px; background: var(--panel); padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; box-shadow: var(--shadow); }
  .notice__top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .notice__top h3 { font-family: var(--f-display); font-size: 16px; margin: 0; font-weight: 600; }
  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  .notice th, .notice td { text-align: left; vertical-align: top; padding: 8px 14px 8px 0; border-top: 1px solid var(--rule); }
  .notice th { font-weight: 500; color: var(--ink); white-space: nowrap; font-family: var(--f-mono); font-size: 12.5px; }
  .notice td { color: var(--ink-2); }
  .unblock { font-size: 13.5px; color: var(--ink-2); background: var(--accent-soft); border-radius: 6px; padding: 10px 12px; }
  .unblock b { color: var(--ink); }

  /* dimension scoreboard */
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
  .dim { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 12px; box-shadow: var(--shadow); }
  .dim__title { font-family: var(--f-display); font-size: 15px; font-weight: 600; margin: 0; letter-spacing: -.005em; }
  .dim__bar { height: 5px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
  .dim__fill { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
  .dim__stats { display: flex; gap: 20px; margin: 0; }
  .dim__stats div { display: flex; flex-direction: column; gap: 1px; }
  .dim__stats dt { font-family: var(--f-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
  .dim__stats dd { margin: 0; font-size: 18px; font-weight: 600; }
  .of { color: var(--ink-3); font-size: 13px; font-weight: 400; }

  /* rounds */
  ol.rounds { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0; }
  .round { display: grid; grid-template-columns: 46px 1fr; gap: 16px; }
  .round__mark { display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .round__n {
    width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
    font-size: 12.5px; font-weight: 600; background: var(--panel); color: var(--ink-2);
    border: 1px solid var(--rule); flex: none;
  }
  .round:not(:last-child) .round__mark::after { content: ""; width: 1px; flex: 1; background: var(--rule); }
  .round--done .round__n { background: var(--accent); color: #fff; border-color: var(--accent); }
  .round__body { padding-bottom: 26px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .round__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .round__head h3 { font-family: var(--f-display); font-size: 17px; margin: 0; font-weight: 600; }
  .tag {
    font-family: var(--f-mono); font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase;
    padding: 2px 8px; border-radius: 20px; border: 1px solid var(--rule); color: var(--ink-3);
  }
  .tag--done { color: var(--good); border-color: color-mix(in srgb, var(--good) 40%, transparent); }
  .tag--running { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }

  .pair { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-family: var(--f-mono); font-size: 12.5px; }
  .pair__side { background: var(--panel-2); border: 1px solid var(--rule); border-radius: 6px; padding: 4px 10px; }
  .pair__vs { color: var(--ink-3); }

  .facts { margin: 0; display: flex; flex-direction: column; gap: 8px; }
  .facts > div { display: grid; grid-template-columns: 108px 1fr; gap: 14px; align-items: start; }
  .facts dt { font-family: var(--f-mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); padding-top: 3px; }
  .facts dd { margin: 0; color: var(--ink-2); }

  .evals { display: flex; flex-wrap: wrap; gap: 8px; }
  .ev { display: flex; gap: 8px; align-items: baseline; background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; padding: 5px 10px; }
  .ev__k { font-size: 11.5px; color: var(--ink-3); }
  .ev__v { font-size: 12.5px; font-weight: 600; }

  /* history */
  .hist th, .hist td { padding: 8px 12px; border-bottom: 1px solid var(--rule); text-align: left; }
  .hist thead th { font-family: var(--f-mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); font-weight: 400; }
  .hist .r { text-align: right; }
  .hist .up { color: var(--good); }
  .hist .down { color: var(--bad); }
  .empty { margin: 0; color: var(--ink-3); font-size: 14px; border: 1px dashed var(--rule); border-radius: 8px; padding: 16px; }

  footer { border-top: 1px solid var(--rule); padding-top: 16px; color: var(--ink-3); font-size: 12.5px; font-family: var(--f-mono); }

  @media (max-width: 560px) {
    .facts > div { grid-template-columns: 1fr; gap: 2px; }
    .round { grid-template-columns: 34px 1fr; gap: 12px; }
  }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>

<div class="wrap">
  <header class="mast">
    <p class="eyebrow">Adversarial bench log</p>
    <h1>Six dimensions, measured against themselves</h1>
    <p class="dek">${esc(data.app)} is being improved on the things that do not depend on model size — whether an answer can be checked, whether a plan is honest about what it did, whether a tool call really happened, how fast something usable appears, what happens when it breaks, and how it looks doing it. Every claim on this page is a measurement. Nothing is listed as improved until a suite says so.</p>
    <div class="meta">
      <span>baseline <b>${esc(data.baseline)}</b></span>
      <span>local model <b>${esc(data.localModel)}</b></span>
      <span>updated <b>${esc(data.updated)}</b></span>
    </div>
  </header>

  <div class="band">
${invariants}
  </div>

  <section>
    <h2>What the comparison is, and is not</h2>
    <div class="notice">
      <div class="notice__top">
        <h3>The reference arm is blocked</h3>
        <span class="tag tag--running">unresolved</span>
      </div>
      <p class="lede">${esc(data.referenceArm.summary)}</p>
      <div class="tablewrap">
        <table>
          <tbody>
${routes}
          </tbody>
        </table>
      </div>
      <p class="unblock"><b>Cheapest unblock:</b> ${esc(data.referenceArm.cheapestUnblock)}</p>
    </div>
    <p class="lede"><b>What runs instead, every round:</b> ${esc(data.arms.note)} Arm A is <span class="num">${esc(data.arms.A)}</span>; arm B is <span class="num">${esc(data.arms.B)}</span>.</p>
  </section>

  <section>
    <h2>High-severity gaps closed, by dimension</h2>
    <p class="lede">Counts come from an audit that required a <span class="num">file:line</span> or an executed probe for every entry. A gap is only moved to <em>closed</em> when a mechanical eval case covers it.</p>
    <div class="grid">
${dims}
    </div>
  </section>

  <section>
    <h2>Rounds</h2>
    <ol class="rounds">
${roundsHtml}
    </ol>
  </section>

  <section>
    <h2>Eval numbers over time</h2>
${historyHtml}
  </section>

  <footer>Regenerate with <span>node docs/head-to-head/build-progress.mjs</span> · source of truth is <span>docs/head-to-head/rounds.json</span></footer>
</div>
`

writeFileSync(join(HERE, 'progress.html'), html)
console.log('wrote docs/head-to-head/progress.html (' + html.length + ' bytes)')
