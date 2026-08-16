/**
 * analyze_file — a mechanical profile of a tabular attachment, computed by
 * stdlib-only Python inside the Workbench sandbox and formatted here. No model
 * call: the model starts from facts about the data (shape, types, nulls,
 * ranges, top values, a head) instead of a 20K-character slice of it. This is
 * the "describe the data before analysing it" step of the data-analysis
 * playbook, done by the app.
 *
 * Formats: CSV/TSV (csv module, dialect sniffed), JSON/JSONL (array of
 * objects → table; anything else → a structural summary), XLSX (zipfile +
 * shared strings + sheet XML; the first sheet unless one is named). Bounded:
 * PROFILE_MAX_ROWS rows are read; the report says when it stopped early.
 */

export const PROFILE_MAX_ROWS = 200_000
export const PROFILE_HEAD_ROWS = 5
export const PROFILE_TOP_VALUES = 5
export const PROFILE_MAX_COLUMNS = 80

/** Runs inside the sandbox; prints one JSON object. `FILE` and `SHEET` are substituted. */
export const PROFILE_SCRIPT = String.raw`
import csv, io, json, math, os, re, statistics, sys, zipfile
from collections import Counter
from xml.etree import ElementTree as ET

FILE = __FILE__
SHEET = __SHEET__
MAX_ROWS = __MAX_ROWS__
HEAD = __HEAD__
TOPN = __TOPN__
MAX_COLS = __MAX_COLS__

def load_rows(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.xlsx', '.xlsm'):
        return load_xlsx(path)
    if ext in ('.json', '.jsonl'):
        return load_json(path, ext)
    return load_csv(path)

def load_csv(path):
    with open(path, 'rb') as fb:
        raw = fb.read()
    for enc in ('utf-8-sig', 'utf-8', 'latin-1'):
        try:
            text = raw.decode(enc); break
        except UnicodeDecodeError:
            continue
    sample = text[:20000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=',\t;|')
    except csv.Error:
        dialect = csv.excel_tab if path.lower().endswith('.tsv') else csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    rows = []
    truncated = False
    for i, r in enumerate(reader):
        if i > MAX_ROWS:
            truncated = True; break
        rows.append(r)
    if not rows:
        return {'columns': [], 'rows': [], 'note': 'empty file', 'truncated': False, 'kind': 'csv'}
    header = [h.strip() for h in rows[0]]
    body = rows[1:]
    return {'columns': header, 'rows': body, 'truncated': truncated, 'kind': 'csv', 'delimiter': dialect.delimiter}

def load_json(path, ext):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        text = f.read()
    records = None
    if ext == '.jsonl':
        records = [json.loads(l) for l in text.splitlines() if l.strip()][:MAX_ROWS+1]
    else:
        data = json.loads(text)
        if isinstance(data, list):
            records = data
        elif isinstance(data, dict):
            # A dict with exactly one list-of-dicts value is a table with a wrapper.
            lists = [v for v in data.values() if isinstance(v, list) and v and isinstance(v[0], dict)]
            if len(lists) == 1:
                records = lists[0]
            else:
                return {'columns': [], 'rows': [], 'kind': 'json-structure', 'structure': describe_json(data), 'truncated': False}
    if not records or not isinstance(records[0], dict):
        return {'columns': [], 'rows': [], 'kind': 'json-structure', 'structure': describe_json(records if records is not None else text[:200]), 'truncated': False}
    truncated = len(records) > MAX_ROWS
    records = records[:MAX_ROWS]
    cols = []
    for r in records[:2000]:
        for k in r.keys():
            if k not in cols: cols.append(k)
    rows = [[('' if r.get(c) is None else (json.dumps(r.get(c)) if isinstance(r.get(c), (dict, list)) else str(r.get(c)))) for c in cols] for r in records]
    return {'columns': cols, 'rows': rows, 'truncated': truncated, 'kind': 'json'}

def describe_json(v, depth=0):
    if depth > 3: return '…'
    if isinstance(v, dict):
        return {k: describe_json(x, depth+1) for k, x in list(v.items())[:20]}
    if isinstance(v, list):
        return ['list of %d' % len(v), describe_json(v[0], depth+1) if v else None]
    return type(v).__name__

def load_xlsx(path):
    z = zipfile.ZipFile(path)
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in root.findall('m:si', ns):
            shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % ns['m'])))
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    sheets = [(s.get('name'), s.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')) for s in wb.find('m:sheets', ns)]
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    rid_to_target = {r.get('Id'): r.get('Target') for r in rels}
    chosen = None
    for name, rid in sheets:
        if SHEET is None or name == SHEET:
            chosen = (name, rid_to_target.get(rid)); break
    if chosen is None:
        raise ValueError('sheet %r not found; sheets: %s' % (SHEET, ', '.join(n for n, _ in sheets)))
    target = chosen[1]
    target = target if target.startswith('xl/') else 'xl/' + target.lstrip('/')
    root = ET.fromstring(z.read(target))
    def col_index(ref):
        letters = re.match(r'[A-Z]+', ref).group(0)
        n = 0
        for ch in letters: n = n * 26 + (ord(ch) - 64)
        return n - 1
    rows = []
    truncated = False
    for i, row in enumerate(root.iter('{%s}row' % ns['m'])):
        if i > MAX_ROWS:
            truncated = True; break
        cells = {}
        for c in row.findall('m:c', ns):
            ref = c.get('r') or ''
            t = c.get('t')
            v = c.find('m:v', ns)
            if t == 's' and v is not None:
                val = shared[int(v.text)] if v.text and v.text.isdigit() and int(v.text) < len(shared) else ''
            elif t == 'inlineStr':
                val = ''.join(x.text or '' for x in c.iter('{%s}t' % ns['m']))
            elif t == 'b' and v is not None:
                val = 'TRUE' if v.text == '1' else 'FALSE'
            else:
                val = v.text if v is not None and v.text is not None else ''
            cells[col_index(ref) if ref else len(cells)] = val
        width = (max(cells) + 1) if cells else 0
        rows.append([cells.get(j, '') for j in range(width)])
    if not rows:
        return {'columns': [], 'rows': [], 'kind': 'xlsx', 'sheet': chosen[0], 'sheets': [n for n, _ in sheets], 'truncated': False, 'note': 'empty sheet'}
    width = max(len(r) for r in rows)
    rows = [r + [''] * (width - len(r)) for r in rows]
    header = [str(h).strip() or ('col%d' % (i+1)) for i, h in enumerate(rows[0])]
    return {'columns': header, 'rows': rows[1:], 'kind': 'xlsx', 'sheet': chosen[0], 'sheets': [n for n, _ in sheets], 'truncated': truncated}

NUM_RE = re.compile(r'^\s*[-+]?(\$|€|£)?\s*[\d,]*\.?\d+(e[-+]?\d+)?\s*%?\s*$', re.I)
DATE_RE = re.compile(r'^\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}/\d{1,2}/\d{2,4}|\d{1,2}-\d{1,2}-\d{2,4})([ T]\d{1,2}:\d{2}(:\d{2})?)?\s*$')
NULLS = {'', 'na', 'n/a', 'null', 'none', 'nan', '-', '--', '?'}

def to_num(s):
    t = s.strip().replace(',', '').replace('$', '').replace('€', '').replace('£', '')
    pct = t.endswith('%')
    if pct: t = t[:-1]
    try:
        v = float(t)
        return v / 100 if pct else v
    except ValueError:
        return None

def profile_column(name, values):
    n = len(values)
    nonnull = [v for v in values if v is not None and str(v).strip().lower() not in NULLS]
    nulls = n - len(nonnull)
    out = {'name': name, 'nonNull': len(nonnull), 'nulls': nulls}
    if not nonnull:
        out['type'] = 'empty'; return out
    sample = nonnull[:5000]
    num_hits = sum(1 for v in sample if NUM_RE.match(str(v)))
    date_hits = sum(1 for v in sample if DATE_RE.match(str(v)))
    bool_hits = sum(1 for v in sample if str(v).strip().lower() in ('true','false','yes','no','y','n'))
    ratio = lambda h: h / max(1, len(sample))
    if ratio(num_hits) >= 0.95:
        nums = [x for x in (to_num(str(v)) for v in nonnull) if x is not None]
        out['type'] = 'integer' if all(float(x).is_integer() for x in nums[:5000]) else 'number'
        if nums:
            nums_sorted = sorted(nums)
            out['min'] = nums_sorted[0]; out['max'] = nums_sorted[-1]
            out['mean'] = statistics.fmean(nums); out['median'] = statistics.median(nums_sorted)
            if len(nums) > 1: out['stdev'] = statistics.pstdev(nums)
            out['sum'] = sum(nums)
    elif ratio(date_hits) >= 0.9:
        out['type'] = 'date'
        s = sorted(str(v).strip() for v in nonnull)
        out['min'] = s[0]; out['max'] = s[-1]
    elif ratio(bool_hits) >= 0.95:
        out['type'] = 'boolean'
        c = Counter(str(v).strip().lower() for v in nonnull); out['top'] = c.most_common(TOPN)
    else:
        out['type'] = 'text'
        c = Counter(str(v).strip() for v in nonnull)
        out['distinct'] = len(c)
        out['top'] = [(k[:60], v) for k, v in c.most_common(TOPN)]
        lens = [len(str(v)) for v in sample]
        out['avgLen'] = round(sum(lens) / len(lens), 1)
    return out

try:
    table = load_rows(FILE)
    cols = table.get('columns', [])
    rows = table.get('rows', [])
    report = {'file': os.path.basename(FILE), 'kind': table.get('kind'), 'rows': len(rows), 'columns': len(cols), 'truncated': table.get('truncated', False)}
    for k in ('sheet', 'sheets', 'delimiter', 'note', 'structure'):
        if k in table: report[k] = table[k]
    if cols:
        width = len(cols)
        ragged = sum(1 for r in rows if len(r) != width)
        if ragged: report['raggedRows'] = ragged
        norm = [r + [''] * (width - len(r)) if len(r) < width else r[:width] for r in rows]
        report['profile'] = [profile_column(c, [r[i] for r in norm]) for i, c in enumerate(cols[:MAX_COLS])]
        if width > MAX_COLS: report['columnsOmitted'] = width - MAX_COLS
        report['head'] = [cols[:MAX_COLS]] + [[str(x)[:80] for x in r[:MAX_COLS]] for r in norm[:HEAD]]
        dup = len(norm) - len({tuple(r) for r in norm})
        if dup: report['duplicateRows'] = dup
    print('__PROFILE__' + json.dumps(report, default=str))
except Exception as e:
    print('__PROFILE__' + json.dumps({'error': '%s: %s' % (type(e).__name__, e)}))
`

