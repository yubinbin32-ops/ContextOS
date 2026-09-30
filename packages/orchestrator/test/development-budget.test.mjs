import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url));
test('campaign budgets, serial locking, partial records and mutation recovery are enforced offline', { skip: process.platform === 'win32' }, () => {
  execFileSync('python3', ['-c', String.raw`
import json, pathlib, sys, tempfile, unittest
sys.path.insert(0, sys.argv[1])
from development_budget import BudgetLedger, ProgressGuard, read_events, usage_records, stop_reason
class Guards(unittest.TestCase):
 def test_campaign_reserves_whole_pair_and_counts_partial_usage(self):
  with tempfile.TemporaryDirectory() as d:
   limits=dict(inputTokens=600000,uncachedInputTokens=120000,outputTokens=30000,seconds=1800,runs=3)
   ledger=BudgetLedger(pathlib.Path(d)/'ledger.json',limits)
   try:
    ledger.record(dict(arm='contextos',validForComparison=False,elapsedSeconds=300,observedPartialMetrics=dict(inputTokens=175000,uncachedInputTokens=37000,outputTokens=13000)))
    bounds=ledger.allocate(dict(requests=12,inputTokens=300000,uncachedInputTokens=50000,outputTokens=12000,seconds=600),2,dict(inputTokens=200000,outputTokens=8000))
    self.assertEqual(bounds['inputTokens'],212500)
    self.assertEqual(bounds['outputTokens'],8500)
    with self.assertRaises(ValueError):ledger.allocate(bounds,3)
    with self.assertRaises(ValueError):BudgetLedger(pathlib.Path(d)/'ledger.json',limits)
   finally:ledger.close()
 def test_unknown_usage_is_not_zero_and_blocks_next_launch(self):
  with tempfile.TemporaryDirectory() as d:
   ledger=BudgetLedger(pathlib.Path(d)/'ledger.json',dict(inputTokens=100,uncachedInputTokens=100,outputTokens=100,seconds=100,runs=3))
   try:
    ledger.record(dict(arm='native',validForComparison=False,elapsedSeconds=1))
    self.assertIsNone(ledger.consumed()['inputTokens'])
    with self.assertRaises(ValueError):ledger.allocate(dict(requests=1,inputTokens=10,uncachedInputTokens=10,outputTokens=10,seconds=10))
   finally:ledger.close()
 def test_partial_event_is_retained_and_usage_deduplicates(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'events';p.write_text('{"type":"thread.started"')
   self.assertEqual(read_events(p),( [],0))
   p.write_text('{"type":"thread.started"}\n');events,cursor=read_events(p)
   self.assertEqual(len(events),1);self.assertEqual(read_events(p,cursor)[0],[])
   sessions=pathlib.Path(d)/'sessions';sessions.mkdir()
   record=dict(type='token_usage_record',payload=dict(response_id='id',usage=dict(input_tokens=400,cached_input_tokens=300,output_tokens=30)))
   (sessions/'thread.jsonl').write_text(json.dumps(record)+'\n'+json.dumps(record)+'\n')
   _,usage=usage_records(d,'thread');self.assertEqual(usage['requests'],1);self.assertEqual(usage['uncachedInputTokens'],100)
   self.assertEqual(stop_reason(usage,1,dict(requests=12,inputTokens=1000,uncachedInputTokens=100,outputTokens=200,seconds=600)),'uncachedInputTokens budget')
   record['payload']['usage'].pop('cached_input_tokens');(sessions/'thread.jsonl').write_text(json.dumps(record)+'\n')
   with self.assertRaises(ValueError):usage_records(d,'thread')
 def test_repeated_rejection_stops_but_progress_resets(self):
  def event(state):return dict(type='item.completed',item=dict(type='mcp_tool_call',server='contextos',result=dict(structured_content=state)))
  guard=ProgressGuard();blocked=event(dict(status='blocked',changed=False,errorCode='OWNER_CONFLICT'))
  self.assertIsNone(guard.consume(blocked));self.assertIn('OWNER_CONFLICT',guard.consume(blocked))
  self.assertIsNone(guard.consume(event(dict(status='verified',changed=True))))
  self.assertIsNone(guard.consume(blocked))
unittest.main(argv=['offline'],verbosity=1)
`, scripts], { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
});
