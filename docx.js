// A Word document (.docx) of a transcript: the title, one line under it (date, length or the call), then one
// paragraph per line of text, with no times. A .docx is a zip of a few XML files; these are the fewest that Word,
// LibreOffice and Google Docs open. The phone writes the same document (core …/data/Docx.kt).

import { writeZip } from './zip.js';

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Characters XML 1.0 cannot carry are dropped; the five special ones escaped. */
export function xmlText(s) {
  return String(s ?? '')
    .replace(/[^\u0009\u000a\u000d -퟿-�\u{10000}-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Word's language tag for spell checking: Serbian in the script shown, or English. */
export function docxLang(lang, latin) {
  if (lang === 'en') return 'en-US';
  return latin ? 'sr-Latn-RS' : 'sr-Cyrl-RS';
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A paragraph; [p] is its text, or {name, text} for a speaker's turn: the name in bold, then the text. */
function para(p, style) {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  const text = typeof p === 'object' && p ? p.text : p;
  const name = typeof p === 'object' && p?.name ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlText(p.name)}: </w:t></w:r>` : '';
  // A line break inside a line stays a break, not a new paragraph.
  const runs = String(text ?? '').split('\n').map((part, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlText(part)}</w:t>`).join('');
  return `<w:p>${pPr}${name}<w:r>${runs}</w:r></w:p>`;
}

function styles(lang) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="${lang}" w:eastAsia="${lang}" w:bidi="${lang}"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="360"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
</w:styles>`;
}

const CELL_BORDER = '<w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>';
const TEXT_WIDTH = 9026; // A4 less the two 1440 margins, in twentieths of a point

function cell(text, width, bold = false) {
  const rPr = bold ? '<w:rPr><w:b/></w:rPr>' : '';
  const runs = String(text ?? '').split('\n').map((part, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlText(part)}</w:t>`).join('');
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r>${rPr}${runs}</w:r></w:p></w:tc>`;
}

/**
 * A table of the columns the user chose ({head: ['Vreme', 'Tekst'], widths: [1100, null], rows: [['00:12', '…']]}).
 * A null width takes what the others leave; the header row repeats on every page.
 */
function table({ head, widths, rows }) {
  const fixed = widths.reduce((a, w) => a + (w || 0), 0);
  const free = widths.filter((w) => !w).length || 1;
  const ws = widths.map((w) => w || Math.floor((TEXT_WIDTH - fixed) / free));
  const grid = ws.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const headRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${head.map((h, k) => cell(h, ws[k], true)).join('')}</w:tr>`;
  const body = rows.map((r) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${r.map((c, k) => cell(c, ws[k])).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${TEXT_WIDTH}" w:type="dxa"/><w:tblBorders>${CELL_BORDER}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${headRow}${body}</w:tbl><w:p/>`;
}

/**
 * The .docx bytes. [paragraphs] are the texts as shown (script already applied), or {name, text} for a speaker's turn
 * (speakers.js runs); with [table] (columns the user chose: time, speaker, text) the text is that table instead.
 * [lang] is a tag from docxLang.
 * @param {{title: string, subtitle?: string|null, paragraphs?: Array<string|{name: string, text: string}>,
 *          table?: {head: string[], widths: Array<number|null>, rows: string[][]}, lang: string, date?: Date}} doc
 */
export function toDocx({ title, subtitle = null, paragraphs = [], table: tbl = null, lang, date = new Date() }) {
  const text = tbl ? table(tbl) : paragraphs.map((p) => para(p)).join('');
  const body = [para(title, 'Title'), subtitle ? para(subtitle, 'Subtitle') : '', text].join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const iso = date.toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(title)}</dc:title><dc:language>${lang}</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created></cp:coreProperties>`;
  return writeZip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles(lang) },
    { name: 'docProps/core.xml', data: core },
  ], date);
}