export interface ColumnProfile {
  name: string
  type?: string
  nonNull: number
  nulls: number
  min?: number | string
  max?: number | string
  mean?: number
  median?: number
  stdev?: number
  sum?: number
  distinct?: number
  top?: [string, number][]
  avgLen?: number
}

export interface FileProfile {
  file: string
  kind?: string
  rows: number
  columns: number
  truncated: boolean
  sheet?: string
  sheets?: string[]
  delimiter?: string
  note?: string
  structure?: unknown
  raggedRows?: number
  duplicateRows?: number
  columnsOmitted?: number
  profile?: ColumnProfile[]
  head?: string[][]
  error?: string
}

/** Build the script for one file. */
export function profileScript(file: string, sheet: string | null): string {
  return PROFILE_SCRIPT.replace('__FILE__', JSON.stringify(file))
    .replace('__SHEET__', sheet === null ? 'None' : JSON.stringify(sheet))
    .replace('__MAX_ROWS__', String(PROFILE_MAX_ROWS))
    .replace('__HEAD__', String(PROFILE_HEAD_ROWS))
    .replace('__TOPN__', String(PROFILE_TOP_VALUES))
    .replace('__MAX_COLS__', String(PROFILE_MAX_COLUMNS))
}

/** Pull the JSON report out of the sandbox's stdout. */
export function parseProfile(stdout: string): FileProfile | null {
  const i = stdout.lastIndexOf('__PROFILE__')
  if (i < 0) return null
  try {
    return JSON.parse(stdout.slice(i + '__PROFILE__'.length).trim().split('\n')[0]) as FileProfile
  } catch {
    return null
  }
}

