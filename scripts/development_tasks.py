"""Predeclared real-task fixtures. These functions never call a model."""
import pathlib
import subprocess

INSTALL_PROMPT = 'Fix a real installation integrity bug in this repository. scripts/install-plugin.mjs --check verifies the canonical server bundle but currently accepts missing or stale canonical parser assets. It must reject missing or byte-different server/web-tree-sitter.wasm and all shipped grammars/*.wasm under CONTEXTOS_HOME, identify the affected path, and remain read-only. Preserve active-cache and registered-version checks and source-equals-plugin installation support. Add meaningful regression coverage and run the relevant installer tests. Make the smallest complete repair. Do not publish, commit, change unrelated code, or delegate to other agents. Finish with a concise summary and test results.'
OWNERSHIP_PROMPT = 'Fix a real scoped ownership refresh bug. When a Block owns edit.mjs and stable.mjs and a change edits only edit.mjs, explicit and automatic refresh must replace stale edited symbols while preserving untouched artifactRefs and Chain membership. Preserve the legacy full replacePaths:true behavior. Repair packages/mcp/src/v2-service.mjs and packages/orchestrator/src/pipelines.mjs at the scoped binding call sites. Add meaningful regression coverage under packages/orchestrator/test and run the relevant tests. Make the smallest complete repair. Do not publish, commit, change unrelated code, or delegate to other agents. Finish with a concise summary and test results.'
ALIGNMENT_PROMPT = 'Fix a real input-normalization bug. gongkao/answer_formatting.py crashes when a valid JSON alignment array contains a dictionary or nested list. Every non-string or unknown element must normalize to left. Preserve valid left/center/right values, answer-line bounds, trailing-left trimming, invalid top-level handling, and input immutability. Add meaningful regression coverage in tests/test_answer_formatting.py and run it with Python unittest. Make the smallest complete repair. Do not publish, commit, change unrelated code, or delegate to other agents. Finish with a concise summary and test results.'

def task_spec(name, repo):
    if name == 'installer-json-resume':
        spec = task_spec('canonical-parser-integrity', repo)
        spec.update(id=name, kind='long-session', compactLimit=32000, followup='Extend the installer repair already made in this session. Add a read-only scripts/install-plugin.mjs --check --json mode that prints exactly one JSON object to stdout: {ok:boolean,version:string,errors:[{path:string,message:string}]}. Report every missing or stale canonical parser asset in the same run and preserve bundle, active-cache and registered-version checks. Healthy checks exit 0 with errors:[]; failed checks exit 1 with affected asset paths and useful messages. Normal --check text output remains supported. Do not repair files during a check. Add meaningful regression tests, preserve the previous repair and run relevant tests. Modify only scripts/install-plugin.mjs and packages/mcp/test. Do not publish, commit or delegate. For finite exec_command checks use yield_time_ms=10000 or 30000; batch known reads and checks. After the focused tests and git diff --check pass, finish with a concise summary without redundant post-test source reads.')
        return spec
    if name == 'canonical-parser-integrity':
        return {'id':name,'repo':'ContextOS','kind':'bounded-repair','ref':'v2.7.1','prompt':INSTALL_PROMPT + ' For finite exec_command checks use yield_time_ms=10000 or 30000 so short checks finish in one response rather than repeated polling. Batch known reads and checks. If the contextos tool is exposed in this session, use its focused work/change/verify flow for this task; otherwise use native tools. Do not install tools.',
                'sources':['scripts/install-plugin.mjs'],'testDir':'packages/mcp/test/','extension':'.test.mjs','language':'node','fallback':False}
    if name == 'ownership-refresh':
        return {'id':name,'repo':'ContextOS','kind':'cross-file','ref':'v2.7.1','prompt':OWNERSHIP_PROMPT + ' Run node --test packages/orchestrator/test/kernel-e2e.test.mjs and any new focused regression test. For finite exec_command checks use yield_time_ms=10000 or 30000 so short checks finish in one response rather than repeated polling. Batch known reads and checks. If the contextos tool is exposed in this session, use its focused work/change/verify flow for this task; otherwise use native tools. Do not install tools.',
                'sources':['packages/mcp/src/v2-service.mjs','packages/orchestrator/src/pipelines.mjs'],'testDir':'packages/orchestrator/test/','extension':'.test.mjs','language':'node','fallback':False}
    if name == 'alignment-types':
        if repo is None:raise ValueError('--repo is required for the private Python task')
        return {'id':name,'repo':'private-python-project','kind':'small-repair','ref':'HEAD','prompt':ALIGNMENT_PROMPT + ' python3 is available on this host. Batch AGENTS discovery and the known source/test reads together; do not inventory known paths. After one complete patch, run python3 -m unittest discover -s tests -p test_answer_formatting.py and git diff --check together, then finish without redundant post-test reads.',
                'sources':['gongkao/answer_formatting.py'],'testDir':'tests/','extension':'.py','language':'python','fallback':True}
    raise ValueError('Unknown task: '+name)

def grader_command(task, repo, workspace):
    if task['id'] in ('canonical-parser-integrity','installer-json-resume'):return ['node',str(repo/'scripts/development-install-grader.mjs'),str(workspace/'scripts/install-plugin.mjs')]
    if task['id'] == 'ownership-refresh':return ['node',str(repo/'scripts/development-ownership-grader.mjs'),str(workspace)]
    return ['python3',str(repo/'scripts/development-format-grader.py'),str(workspace/'gongkao/answer_formatting.py')]

def changed_tests(task, paths):
    return [p for p in paths if p.startswith(task['testDir']) and p.endswith(task['extension'])]

def allowed(task, path, tests):
    return path in task['sources'] or path in tests or path.startswith('.contextos/')

def run_tests(task, workspace, paths, env):
    commands = [['node','--test',*paths]] if task['language']=='node' else [
        ['python3','-m','unittest','discover','-s',str(pathlib.PurePosixPath(p).parent),'-p',pathlib.PurePosixPath(p).name] for p in paths]
    results=[subprocess.run(c,cwd=workspace,env=env,text=True,capture_output=True,timeout=120) for c in commands]
    return {'status':0 if all(r.returncode==0 for r in results) else 1,'log':'\n'.join(r.stdout+r.stderr for r in results)}
