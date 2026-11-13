// Apply pending supabase/migrations/*.sql to a Supabase project through the
// Management API (needs only SUPABASE_ACCESS_TOKEN; no database password).
// A migration counts as applied when supabase_migrations.schema_migrations has
// a row with its name (the part of the file name after the timestamp).
// Each migration runs in one transaction together with its history row.
import { readdirSync, readFileSync } from 'node:fs';

const ref = process.env.PROJECT_REF;
const token = process.env.SUPABASE_ACCESS_TOKEN;
const dryRun = process.argv.includes('--dry-run');
if (!ref || !token) { console.log('::warning::PROJECT_REF / SUPABASE_ACCESS_TOKEN not set; skipping.'); process.exit(0); }

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

const dir = 'supabase/migrations';
const files = readdirSync(dir).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
const applied = new Set((await query('select name from supabase_migrations.schema_migrations')).map(r => r.name));
const pending = files.filter(f => !applied.has(f.replace(/^\d+_/, '').replace(/\.sql$/, '')));

if (pending.length === 0) { console.log('Database is up to date.'); process.exit(0); }
console.log(`Pending: ${pending.join(', ')}`);
if (dryRun) process.exit(0);

let n = 0;
for (const f of pending) {
  const name = f.replace(/^\d+_/, '').replace(/\.sql$/, '');
  const sql = readFileSync(`${dir}/${f}`, 'utf8');
  let tag = 'mig';
  while (sql.includes(`$${tag}$`)) tag += 'x';
  const version = new Date(Date.now() + 1000 * n++).toISOString().replace(/\D/g, '').slice(0, 14);
  console.log(`Applying ${f} as ${version}_${name} ...`);
  await query(`begin;\n${sql}\n;\ninsert into supabase_migrations.schema_migrations (version, name, statements)
values ('${version}', '${name}', array[$${tag}$${sql}$${tag}$]);\ncommit;`);
  console.log(`  ok`);
}
