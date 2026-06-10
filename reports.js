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
function start(title, landscape = false) {
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 48, bufferPages: true, info: { Title: title, Author: 'METNMAT Innovations Pvt. Ltd.' } });
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
  // anchor at the left margin + full width — tables/bars leave doc.x mid-row otherwise
  doc.fill(RED).font('Helvetica-Bold').fontSize(8).text(text.toUpperCase(), 48, doc.y, { characterSpacing: 1.5, width: doc.page.width - 96 });
  doc.moveTo(48, doc.y + 2).lineTo(120, doc.y + 2).strokeColor(RED).lineWidth(1.5).stroke();
  doc.moveDown(0.5);
  doc.x = 48; doc.fill(INK);
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
    const hy = doc.y; // all header cells share one baseline — don't let doc.y drift per cell
    headers.forEach((h, i) => { doc.text(String(h).toUpperCase(), x, hy, { width: ws[i] - 6, continued: false, lineBreak: false }); x += ws[i]; });
    doc.x = x0; doc.y = hy; doc.moveDown(0.9);
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

// ---------------------------------------------------------------- Department Performance Report
async function departmentReport(res, { dash, cycleName, fw }) {
  const doc = start('Department Performance Report');
  const codes = dash.domainBoards.map(d => d.code);
  h2(doc, 'Cycle: ' + cycleName);
  doc.font('Helvetica').fontSize(9).fill(MUTED).text(`${dash.departments.length} department(s) · ${dash.totals.submissions} submission(s). Scores use validated ratings where available, else self-ratings.`);
  doc.moveDown(0.5);

  h2(doc, 'Department ranking');
  table(doc, ['Department', 'Employees', 'Avg score', 'Top performer', 'Band mix'],
    dash.departments.map(dep => {
      const ppl = dash.leaderboard.filter(p => p.department === dep.name);
      const top = ppl[0] ? `${ppl[0].name} (${ppl[0].rankScore})` : '—';
      const bands = {}; ppl.forEach(p => { const b = p.band || p.provisionalBand || '—'; bands[b] = (bands[b] || 0) + 1; });
      const mix = Object.entries(bands).map(([b, n]) => `${b}: ${n}`).join(', ');
      return [dep.name, dep.count, dep.avg ?? '—', top, mix];
    }), [0.24, 0.12, 0.12, 0.28, 0.24]);

  // per-department domain breakdown
  for (const dep of dash.departments) {
    const ppl = dash.leaderboard.filter(p => p.department === dep.name);
    if (!ppl.length) continue;
    const domAvg = codes.map(code => {
      const vals = ppl.map(p => p.domains[code]).filter(v => v != null);
      return { code, avg: vals.length ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : null };
    });
    const ranked = [...domAvg].filter(d => d.avg != null).sort((a, b) => a.avg - b.avg);
    h2(doc, `${dep.name} — ${dep.count} employee(s), avg ${dep.avg ?? '—'}`);
    if (ranked.length) {
      const weakest = ranked.slice(0, 3).map(d => `${d.code} (${d.avg})`).join(', ');
      const strongest = ranked.slice(-3).reverse().map(d => `${d.code} (${d.avg})`).join(', ');
      kv(doc, [['Weakest domains', weakest], ['Strongest domains', strongest]], 2);
    }
    table(doc, ['#', 'Employee', 'Score', 'Band', 'Status'],
      ppl.map((p, i) => [i + 1, p.name, p.rankScore, p.band || p.provisionalBand || '—', p.status === 'validated' ? 'Validated' : 'Pending']),
      [0.07, 0.45, 0.16, 0.18, 0.14]);
  }
  await finish(doc, res, 'METNMAT_department_performance.pdf');
}

// ---------------------------------------------------------------- Skill Gap Report
async function skillGapReport(res, { dash, cycleName, fw }) {
  const doc = start('Skill Gap Report');
  const GAP = 2.5; // below this = priority gap
  h2(doc, 'Cycle: ' + cycleName);
  doc.font('Helvetica').fontSize(9).fill(MUTED).text(`Company-wide skill proficiency (0–5), lowest first. Skills below ${GAP.toFixed(1)} are flagged as training priorities. Based on ${dash.totals.submissions} submission(s).`);
  doc.moveDown(0.5);

  // domain-level gap summary (ascending by company proficiency)
  h2(doc, 'Domain gap summary');
  const domRanked = [...dash.domainBoards]
    .map(d => ({ code: d.code, name: d.name, avg: d.avgValidated != null ? d.avgValidated : d.avgSelf }))
    .filter(d => d.avg != null).sort((a, b) => a.avg - b.avg);
  table(doc, ['Domain', 'Company avg', 'Gap to 5.0'],
    domRanked.map(d => [`${d.code} — ${d.name}`, d.avg, (5 - d.avg).toFixed(2)]), [0.6, 0.2, 0.2]);

  // lowest skills (training priorities)
  const skills = (dash.allSkillAvgs || []).slice().sort((a, b) => a.avg - b.avg);
  const priorities = skills.filter(s => s.avg < GAP);
  h2(doc, `Priority skill gaps — ${priorities.length} skill(s) below ${GAP.toFixed(1)}`);
  if (priorities.length) {
    table(doc, ['Skill', 'Domain', 'Company avg', 'Gap to 5.0'],
      priorities.slice(0, 40).map(s => [`${s.sno}. ${s.name}`, s.domain, s.avg, (5 - s.avg).toFixed(2)]), [0.5, 0.14, 0.18, 0.18]);
    if (priorities.length > 40) doc.font('Helvetica-Oblique').fontSize(8).fill(MUTED).text(`…and ${priorities.length - 40} more below ${GAP.toFixed(1)}.`, 48, doc.y, { width: doc.page.width - 96 });
  } else {
    doc.font('Helvetica').fontSize(9.5).fill(INK).text('No skills fall below the priority threshold — proficiency is broadly healthy.');
  }

  h2(doc, 'Lowest 20 skills overall');
  table(doc, ['Skill', 'Domain', 'Company avg'],
    skills.slice(0, 20).map(s => [`${s.sno}. ${s.name}`, s.domain, s.avg]), [0.64, 0.14, 0.22]);
  await finish(doc, res, 'METNMAT_skill_gap.pdf');
}

