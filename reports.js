/*
 * PDF report generation (pdfkit). Two reports:
 *  - employeeReport(res, data)  : one employee's assessment + evaluation
 *  - executiveSummary(res, data): cycle-level summary for management
 * Brand: navy #0a1628 / red #c01d22.
 */
const PDFDocument = require('pdfkit');

const NAVY = '#0a1628', RED = '#c01d22', MUTED = '#5d6b7a', LINE = '#e3e8ee', INK = '#1c2733';

// Build the whole PDF into a buffer first, then send — a drawing error can
// never produce a half-written response or crash the process.
function start(title) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: title, Author: 'METNMAT Innovations Pvt. Ltd.' } });
  doc._buffered = new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  // brand header
  doc.rect(0, 0, doc.page.width, 64).fill(NAVY);
  doc.fill(RED).font('Helvetica-Bold').fontSize(16).text('METN', 48, 24, { continued: true }).fill('#ffffff').text('MAT');
  doc.fill('#9fb2c4').font('Helvetica').fontSize(8).text('SKILL & COMPETENCY ASSESSMENT', 48, 44);
  doc.fill('#ffffff').font('Helvetica-Bold').fontSize(11).text(title, 0, 28, { align: 'right', width: doc.page.width - 48 });
  doc.y = 84;
  return doc;
}

async function finish(doc, res, filename, confidential = true) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(7.5).fill(MUTED)
      .text(`${confidential ? 'CONFIDENTIAL — internal use only. ' : ''}Generated ${new Date().toLocaleString('en-IN')} · Page ${i + 1} of ${range.count}`,
        48, doc.page.height - 36, { width: doc.page.width - 96, align: 'center' });
  }
  doc.end();
  const buf = await doc._buffered;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}

function h2(doc, text) {
  if (doc.y > doc.page.height - 120) doc.addPage();
  doc.moveDown(0.6);
  doc.fill(RED).font('Helvetica-Bold').fontSize(8).text(text.toUpperCase(), { characterSpacing: 1.5 });
  doc.moveTo(48, doc.y + 2).lineTo(120, doc.y + 2).strokeColor(RED).lineWidth(1.5).stroke();
  doc.moveDown(0.5);
  doc.fill(INK);
}

function kv(doc, pairs, cols = 2) {
  const w = (doc.page.width - 96) / cols;
  const startY = doc.y;
  pairs.forEach(([k, v], i) => {
    const x = 48 + (i % cols) * w;
    const y = startY + Math.floor(i / cols) * 26;
    doc.font('Helvetica').fontSize(7.5).fill(MUTED).text(String(k).toUpperCase(), x, y);
    doc.font('Helvetica-Bold').fontSize(10).fill(INK).text(String(v ?? '—'), x, y + 10, { width: w - 12 });
  });
  doc.y = startY + Math.ceil(pairs.length / cols) * 26 + 4;
}

function table(doc, headers, rows, widths) {
  const x0 = 48, totalW = doc.page.width - 96;
  const ws = widths.map(w => w * totalW);
  const drawHead = () => {
    doc.font('Helvetica-Bold').fontSize(7.5).fill(MUTED);
    let x = x0;
    headers.forEach((h, i) => { doc.text(String(h).toUpperCase(), x, doc.y, { width: ws[i] - 6, continued: false, lineBreak: false }); x += ws[i]; });
    doc.moveDown(0.9);
    doc.moveTo(x0, doc.y - 3).lineTo(x0 + totalW, doc.y - 3).strokeColor(LINE).lineWidth(0.75).stroke();
  };
  drawHead();
  doc.font('Helvetica').fontSize(8.5).fill(INK);
  for (const row of rows) {
    if (doc.y > doc.page.height - 90) { doc.addPage(); drawHead(); doc.font('Helvetica').fontSize(8.5).fill(INK); }
    let x = x0;
    const y = doc.y;
    let maxH = 0;
    row.forEach((cell, i) => {
      const hgt = doc.heightOfString(String(cell ?? ''), { width: ws[i] - 6 });
      doc.text(String(cell ?? ''), x, y, { width: ws[i] - 6 });
      maxH = Math.max(maxH, hgt);
      x += ws[i];
    });
    doc.y = y + maxH + 4;
    doc.moveTo(x0, doc.y - 2).lineTo(x0 + totalW, doc.y - 2).strokeColor(LINE).lineWidth(0.4).stroke();
  }
  doc.moveDown(0.4);
}

function bar(doc, label, value, max, suffix = '') {
  const x0 = 48, labelW = 200, barW = doc.page.width - 96 - labelW - 60;
  if (doc.y > doc.page.height - 90) doc.addPage();
  const y = doc.y;
  doc.font('Helvetica').fontSize(8.5).fill(INK).text(label, x0, y, { width: labelW - 8 });
  doc.rect(x0 + labelW, y + 1, barW, 7).fill(LINE);
  doc.rect(x0 + labelW, y + 1, Math.max(2, barW * Math.min(1, value / max)), 7).fill(RED);
  doc.font('Helvetica-Bold').fontSize(8.5).fill(INK).text(`${value}${suffix}`, x0 + labelW + barW + 8, y);
  doc.y = y + 14;
}

