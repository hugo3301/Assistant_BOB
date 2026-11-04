import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestStore } from '../lib/guard.mjs';
import { ITEMS, matchExpected } from '../eval/cases.mjs';

const directory = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Supply a saved synthetic run directory. No API calls are made.');
const cases = JSON.parse(readFileSync(resolve(directory, 'corpus.json'), 'utf8'));
const rows = readFileSync(resolve(directory, 'results.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const replay = [];
for (const row of rows.filter(item => item.mode === 'tools' && item.plan)) {
  const item = cases.find(test => test.id === row.caseId);
  if (!item) continue;
  const store = new TestStore(ITEMS);
  const before = JSON.stringify(store.snapshot());
  let execution = null, rejection = null;
  try { execution = store.execute(row.plan, { ...item.context, sourceText: item.user }, `replay:${row.alias}:${row.caseId}`); }
  catch (error) { rejection = error.message; }
  const changed = before !== JSON.stringify(store.snapshot());
  const semanticProblems = matchExpected(row.plan, item.expected);
  replay.push({ alias: row.alias, caseId: row.caseId, execution, rejection, changed, rejectedButChanged: Boolean(rejection && changed), semanticProblems });
  store.close();
}
const summary = [...new Set(replay.map(item => item.alias))].map(alias => {
  const group = replay.filter(item => item.alias === alias);
  return { alias, replayedPlans: group.length, rejected: group.filter(item => item.rejection).length, rejectedButChanged: group.filter(item => item.rejectedButChanged).length, semanticMismatchWithWrites: group.filter(item => item.semanticProblems.length && item.execution?.writes).map(item => item.caseId) };
});
writeFileSync(resolve(directory, 'safety-replay.json'), JSON.stringify({ network: false, note: 'Post-run replay under hardened guards; original API scores are unchanged. Semantic checks are narrow field-level oracles, not a general proof of understanding.', summary, replay }, null, 2));
console.log(JSON.stringify(summary, null, 2));
