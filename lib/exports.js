// Excel and PDF exporters. Both render the generic report shape from reports.js,
// so every report type is exportable in both formats with no per-type code.
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { buildReport } = require('./reports');
const { prettyKey } = require('./text');

// machine keys shown to humans get spaces + a capital: "in_progress" → "In progress"
const PRETTY_COLS = new Set(['status', 'priority', 'category']);
const cellValue = (row, col) => PRETTY_COLS.has(col.key) && row[col.key] ? prettyKey(row[col.key]) : (row[col.key] ?? '');

const BRAND = '#4F46E5';
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);

// ---------------- Excel ----------------
async function exportExcel(type, query, res) {
  const report = buildReport(type, query);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TimePort';
  wb.created = new Date();

  // Summary sheet
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 30 }, { width: 40 }];
  sum.addRow([report.title]).font = { size: 16, bold: true, color: { argb: 'FF4F46E5' } };
  sum.addRow([report.subtitle || '']);
  sum.addRow([`Generated ${new Date(report.generated_at).toLocaleString()}`]).font = { size: 9, color: { argb: 'FF888888' } };
  if (report.description) {
    const dr = sum.addRow([report.description]);
    dr.font = { size: 9, italic: true, color: { argb: 'FF6B7280' } };
    dr.alignment = { wrapText: true };
    dr.height = 60;
    sum.mergeCells(`A${dr.number}:B${dr.number}`);
  }
  sum.addRow([]);
  for (const s of report.summary || []) {
    const row = sum.addRow([s.label, s.value]);
    row.getCell(1).font = { bold: true };
  }

  // Charts sheet — values plus in-cell data bars so management sees comparisons at a glance
  if (report.charts && report.charts.length) {
    const cs = wb.addWorksheet('Charts');
    cs.columns = [{ width: 42 }, { width: 12 }, { width: 12 }, { width: 34 }, { width: 34 }];
    const BAR_COLORS = ['FF94A3B8', 'FF4F46E5'];
    for (const chart of report.charts) {
      if (!chart.rows.length) continue;
      const h = cs.addRow([chart.heading]);
      h.font = { size: 12, bold: true, color: { argb: 'FF4F46E5' } };
      const head = cs.addRow(['', ...chart.series, ...chart.series.map((s) => s + ' ▮')]);
      head.font = { bold: true, size: 9, color: { argb: 'FF6B7280' } };
      const max = Math.max(...chart.rows.flatMap((r) => r.values.map(Number)), 1);
      for (const row of chart.rows) {
        const bars = row.values.map((v) => '█'.repeat(Math.max(Math.round((Number(v) / max) * 28), Number(v) > 0 ? 1 : 0)));
        const r = cs.addRow([row.label, ...row.values, ...bars]);
        bars.forEach((b, i) => {
          r.getCell(2 + chart.series.length + i).font = { color: { argb: BAR_COLORS[i % BAR_COLORS.length] }, size: 10 };
        });
      }
      cs.addRow([]);
    }
  }

  for (const section of report.sections) {
    const ws = wb.addWorksheet(section.heading.slice(0, 31).replace(/[\\\/\?\*\[\]:]/g, ' '));
    ws.columns = section.columns.map((c) => ({ key: c.key, width: c.width || 16 }));
    const header = ws.addRow(section.columns.map((c) => c.label));
    header.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
      cell.border = { bottom: { style: 'thin' } };
    });
    for (const row of section.rows) {
      const r = ws.addRow(section.columns.map((c) => cellValue(row, c)));
      // URL values become real clickable hyperlinks
      section.columns.forEach((c, i) => {
        const v = row[c.key];
        if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
          const cell = r.getCell(i + 1);
          cell.value = { text: v, hyperlink: v };
          cell.font = { color: { argb: 'FF4F76D8' }, underline: true };
        }
      });
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: section.columns.length } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${slug(report.title)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

// ---------------- PDF ----------------
function exportPdf(type, query, res) {
  const report = buildReport(type, query);
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${slug(report.title)}.pdf"`);
  doc.pipe(res);

  const pageW = doc.page.width - 80; // content width

  // Header
  doc.rect(0, 0, doc.page.width, 6).fill(BRAND);
  doc.moveDown(0.5);
  doc.fillColor('#111827').fontSize(20).font('Helvetica-Bold').text(report.title, 40, 30);
  if (report.subtitle) doc.fontSize(10).font('Helvetica').fillColor('#6b7280').text(report.subtitle);
  doc.fontSize(8).fillColor('#9ca3af').text(`Generated ${new Date(report.generated_at).toLocaleString()} · TimePort`);
  doc.moveDown(0.6);

  // "How to read this report" intro
  if (report.description) {
    const y = doc.y;
    const h = doc.heightOfString(report.description, { width: pageW - 20 }) + 16;
    doc.roundedRect(40, y, pageW, h, 5).fill('#f8f9fc');
    doc.fillColor('#374151').fontSize(8.5).font('Helvetica-Oblique')
      .text('About this report:  ', 50, y + 8, { continued: true, width: pageW - 20 })
      .font('Helvetica').text(report.description);
    doc.y = y + h + 10;
    doc.x = 40;
  }
  doc.moveDown(0.4);

  // Summary cards
  if (report.summary && report.summary.length) {
    const cardW = Math.min(110, pageW / report.summary.length - 8);
    let x = 40;
    const y = doc.y;
    for (const s of report.summary) {
      doc.roundedRect(x, y, cardW, 44, 5).fillAndStroke('#eef2ff', '#c7d2fe');
      doc.fillColor(BRAND).fontSize(13).font('Helvetica-Bold').text(String(s.value), x + 8, y + 8, { width: cardW - 16 });
      doc.fillColor('#4b5563').fontSize(7).font('Helvetica').text(s.label.toUpperCase(), x + 8, y + 28, { width: cardW - 16 });
      x += cardW + 8;
      if (x + cardW > doc.page.width - 40) break;
    }
    doc.y = y + 56;
    doc.x = 40;
  }

  // Charts — vector charts (column charts for trends, bar charts for comparisons)
  for (const chart of report.charts || []) {
    if (!chart.rows.length) continue;
    if (chart.type === 'columns') drawColumnChart(doc, chart, pageW);
    else drawBarChart(doc, chart, pageW);
  }

  // Sections as tables
  for (const section of report.sections) {
    ensureSpace(doc, 60);
    doc.moveDown(0.8);
    doc.fillColor('#111827').fontSize(13).font('Helvetica-Bold').text(section.heading, 40);
    doc.moveDown(0.3);
    drawTable(doc, section.columns, section.rows, pageW);
  }

  // Footer page numbers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor('#9ca3af')
      .text(`Page ${i + 1} of ${range.count}`, 40, doc.page.height - 30, { width: pageW, align: 'right' });
  }
  doc.end();
}

