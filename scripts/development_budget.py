"""Usage budgets and progress guards; no model calls in this module."""
import json
import pathlib
import fcntl

FIELDS = ('inputTokens', 'uncachedInputTokens', 'outputTokens', 'seconds', 'runs')

def read_events(path, cursor=0):
    events = []
    if not pathlib.Path(path).exists():
        return events, cursor
    with pathlib.Path(path).open() as stream:
        stream.seek(cursor)
        while True:
            position = stream.tell()
            line = stream.readline()
            if not line or not line.endswith('\n'):
                stream.seek(position)
                break
            events.append(json.loads(line))
        return events, stream.tell()

def usage_records(home, thread):
    files = sorted((pathlib.Path(home) / 'sessions').glob('**/*' + str(thread) + '*.jsonl')) if thread else []
    records = {}
    for file in files:
        for line in file.read_text().splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue  # A live producer may not have finished its last line.
            payload = record.get('payload', {})
            if record.get('type') == 'token_usage_record' and payload.get('response_id'):
                records[payload['response_id']] = payload.get('usage', {})
    totals = {'requests': len(records), 'inputTokens': 0, 'uncachedInputTokens': 0, 'outputTokens': 0}
    for usage in records.values():
        required = [usage.get(k) for k in ('input_tokens', 'cached_input_tokens', 'output_tokens')]
        if any(type(value) is not int or value < 0 for value in required) or required[1] > required[0]:
            raise ValueError('Malformed provider usage; budgets cannot substitute zero')
        totals['inputTokens'] += required[0]
        totals['uncachedInputTokens'] += required[0] - required[1]
        totals['outputTokens'] += required[2]
    return files, totals

def mutation_outcome(item):
    if item.get('type') != 'mcp_tool_call' or 'contextos' not in item.get('server', ''):
        return None
    result = item.get('result') or {}
    structured = result.get('structured_content') or result.get('structuredContent')
    if isinstance(structured, dict) and 'status' in structured:
        return structured
    for chunk in result.get('content', []):
        for line in chunk.get('text', '').splitlines():
            if line.startswith('status='):
                try:
                    return json.loads(line[7:])
                except ValueError:
                    pass
    return None

class ProgressGuard:
    def __init__(self):
        self.last_error = None
        self.repeats = 0
        self.rejections = []
    def consume(self, event):
        if event.get('type') != 'item.completed':
            return None
        outcome = mutation_outcome(event.get('item', {}))
        if not outcome:
            return None
        if outcome.get('changed') or outcome.get('status') == 'verified':
            self.last_error = None
            self.repeats = 0
            return None
        if outcome.get('status') != 'blocked':
            return None
        error = outcome.get('errorCode', 'UNKNOWN_MUTATION_REJECTION')
        self.rejections.append(error)
        self.repeats = self.repeats + 1 if error == self.last_error else 1
        self.last_error = error
        return 'repeated mutation rejection: ' + error if self.repeats >= 2 else None

class BudgetLedger:
    def __init__(self, path, limits):
        self.path = pathlib.Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = self.path.with_suffix('.lock').open('a')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            raise ValueError('Campaign already executing; model runs must be serial')
        if self.path.exists():
            self.state = json.loads(self.path.read_text())
            if self.state['limits'] != limits:
                self.close()
                raise ValueError('Existing ledger limits differ; use a new explicit campaign')
        else:
            self.state = {'schemaVersion': 1, 'limits': limits, 'runs': [], 'unknownUsage': False}
        self.save()
    def close(self):
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        self.lock.close()
    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.writing')
        temporary.write_text(json.dumps(self.state, indent=2))
        temporary.replace(self.path)
    def consumed(self):
        return {key: (None if any(run['usage'][key] is None for run in self.state['runs']) else sum(run['usage'][key] for run in self.state['runs'])) for key in FIELDS}
    def allocate(self, requested, arm_count=1, minimum=None):
        if self.state['unknownUsage']:
            raise ValueError('Previous usage is unavailable; campaign cannot launch another model')
        used = self.consumed()
        remaining = {key: self.state['limits'][key] - used[key] for key in FIELDS}
        if remaining['runs'] < arm_count:
            raise ValueError('Campaign run budget cannot fit the whole pair/group')
        allocated = {'requests': requested['requests']}
        for key in ('inputTokens', 'uncachedInputTokens', 'outputTokens', 'seconds'):
            allocated[key] = min(requested[key], int(remaining[key] // arm_count))
            if allocated[key] <= 0 or (minimum and allocated[key] < minimum.get(key, 0)):
                raise ValueError('Campaign ' + key + ' budget cannot fit the whole pair/group')
        return allocated
    def record(self, summary):
        usage = summary.get('metrics') or summary.get('observedPartialMetrics')
        if usage is None:
            self.state['unknownUsage'] = True
            numeric = {'inputTokens': None, 'uncachedInputTokens': None, 'outputTokens': None}
        else:
            numeric = {key: usage[key] for key in ('inputTokens', 'uncachedInputTokens', 'outputTokens')}
        self.state['runs'].append({'arm': summary['arm'], 'valid': summary['validForComparison'],
                                  'usageKnown': usage is not None,
                                  'usage': {**numeric, 'seconds': summary['elapsedSeconds'], 'runs': 1}})
        self.save()

def stop_reason(usage, elapsed, bounds):
    for field in ('requests', 'inputTokens', 'uncachedInputTokens', 'outputTokens'):
        if usage[field] >= bounds[field]:
            return field + ' budget'
    return 'timeout' if elapsed >= bounds['seconds'] else None