// ---------------------------------------------------------------- reports
async function employeeReport(res, { sub, scores, cycleName, history, fw }) {
  const p = sub.profile;
  const doc = start('Employee Assessment Report');

  h2(doc, 'Employee');
  kv(doc, [['Name', p.name], ['Email', p.email || '—'], ['Department', p.department], ['Designation', p.designation],
    ['Location', p.location], ['Reporting manager', p.manager], ['Cycle', cycleName],
    ['Submitted', (sub.submittedAt || '').slice(0, 10)], ['Status', sub.status === 'validated' ? 'Validated ' + (sub.validatedAt || '').slice(0, 10) : 'Pending validation']], 3);

  h2(doc, 'Result');
  kv(doc, [['Overall self (0–5)', scores.overallSelf], ['Overall validated', scores.overallValidated ?? '—'],
    ['Weighted self', scores.weightedSelf], ['Weighted validated', scores.weightedValidated ?? '—'],
    ['Band', scores.band ?? scores.provisionalBand + ' (provisional)'], ['Validated skills', `${scores.validatedCount}/${scores.totalSkills}`]], 3);

  h2(doc, 'Domain proficiency');
  table(doc, ['Domain', 'Skills', 'Weight %', 'Self avg', 'Validated avg', 'Δ self−validated'],
    scores.domains.map(d => [`${d.code} — ${d.name}`, d.skillCount, d.weight, d.selfAvg,
      d.validatedAvg ?? '—', d.validatedAvg != null ? (d.selfAvg - d.validatedAvg).toFixed(2) : '—']),
    [0.40, 0.10, 0.12, 0.12, 0.14, 0.12]);

  if (history && history.length) {
    h2(doc, 'Year-over-year');
    table(doc, ['Cycle', 'Submitted', 'Weighted self', 'Weighted validated', 'Band'],
      history.map(h => [h.cycleName, (h.submittedAt || '').slice(0, 10), h.weightedSelf, h.weightedValidated ?? '—', h.band ?? '—']),
      [0.28, 0.18, 0.18, 0.18, 0.18]);
  }

  // HR remarks (only rated skills with remarks)
  const remarks = [];
  for (const d of fw.domains) for (const sk of d.skills) {
    const r = sub.ratings[sk.id] || {};
    if (r.remark) remarks.push([`${sk.sno}. ${sk.name}`, r.self ?? '—', r.hr ?? '—', r.remark]);
  }
  if (remarks.length) {
    h2(doc, 'HR remarks');
    table(doc, ['Skill', 'Self', 'HR', 'Remark'], remarks, [0.34, 0.08, 0.08, 0.50]);
  }
  await finish(doc, res, `METNMAT_report_${(p.name || 'employee').replace(/[^\w]+/g, '_')}.pdf`);
}

async function executiveSummary(res, { dash, cycleName }) {
  const doc = start('Executive Summary Report');
  const t = dash.totals;

  h2(doc, 'Cycle: ' + cycleName);
  kv(doc, [['Submissions', t.submissions], ['Validated', t.validated], ['Pending', t.pending],
    ['Avg validated score', t.avgWeightedValidated ?? '—'], ['Avg self score', t.avgWeightedSelf ?? '—'],
    ['Self-inflation (avg Δ)', t.avgClaimDelta ?? '—'], ['Evidence coverage', t.avgEvidencePct != null ? Math.round(t.avgEvidencePct) + '%' : '—'],
    ['Validation turnaround', t.avgValidationDays != null ? t.avgValidationDays + ' days' : '—'], ['Departments', t.departments]], 3);

  h2(doc, 'Band distribution');
  const maxBand = Math.max(1, ...Object.values(dash.bandDist));
  for (const [name, n] of Object.entries(dash.bandDist)) bar(doc, name, n, maxBand);

  h2(doc, 'Leaderboard (top 15)');
  table(doc, ['#', 'Employee', 'Department', 'Score', 'Band'],
    dash.leaderboard.slice(0, 15).map(p => [p.rank, p.name + (p.provisional ? ' (self only)' : ''), p.department, p.rankScore, p.band ?? p.provisionalBand]),
    [0.06, 0.32, 0.22, 0.12, 0.28]);

  h2(doc, 'Department performance');
  table(doc, ['Department', 'Employees', 'Avg weighted score'],
    dash.departments.map(d => [d.name, d.count, d.avg ?? '—']), [0.5, 0.2, 0.3]);

  h2(doc, 'Domain proficiency (company)');
  table(doc, ['Domain', 'Self avg', 'Validated avg'],
    dash.domainBoards.map(d => [`${d.code} — ${d.name}`, d.avgSelf ?? '—', d.avgValidated ?? '—']), [0.6, 0.2, 0.2]);

  h2(doc, 'Top skill gaps (training priorities)');
  table(doc, ['Skill', 'Domain', 'Company avg'],
    dash.gaps.map(g => [`${g.sno}. ${g.name}`, g.domain, g.avg]), [0.66, 0.12, 0.22]);

  h2(doc, 'Top strengths');
  table(doc, ['Skill', 'Domain', 'Company avg'],
    dash.strengths.slice(0, 5).map(g => [`${g.sno}. ${g.name}`, g.domain, g.avg]), [0.66, 0.12, 0.22]);

  await finish(doc, res, 'METNMAT_executive_summary.pdf');
}

module.exports = { employeeReport, executiveSummary };