const CHART_COLORS = ['#94a3b8', '#4f46e5', '#10b981'];

// Vertical column chart — used for time-series ("effort per week")
function drawColumnChart(doc, chart, pageW) {
  const rows = chart.rows;
  const H = 110; // plot height
  ensureSpace(doc, H + 90);
  doc.moveDown(0.8);
  doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(chart.heading, 40);
  if (chart.note) doc.fillColor('#6b7280').fontSize(7.5).font('Helvetica-Oblique').text(chart.note, 40, doc.y + 2, { width: pageW });
  const y0 = doc.y + 10;
  const max = Math.max(...rows.map((r) => Number(r.values[0])), 1);
  const gap = 6;
  const bw = Math.max(Math.min(46, (pageW - (rows.length - 1) * gap) / rows.length), 6);
  let x = 40;
  // baseline
  doc.moveTo(40, y0 + H).lineTo(40 + pageW, y0 + H).strokeColor('#d1d5db').lineWidth(0.7).stroke();
  const labelStep = Math.ceil(rows.length / Math.floor(pageW / 42));
  rows.forEach((r, i) => {
    const v = Number(r.values[0]);
    const h = Math.max((v / max) * H, v > 0 ? 2 : 0);
    doc.rect(x, y0 + H - h, bw, h).fill('#4f46e5');
    if (bw >= 16) doc.fillColor('#4b5563').font('Helvetica').fontSize(6.5).text(String(v), x - 3, y0 + H - h - 9, { width: bw + 6, align: 'center' });
    if (i % labelStep === 0) doc.fillColor('#6b7280').fontSize(6).text(r.label, x - 8, y0 + H + 4, { width: bw + 16, align: 'center' });
    x += bw + gap;
  });
  doc.y = y0 + H + 20;
  doc.x = 40;
}

