import { quoteTotals, unitLabel } from "../src/skn/model.mjs";
import { itemLabel } from "./pdf.mjs";

const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const encoder = new TextEncoder();
const two = value => String(value).padStart(2, "0");
const xml = value => String(value ?? "")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));

const columnName = index => {
  let name = "";
  for (let n = index; n; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

function textCell(ref, value, style = 0) {
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function numberCell(ref, value, style = 7) {
  const number = Number(value);
  return `<c r="${ref}" s="${style}"><v>${Number.isFinite(number) ? number : 0}</v></c>`;
}

function formulaCell(ref, formula, value, style = 7) {
  const number = Number(value);
  return `<c r="${ref}" s="${style}"><f>${xml(formula)}</f><v>${Number.isFinite(number) ? number : 0}</v></c>`;
}

function worksheet(q, prices) {
  const totals = quoteTotals(q);
  const columnCount = prices ? 6 : 4;
  const rows = [];
  const merges = [];
  const subtotalCells = [];
  let row = 0;

  const addRow = (cells, height) => {
    row++;
    rows.push(`<row r="${row}"${height ? ` ht="${height}" customHeight="1"` : ""}>${cells.join("")}</row>`);
    return row;
  };
  const mergedRow = (value, style, height) => {
    const number = addRow([textCell(`A${row + 1}`, value, style)], height);
    merges.push(`A${number}:${columnName(columnCount)}${number}`);
    return number;
  };

  mergedRow(q.title || "הצעת מחיר", 1, 25);
  if (q.projectNo) mergedRow(`תיק ${q.projectNo}`, 2);
  addRow([]);

  q.chapters.forEach((chapter, chapterIndex) => {
    const subchapters = chapter.subchapters.filter(subchapter => subchapter.items.length);
    if (!subchapters.length) return;
    mergedRow(`פרק ${two(chapter.num)} - ${chapter.title}`, 3, 22);

    chapter.subchapters.forEach((subchapter, subchapterIndex) => {
      if (!subchapter.items.length) return;
      mergedRow(`תת פרק ${two(subchapter.num)} - ${subchapter.title}`, 4, 21);
      const labels = ["סעיף", "תאור", "יחידה", "כמות", ...(prices ? ["מחיר יחידה", "סה\"כ"] : [])];
      addRow(labels.map((label, index) => textCell(`${columnName(index + 1)}${row + 1}`, label, 5)), 20);
      const firstItemRow = row + 1;

      subchapter.items.forEach((item, itemIndex) => {
        const itemRow = row + 1;
        const cells = [
          textCell(`A${itemRow}`, itemLabel(chapter, subchapter, item, itemIndex), 6),
          textCell(`B${itemRow}`, item.description, 6),
          textCell(`C${itemRow}`, unitLabel(item.unit), 6),
          numberCell(`D${itemRow}`, item.qty),
        ];
        if (prices) {
          cells.push(numberCell(`E${itemRow}`, item.price));
          cells.push(formulaCell(`F${itemRow}`, `D${itemRow}*E${itemRow}`, item.qty * item.price));
        }
        addRow(cells);
      });

      if (prices) {
        const subtotalRow = row + 1;
        const subtotal = totals.chapters[chapterIndex].subchapters[subchapterIndex];
        addRow([
          textCell(`A${subtotalRow}`, `סה"כ תת פרק ${two(subchapter.num)}`, 8),
          formulaCell(`F${subtotalRow}`, `SUM(F${firstItemRow}:F${row})`, subtotal, 8),
        ], 20);
        merges.push(`A${subtotalRow}:E${subtotalRow}`);
        subtotalCells.push(`F${subtotalRow}`);
      }
      addRow([]);
    });
  });

  if (prices) {
    const grandRow = row + 1;
    addRow([
      textCell(`A${grandRow}`, `סה"כ`, 9),
      formulaCell(`F${grandRow}`, subtotalCells.length ? `SUM(${subtotalCells.join(",")})` : "0", totals.total, 9),
    ], 23);
    merges.push(`A${grandRow}:E${grandRow}`);
  }

  const widths = prices
    ? [15, 52, 12, 13, 15, 16]
    : [15, 62, 12, 13];
  const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0" rightToLeft="1"/></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${cols}</cols>
  <sheetData>${rows.join("")}</sheetData>
  ${merges.length ? `<mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>` : ""}
</worksheet>`;
}

const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
  <fonts count="3">
    <font><sz val="11"/><name val="Arial"/><family val="2"/></font>
    <font><b/><sz val="16"/><name val="Arial"/><family val="2"/></font>
    <font><b/><sz val="11"/><name val="Arial"/><family val="2"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFECEFED"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD8DDDA"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD3D9D6"/></left><right style="thin"><color rgb="FFD3D9D6"/></right><top style="thin"><color rgb="FFD3D9D6"/></top><bottom style="thin"><color rgb="FFD3D9D6"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="10">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="top" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
    <xf numFmtId="164" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="164" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function workbookFiles(q, prices) {
  return [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView/></bookViews>
  <sheets><sheet name="${prices ? "אומדן עלות שיקום" : "כתב כמויות"}" sheetId="1" r:id="rId1"/></sheets>
  <calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/>
</workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ["xl/worksheets/sheet1.xml", worksheet(q, prices)],
    ["xl/styles.xml", styles],
  ];
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function header(size) {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

function zip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [path, content] of files) {
    const name = encoder.encode(path);
    const data = encoder.encode(content);
    const crc = crc32(data);
    const local = header(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(8, 0, true);
    local.view.setUint16(10, 0, true);
    local.view.setUint16(12, 0x0021, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, data.length, true);
    local.view.setUint32(22, data.length, true);
    local.view.setUint16(26, name.length, true);
    local.view.setUint16(28, 0, true);
    localParts.push(local.bytes, name, data);

    const central = header(46);
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(8, 0x0800, true);
    central.view.setUint16(10, 0, true);
    central.view.setUint16(12, 0, true);
    central.view.setUint16(14, 0x0021, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, data.length, true);
    central.view.setUint32(24, data.length, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint32(42, offset, true);
    centralParts.push(central.bytes, name);
    offset += local.bytes.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, end.bytes], { type: MIME });
}

/** Create a right-to-left Excel workbook. Price-less workbooks contain no price columns or totals. */
export function quoteToXlsx(q, { prices }) {
  return zip(workbookFiles(q, prices));
}

export const XLSX_MIME = MIME;
