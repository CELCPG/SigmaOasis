import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { crc32, readZip, writeZip } from '../src/main/agent/zip'
import { columnName, csvCell, docxToText, parseCsv, pptxToText, readDocument, sheetsToXlsx, textToDocx, toCsv, writeDocument, xlsxToSheets, xlsxToText } from '../src/main/agent/documents'

/** v4.0 (C1, an experiment): documents read and written without a library. */

describe('the ZIP framing', () => {
  test('what is written is read back, entry for entry', () => {
    const zip = writeZip([
      { name: 'a.txt', data: 'hello' },
      { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 255]) },
      { name: 'empty', data: '' }
    ])
    const back = readZip(zip)
    assert.deepEqual([...back.keys()], ['a.txt', 'dir/b.bin', 'empty'])
    assert.equal(back.get('a.txt')!.toString(), 'hello')
    assert.deepEqual([...back.get('dir/b.bin')!], [0, 1, 2, 255])
    assert.equal(back.get('empty')!.length, 0)
  })

  test('the same input makes the same bytes', () => {
    const a = writeZip([{ name: 'x', data: 'same' }])
    const b = writeZip([{ name: 'x', data: 'same' }])
    assert.ok(a.equals(b))
  })

  test('crc32 is the standard one', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
    assert.equal(crc32(Buffer.alloc(0)), 0)
  })

  test('not a ZIP is said', () => {
    assert.throws(() => readZip(Buffer.from('%PDF-1.4 nope')), /not a ZIP archive/)
  })
})

describe('Word', () => {
  test('Markdown to .docx and back keeps headings, paragraphs, bullets and a table', () => {
    const md = ['# Quarterly letter', '', 'Dear team,', '', 'Two things happened:', '', '- Sales rose', '- Costs fell 3%', '', '## Numbers', '', '| Item | Q1 | Q2 |', '| --- | --- | --- |', '| Sales | 10 | 12 |', '| Costs | 8 | 7.5 |', '', 'Regards & thanks <all>.'].join('\n')
    const bytes = textToDocx(md)
    const zip = readZip(bytes)
    assert.ok(zip.has('word/document.xml') && zip.has('[Content_Types].xml') && zip.has('_rels/.rels') && zip.has('word/styles.xml'))
    const text = docxToText(bytes)
    assert.equal(text, ['# Quarterly letter', '', 'Dear team,', '', 'Two things happened:', '', '- Sales rose', '- Costs fell 3%', '', '## Numbers', '', '| Item | Q1 | Q2 |', '| --- | --- | --- |', '| Sales | 10 | 12 |', '| Costs | 8 | 7.5 |', '', 'Regards & thanks <all>.'].join('\n'))
  })

  test('a numbered-list paragraph and a Heading style from Word itself read as a bullet and a heading', () => {
    const doc = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">first </w:t></w:r><w:r><w:t>step</w:t></w:r></w:p><w:p/></w:body></w:document>`
    const bytes = writeZip([{ name: 'word/document.xml', data: doc }])
    assert.equal(docxToText(bytes), '## Plan\n- first step')
  })

  test('not a Word file is said', () => {
    assert.throws(() => docxToText(writeZip([{ name: 'x', data: 'y' }])), /no word\/document\.xml/)
  })
})

