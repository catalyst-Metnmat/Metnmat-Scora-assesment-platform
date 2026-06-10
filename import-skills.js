// One-time import: reads METNMAT_Skill_Assessment.xlsx and writes data/skills.json
// Re-run with:  node import-skills.js [path-to-xlsx]
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || 'C:/Users/ritik/Downloads/METNMAT_Skill_Assessment.xlsx';
const wb = XLSX.readFile(src);

const skillRows = XLSX.utils.sheet_to_json(wb.Sheets['Skill Assessment'], { header: 1, defval: '' });
const summaryRows = XLSX.utils.sheet_to_json(wb.Sheets['Score Summary'], { header: 1, defval: '' });
const readme = XLSX.utils.sheet_to_json(wb.Sheets['Read Me'], { header: 1, defval: '' });

// proficiency scale (Read Me rows: level 0..5)
const scale = readme
  .filter(r => typeof r[0] === 'number' && r[1] && r[2])
  .map(r => ({ level: r[0], label: r[1], definition: r[2] }));

// default HR weights per domain from Score Summary
const weights = {};
for (const r of summaryRows) {
  if (typeof r[0] === 'string' && /^[A-P]$/.test(r[0]) && typeof r[5] === 'number') weights[r[0]] = r[5];
}

// bands
const bands = [];
for (const r of summaryRows) {
  const m = typeof r[1] === 'string' && r[1].match(/^([\d.]+)\s*-\s*([\d.]+)$/);
  if (m && r[2]) bands.push({ min: parseFloat(m[1]), max: parseFloat(m[2]), name: r[2] });
}

// domains + skills
const domains = [];
let current = null;
for (const r of skillRows.slice(4)) {
  if (typeof r[0] === 'string' && /^[A-P]$/.test(r[0])) {
    current = { code: r[0], name: r[1], weight: weights[r[0]] ?? 0, skills: [] };
    domains.push(current);
  } else if (typeof r[0] === 'number' && current) {
    current.skills.push({ id: 's' + r[0], sno: r[0], name: r[2] });
  }
}

const out = {
  company: 'METNMAT Innovations Pvt. Ltd.',
  title: 'Employee Skill & Competency Assessment',
  tagline: 'Proficiency-based compensation and promotion framework',
  scale,
  bands,
  profileFields: [
    { id: 'name', label: 'Full name', required: true },
    { id: 'employeeId', label: 'Employee ID', required: true },
    { id: 'department', label: 'Department / function', required: true },
    { id: 'designation', label: 'Current designation', required: true },
    { id: 'location', label: 'Location', required: true, options: ['Howrah', 'Sambalpur', 'Mumbai', 'Other'] },
    { id: 'manager', label: 'Reporting manager', required: true },
    { id: 'doj', label: 'Date of joining', required: true, type: 'date' },
    { id: 'experience', label: 'Total years of experience', required: true },
    { id: 'qualification', label: 'Highest qualification', required: true },
    { id: 'responsibilities', label: 'Key responsibilities (brief)', required: false, type: 'textarea' }
  ],
  domains
};

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'data', 'skills.json'), JSON.stringify(out, null, 2));
const total = domains.reduce((s, d) => s + d.skills.length, 0);
console.log(`Imported ${domains.length} domains, ${total} skills, ${scale.length} scale levels, ${bands.length} bands.`);
console.log('Weights total:', domains.reduce((s, d) => s + d.weight, 0) + '%');