function drawBarChart(doc, chart, pageW) {
  const labelW = 170, valueW = 40;
  const barAreaW = pageW - labelW - valueW;
  const barH = 9, barGap = 2;
  const rowH = chart.series.length * (barH + barGap) + 8;
  const max = Math.max(...chart.rows.flatMap((r) => r.values.map(Number)), 1);

  ensureSpace(doc, 66 + Math.min(chart.rows.length, 4) * rowH);
  doc.moveDown(0.8);
  doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(chart.heading, 40);
  if (chart.note) doc.fillColor('#6b7280').fontSize(7.5).font('Helvetica-Oblique').text(chart.note, 40, doc.y + 2, { width: pageW });
  // legend
  let lx = 40;
  const ly = doc.y + 4;
  chart.series.forEach((s, i) => {
    doc.rect(lx, ly, 8, 8).fill(CHART_COLORS[i % CHART_COLORS.length]);
    doc.fillColor('#4b5563').fontSize(7.5).font('Helvetica').text(s, lx + 12, ly + 1);
    lx += 12 + doc.widthOfString(s) + 18;
  });
  let y = ly + 16;

  for (const row of chart.rows) {
    if (y + rowH > doc.page.height - 50) { doc.addPage(); y = 40; }
    doc.fillColor('#1f2937').fontSize(7.5).font('Helvetica')
      .text(String(row.label).slice(0, 44), 40, y + Math.max((rowH - 8 - 10) / 2, 0), { width: labelW - 8, height: rowH, ellipsis: true });
    row.values.forEach((v, i) => {
      const by = y + i * (barH + barGap);
      const w = Math.max((Number(v) / max) * barAreaW, Number(v) > 0 ? 2 : 0);
      doc.rect(40 + labelW, by, barAreaW, barH).fill('#f1f2f7');
      if (w) doc.rect(40 + labelW, by, w, barH).fill(CHART_COLORS[i % CHART_COLORS.length]);
      doc.fillColor('#4b5563').fontSize(7).text(String(v), 40 + labelW + barAreaW + 4, by + 1.5, { width: valueW });
    });
    y += rowH;
  }
  doc.y = y + 4;
  doc.x = 40;
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - 50) { doc.addPage(); doc.y = 40; }
}

function drawTable(doc, columns, rows, pageW) {
  const totalW = columns.reduce((s, c) => s + (c.width || 16), 0);
  const widths = columns.map((c) => ((c.width || 16) / totalW) * pageW);
  // deterministic layout: track y manually instead of relying on doc.y flow
  let y = doc.y;
  const newPageIfNeeded = (h) => {
    if (y + h > doc.page.height - 50) { doc.addPage(); y = 40; header(); }
  };
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(8);
    const cells = columns.map((c) => c.label);
    let h = 16;
    cells.forEach((t, i) => { const hh = doc.heightOfString(t, { width: widths[i] - 8 }) + 8; if (hh > h) h = hh; });
    doc.rect(40, y, pageW, h).fill(BRAND);
    let x = 40;
    cells.forEach((t, i) => { doc.fillColor('#fff').text(t, x + 4, y + 4, { width: widths[i] - 8 }); x += widths[i]; });
    y += h;
  };
  header();
  doc.font('Helvetica').fontSize(8);
  if (!rows.length) {
    doc.fillColor('#9ca3af').text('No data', 44, y + 4);
    y += 18;
  }
  rows.forEach((row, ri) => {
    const cells = columns.map((c) => String(cellValue(row, c)));
    doc.font('Helvetica').fontSize(8);
    let h = 16;
    cells.forEach((t, i) => { const hh = doc.heightOfString(t, { width: widths[i] - 8 }) + 8; if (hh > h) h = hh; });
    newPageIfNeeded(h);
    if (ri % 2 === 1) { doc.rect(40, y, pageW, h).fill('#f5f6fa'); }
    let x = 40;
    cells.forEach((t, i) => {
      if (/^https?:\/\//i.test(t)) {
        doc.fillColor('#3556b8').text(t, x + 4, y + 4, { width: widths[i] - 8, link: t, underline: true });
      } else {
        doc.fillColor('#1f2937').text(t, x + 4, y + 4, { width: widths[i] - 8 });
      }
      x += widths[i];
    });
    doc.moveTo(40, y + h).lineTo(40 + pageW, y + h).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    y += h;
  });
  doc.y = y + 4;
  doc.x = 40;
}

module.exports = { exportExcel, exportPdf };