describe('Excel', () => {
  test('sheets to .xlsx and back keeps names, numbers, text, booleans and blanks', () => {
    const bytes = sheetsToXlsx([
      { name: 'Sales', rows: [['Item', 'Amount', 'Paid'], ['Widget', 12.5, true], ['Gadget "big"', null, false], [null, 3, null]] },
      { name: 'Notes', rows: [['a|b']] }
    ])
    const sheets = xlsxToSheets(bytes)
    assert.deepEqual(sheets, [
      { name: 'Sales', rows: [['Item', 'Amount', 'Paid'], ['Widget', 12.5, true], ['Gadget "big"', null, false], [null, 3, null]] },
      { name: 'Notes', rows: [['a|b']] }
    ])
    assert.equal(xlsxToText(bytes), ['## Sheet: Sales', '| Item | Amount | Paid |', '| --- | --- | --- |', '| Widget | 12.5 | true |', '| Gadget "big" |  | false |', '|  | 3 |  |', '', '## Sheet: Notes', '| a\\|b |', '| --- |'].join('\n'))
  })

  test('a workbook with shared strings, as Excel writes them, reads by workbook order and relationship', () => {
    const bytes = writeZip([
      { name: 'xl/workbook.xml', data: '<workbook xmlns:r="r"><sheets><sheet name="Second" sheetId="2" r:id="rId2"/><sheet name="First" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t" Target="/xl/worksheets/sheet2.xml"/></Relationships>' },
      { name: 'xl/sharedStrings.xml', data: '<sst><si><t>Name</t></si><si><r><t>Tot</t></r><r><t>al</t></r></si></sst>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>7</v></c></row><row r="2"><c r="B2" t="str"><v>=SUM</v></c></row></sheetData></worksheet>' },
      { name: 'xl/worksheets/sheet2.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row></sheetData></worksheet>' }
    ])
    assert.deepEqual(xlsxToSheets(bytes), [
      { name: 'Second', rows: [['Total']] },
      { name: 'First', rows: [['Name', null, 7], [null, '=SUM', null]] }
    ])
  })

  test('column names', () => {
    assert.deepEqual([0, 25, 26, 27, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  })

  test('CSV both ways, with quotes, commas and numbers', () => {
    const rows = parseCsv('name,amount,note\n"Smith, J",12.50,"said ""hi"""\nLee,3,\n')
    assert.deepEqual(rows, [['name', 'amount', 'note'], ['Smith, J', '12.50', 'said "hi"'], ['Lee', '3', '']])
    assert.deepEqual(rows[1]!.map(csvCell), ['Smith, J', 12.5, 'said "hi"'])
    assert.equal(toCsv([['a', 'b,c', 1], [null, 'x"y', true]]), 'a,"b,c",1\n,"x""y",true\n')
  })
})

describe('PowerPoint', () => {
  test('slides in number order, a line per paragraph', () => {
    const slide = (t: string[]): string => `<p:sld><p:cSld>${t.map((x) => `<a:p><a:r><a:t>${x}</a:t></a:r></a:p>`).join('')}</p:cSld></p:sld>`
    const bytes = writeZip([
      { name: 'ppt/slides/slide10.xml', data: slide(['Last']) },
      { name: 'ppt/slides/slide2.xml', data: slide(['Second', 'more']) },
      { name: 'ppt/slides/slide1.xml', data: slide(['Title &amp; sub']) }
    ])
    assert.equal(pptxToText(bytes), '## Slide 1\nTitle & sub\n\n## Slide 2\nSecond\nmore\n\n## Slide 10\nLast')
  })
})

describe('the two doors', () => {
  test('read_document by extension; PDF needs the host; a kind it cannot read is said', async () => {
    assert.equal(await readDocument('a.csv', Buffer.from('x,y\n')), 'x,y\n')
    assert.equal(await readDocument('a.txt', Buffer.from('plain')), 'plain')
    await assert.rejects(readDocument('a.pdf', Buffer.from('%PDF')), /needs the app/)
    assert.equal(await readDocument('a.pdf', Buffer.from('%PDF'), async () => 'from the extractor'), 'from the extractor')
    await assert.rejects(readDocument('a.json', Buffer.from('{}')), /use read_file/)
    assert.equal(await readDocument('r.docx', textToDocx('# Hi\n\nthere')), '# Hi\n\nthere')
  })

  test('write_document: Markdown to .docx, rows or CSV to .xlsx and .csv, text to .md; the wrong input is said', () => {
    assert.equal(docxToText(writeDocument('out.docx', { content: '## T\n\np' })), '## T\n\np')
    assert.deepEqual(xlsxToSheets(writeDocument('out.xlsx', { content: 'a,b\n1,2\n' })), [{ name: 'Sheet1', rows: [['a', 'b'], [1, 2]] }])
    assert.deepEqual(xlsxToSheets(writeDocument('out.xlsx', { sheets: [{ name: 'S', rows: [['x', 1]] }] })), [{ name: 'S', rows: [['x', 1]] }])
    assert.equal(writeDocument('out.csv', { sheets: [{ name: 'S', rows: [['x', 1]] }] }).toString(), 'x,1\n')
    assert.equal(writeDocument('out.md', { content: '# m' }).toString(), '# m')
    assert.throws(() => writeDocument('out.docx', {}), /Give content/)
    assert.throws(() => writeDocument('out.xlsx', {}), /Give sheets/)
    assert.throws(() => writeDocument('out.pptx', { content: 'x' }), /use write_file/)
  })
})