// ---------------------------------------------------------------- Competency Matrix (employees × domains)
async function competencyMatrix(res, { dash, cycleName, fw }) {
  const doc = start('Competency Matrix', true); // landscape — many domain columns
  const codes = dash.domainBoards.map(d => d.code);
  h2(doc, 'Cycle: ' + cycleName);
  doc.font('Helvetica').fontSize(9).fill(MUTED).text('Per-employee proficiency by competency domain (0–5; validated where available, else self). Domain key below.');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(7.5).fill(INK).text(dash.domainBoards.map(d => `${d.code}=${d.name}`).join('   ·   '), { width: doc.page.width - 96 });
  doc.moveDown(0.5);

  const nameW = 0.20, scoreW = 0.06;
  const widths = [nameW].concat(codes.map(() => (1 - nameW) / codes.length));
  const rows = dash.leaderboard.map(p => [p.name].concat(codes.map(c => p.domains[c] != null ? p.domains[c].toFixed(1) : '·')));
  // company average row
  const compRow = ['COMPANY AVG'].concat(codes.map(c => {
    const vals = dash.leaderboard.map(p => p.domains[c]).filter(v => v != null);
    return vals.length ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1) : '·';
  }));
  h2(doc, `Matrix — ${rows.length} employee(s) × ${codes.length} domains`);
  table(doc, ['Employee'].concat(codes), rows.concat([compRow]), widths);
  await finish(doc, res, 'METNMAT_competency_matrix.pdf');
}

// ---------------------------------------------------------------- HR Evaluation Report
async function hrEvaluationReport(res, { dash, cycleName, fw }) {
  const doc = start('HR Evaluation Report');
  const t = dash.totals;
  h2(doc, 'Cycle: ' + cycleName);
  kv(doc, [['Submissions', t.submissions], ['Validated', t.validated], ['Pending evaluation', t.pending],
    ['Avg turnaround', t.avgValidationDays != null ? t.avgValidationDays + ' days' : '—'],
    ['Avg self-inflation (Δ)', t.avgClaimDelta ?? '—'], ['Evidence coverage', t.avgEvidencePct != null ? Math.round(t.avgEvidencePct) + '%' : '—']], 3);

  const pending = dash.leaderboard.filter(p => p.status !== 'validated');
  h2(doc, `Pending evaluations — ${pending.length}`);
  if (pending.length) {
    const now = Date.now();
    table(doc, ['Employee', 'Department', 'Submitted', 'Waiting'],
      pending.map(p => [p.name, p.department, (p.submittedAt || '').slice(0, 10),
        p.submittedAt ? Math.round((now - new Date(p.submittedAt)) / 86400000) + ' d' : '—']), [0.34, 0.26, 0.20, 0.20]);
  } else doc.font('Helvetica').fontSize(9.5).fill(INK).text('All submissions have been validated.');

  if ((dash.overClaim || []).length) {
    h2(doc, 'Highest self-inflation (self > validated)');
    table(doc, ['Employee', 'Department', 'Self', 'Validated', 'Δ'],
      dash.overClaim.map(p => [p.name, p.department, p.overallSelf ?? '—', p.overallValidated ?? '—', '+' + p.claimDelta]), [0.30, 0.26, 0.14, 0.16, 0.14]);
  }
  if ((dash.underClaim || []).length) {
    h2(doc, 'Most under-claimed (validated > self)');
    table(doc, ['Employee', 'Department', 'Self', 'Validated', 'Δ'],
      dash.underClaim.map(p => [p.name, p.department, p.overallSelf ?? '—', p.overallValidated ?? '—', p.claimDelta]), [0.30, 0.26, 0.14, 0.16, 0.14]);
  }

  h2(doc, 'Evaluation summary (all employees)');
  table(doc, ['Employee', 'Dept', 'Self', 'Validated', 'Δ', 'Evidence', 'Status'],
    dash.leaderboard.map(p => [p.name, p.department, p.weightedSelf ?? '—', p.weightedValidated ?? '—',
      p.claimDelta == null ? '—' : (p.claimDelta > 0 ? '+' : '') + p.claimDelta, p.evidencePct + '%',
      p.status === 'validated' ? 'Validated' : 'Pending']), [0.24, 0.18, 0.11, 0.13, 0.10, 0.12, 0.12]);
  await finish(doc, res, 'METNMAT_hr_evaluation.pdf');
}

module.exports = { employeeReport, executiveSummary, departmentReport, skillGapReport, competencyMatrix, hrEvaluationReport };
