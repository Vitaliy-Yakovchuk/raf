import collections
import glob
import json
import os

start = '2026-11-08T22:50:00'
end = '2026-11-09T00:50:00'
sessions, outputs = [], []
for path in sorted(glob.glob('/srv/dev/.codex/sessions/2026/11/0[89]/*.jsonl')):
    calls, selected = {}, []
    with open(path) as source:
        for line in source:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            payload = row.get('payload', {})
            kind = payload.get('type')
            call_id = payload.get('call_id')
            if kind in ('function_call', 'custom_tool_call'):
                calls[call_id] = str(payload.get('arguments', payload.get('input', '')))
            if kind not in ('function_call_output', 'custom_tool_call_output') or not start <= row.get('timestamp', '')[:19] < end:
                continue
            output = payload.get('output', '')
            if isinstance(output, list):
                output = ''.join(block.get('text', '') for block in output if isinstance(block, dict))
            output = output if isinstance(output, str) else json.dumps(output)
            command = calls.get(call_id, '')
            selected.append({'bytes': len(output.encode()), 'session': os.path.basename(path), 'callId': call_id,
                             'boundedRead': 'sed -n' in command and any(marker in command for marker in ('120p', '100p', '80p'))})
    if selected:
        sessions.append({'file': os.path.basename(path), 'outputs': len(selected), 'bytes': sum(item['bytes'] for item in selected)})
        outputs.extend(selected)

def stats(values):
    values = sorted(values)
    return {'count': len(values), **{label: values[min(int(len(values) * fraction), len(values) - 1)] if values else 0
                                   for label, fraction in [('p50', .5), ('p90', .9), ('p99', .99), ('max', 1)]}}

result = {'window': {'start': start + 'Z', 'end': end + 'Z'},
          'method': 'UTF-8 bytes of function/custom tool outputs in window. bytes/4 estimates token budgets; not tokenizer measurement. Includes sessions active in window. No raw contents retained.',
          'sessions': sorted(sessions, key=lambda item: -item['bytes']),
          'outputBytes': stats([item['bytes'] for item in outputs]),
          'boundedReadBytes': stats([item['bytes'] for item in outputs if item['boundedRead']]),
          'largest': sorted(outputs, key=lambda item: -item['bytes'])[:10],
          'candidates': [{'tokens': tokens, 'estimatedByteBudget': tokens * 4,
                          'outputsOverBudget': sum(item['bytes'] > tokens * 4 for item in outputs),
                          'estimatedBytesRemoved': sum(max(0, item['bytes'] - tokens * 4) for item in outputs),
                          'boundedReadsOverBudget': sum(item['boundedRead'] and item['bytes'] > tokens * 4 for item in outputs)}
                         for tokens in (1000, 2000, 4000, 8000)]}
with open(os.path.join(os.path.dirname(__file__), 'measurements.json'), 'w') as target:
    json.dump(result, target, indent=2)
    target.write('\n')
print(json.dumps({key: value for key, value in result.items() if key not in ('sessions', 'largest')}, indent=2))