function num(v: number | string | undefined): string {
  if (typeof v !== 'number') return String(v ?? '')
  if (Number.isInteger(v)) return v.toLocaleString('en-US')
  return Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(Math.round(v * 10000) / 10000)
}

/** The report as the model sees it — compact, factual, and it names the file path under /work. */
export function formatProfile(p: FileProfile): string {
  if (p.error) return `Could not profile ${p.file}: ${p.error}`
  const lines: string[] = []
  const what = p.kind === 'xlsx' ? `spreadsheet (sheet "${p.sheet}"${p.sheets && p.sheets.length > 1 ? `; sheets: ${p.sheets.join(', ')}` : ''})` : p.kind === 'json' ? 'JSON records' : p.kind === 'json-structure' ? 'JSON (not tabular)' : `delimited text (${p.delimiter === '\t' ? 'tab' : `"${p.delimiter ?? ','}"`}-separated)`
  lines.push(`Profile of /work/${p.file} — ${what}: ${p.rows.toLocaleString('en-US')} data row(s) × ${p.columns} column(s)${p.truncated ? ` (read stopped at ${PROFILE_MAX_ROWS.toLocaleString('en-US')} rows — counts below are for the rows read)` : ''}.`)
  if (p.note) lines.push(`Note: ${p.note}.`)
  if (p.structure !== undefined) lines.push(`Structure: ${JSON.stringify(p.structure).slice(0, 1500)}`)
  if (p.raggedRows) lines.push(`Warning: ${p.raggedRows} row(s) have a different number of fields than the header.`)
  if (p.duplicateRows) lines.push(`${p.duplicateRows} exact duplicate row(s).`)
  if (p.profile && p.profile.length) {
    lines.push('', 'Columns:')
    for (const c of p.profile) {
      const bits: string[] = [`${c.type ?? '?'}`, `${c.nonNull.toLocaleString('en-US')} non-null`]
      if (c.nulls) bits.push(`${c.nulls.toLocaleString('en-US')} null/blank`)
      if (c.type === 'integer' || c.type === 'number') {
        bits.push(`min ${num(c.min)}`, `max ${num(c.max)}`, `mean ${num(c.mean)}`, `median ${num(c.median)}`)
        if (c.sum !== undefined) bits.push(`sum ${num(c.sum)}`)
      } else if (c.type === 'date') {
        bits.push(`from ${c.min} to ${c.max}`)
      } else if (c.type === 'text' || c.type === 'boolean') {
        if (c.distinct !== undefined) bits.push(`${c.distinct.toLocaleString('en-US')} distinct`)
        if (c.top && c.top.length) bits.push(`top: ${c.top.map(([k, n]) => `"${k}" ×${n}`).join(', ')}`)
      }
      lines.push(`- ${c.name}: ${bits.join(' · ')}`)
    }
    if (p.columnsOmitted) lines.push(`(${p.columnsOmitted} more column(s) not profiled)`)
  }
  if (p.head && p.head.length > 1) {
    lines.push('', `First ${p.head.length - 1} row(s):`)
    lines.push('| ' + p.head[0].join(' | ') + ' |')
    lines.push('|' + p.head[0].map(() => ' --- ').join('|') + '|')
    for (const r of p.head.slice(1)) lines.push('| ' + r.map((x) => x.replace(/\|/g, '/')).join(' | ') + ' |')
  }
  lines.push('', 'These figures were computed from the file, not estimated. For any further number, compute it with run_python reading the same path; do not eyeball totals or percentages from the head.')
  return lines.join('\n')
}
