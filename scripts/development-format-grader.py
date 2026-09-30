#!/usr/bin/env python3
"""Independent type-safety contract for paragraph alignment normalization."""
import importlib.util
import json
import pathlib
import sys
spec = importlib.util.spec_from_file_location('graded_formatter', pathlib.Path(sys.argv[1]).resolve())
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
cases = [
    ('nested-dict', '["center",{},"right"]', 'a\nb\nc', ['center','left','right']),
    ('nested-list', '["center",[],"right"]', 'a\nb\nc', ['center','left','right']),
    ('raw-container-types', ['center', {'left':True}, [], 'right'], 'a\nb\nc\nd', ['center','left','left','right']),
    ('scalar-types', ['center',None,True,1,'right'], 'a\nb\nc\nd\ne', ['center','left','left','left','right']),
    ('invalid-top-level', '{"center":true}', 'a', []),
    ('malformed-json', 'invalid', 'a', []),
    ('null', None, 'a', []),
    ('valid-layout', '["center","left","right"]', 'a\nb\nc', ['center','left','right']),
    ('unknown-value', '["center","unknown","right"]', 'a\nb\nc', ['center','left','right']),
    ('line-limit', '["center","right","center"]', 'a\nb', ['center','right']),
    ('trim-defaults', '["center","left","left"]', 'a\nb\nc', ['center']),
    ('all-defaults', '[{},[]]', 'a\nb', []),
    ('empty-answer', '["center","right"]', '', ['center']),
]
verdicts=[]
for name, payload, answer, expected in cases:
    before=json.dumps(payload,sort_keys=True)
    try:
        actual=module.answer_paragraph_alignments(payload,answer)
        assert actual == expected, (actual,expected)
        assert json.loads(module.normalize_answer_format_json(payload,answer)) == expected
        assert json.dumps(payload,sort_keys=True) == before, 'input mutated'
        verdicts.append({'name':name,'pass':True})
    except Exception as error:
        verdicts.append({'name':name,'pass':False,'error':type(error).__name__+': '+str(error)})
result={'pass':all(case['pass'] for case in verdicts),'checks':verdicts}
print(json.dumps(result,indent=2));sys.exit(0 if result['pass'] else 1)
