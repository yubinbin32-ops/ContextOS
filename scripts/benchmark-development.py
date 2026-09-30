#!/usr/bin/env python3
"""Real development A/B runner. Uses saved Codex auth and consumes model usage."""
import argparse, datetime, hashlib, io, json, os, pathlib, shutil, signal, subprocess, tarfile, time
REPO = pathlib.Path(__file__).resolve().parent.parent
PROMPT = '''Fix a real installation integrity bug in this repository. scripts/install-plugin.mjs --check verifies the canonical server bundle but currently accepts missing or stale canonical parser assets. It must reject missing or byte-different server/web-tree-sitter.wasm and all shipped grammars/*.wasm under CONTEXTOS_HOME, identify the affected path, and remain read-only. Preserve active-cache and registered-version checks and source-equals-plugin installation support. Add meaningful regression coverage and run the relevant installer tests. Make the smallest complete repair. Do not publish, commit, change unrelated code, or delegate to other agents. Finish with a concise summary and test results.'''
def sha(data): return hashlib.sha256(data).hexdigest()
def command(args, cwd, env, timeout=120):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
    if result.returncode: raise RuntimeError('Command failed: ' + str(args[:3]) + '\n' + result.stderr[-1600:])
    return result.stdout

def observed(home, thread):
    files = list((home / 'sessions').glob('**/*' + str(thread) + '*.jsonl')) if thread else []
    requests = {}
    for file in files:
        for line in file.read_text().splitlines():
            try: record = json.loads(line)
            except ValueError: continue
            payload = record.get('payload', {})
            if record.get('type') == 'token_usage_record' and payload.get('response_id'):
                requests[payload['response_id']] = payload.get('usage', {})
    return files, len(requests), sum(u.get('input_tokens', 0) for u in requests.values()), sum(u.get('output_tokens', 0) for u in requests.values())

def execute(arm, ordinal, args, output, archive, base_commit, auth_home):
    root = output / (str(ordinal) + '-' + arm); workspace = root / 'repo'; home = root / 'codex'; context = root / 'contextos'
    workspace.mkdir(parents=True); home.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as source: source.extractall(workspace)
    shutil.copytree(args.plugin, workspace / 'plugins/contextos', dirs_exist_ok=True)
    (workspace / 'node_modules').symlink_to(REPO / 'node_modules', target_is_directory=True)
    auth = auth_home / 'auth.json'
    if not auth.is_file(): raise RuntimeError('Saved Codex auth.json is required; log in before running this benchmark.')
    shutil.copy2(auth, home / 'auth.json'); (home / 'auth.json').chmod(0o600)
    config = 'model = ' + json.dumps(args.model) + '\nmodel_reasoning_effort = ' + json.dumps(args.effort) + '\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nweb_search = "disabled"\n'
    if args.chatgpt_http:
        config += 'model_provider = "evaluation-http"\n[model_providers.evaluation-http]\nname = "OpenAI Codex HTTP"\nbase_url = "https://chatgpt.com/backend-api/codex"\nrequires_openai_auth = true\nsupports_websockets = false\n'
    config += '[features]\nmulti_agent = false\nplugins = true\n'
    (home / 'config.toml').write_text(config)
    env = dict(os.environ, CODEX_HOME=str(home), CONTEXTOS_HOME=str(context), CONTEXTOS_PLUGIN_ID='contextos@contextos-development', CONTEXTOS_LEAN_SURFACE='1', CONTEXTOS_CODEX_BIN=args.setup_codex)
    for key in ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TURN_ID']: env.pop(key, None)
    plugin = {'bundleSha256': sha((args.plugin / 'server/contextos-mcp.mjs').read_bytes()), 'skillSha256': sha((args.plugin / 'skills/contextos/SKILL.md').read_bytes()), 'version': json.loads((args.plugin / '.codex-plugin/plugin.json').read_text())['version']} if arm == 'contextos' else None
    try:
        for cmd in [['git', 'init', '-q'], ['git', 'add', '.'], ['git', '-c', 'user.name=ContextOS Evaluation', '-c', 'user.email=eval@example.invalid', 'commit', '-qm', 'evaluation snapshot']]: command(cmd, workspace, env)
        if arm == 'contextos':
            for cmd in [[args.setup_codex, 'plugin', 'marketplace', 'add', '.', '--json'], [args.setup_codex, 'plugin', 'add', 'contextos@contextos-development', '--json'], ['node', 'scripts/install-plugin.mjs'], ['node', 'scripts/install-plugin.mjs', '--check']]: command(cmd, workspace, env)
            installed = json.loads(command([args.setup_codex, 'plugin', 'list', '--json'], workspace, env))['installed']
            if not any(p['name'] == 'contextos' and p['version'] == plugin['version'] and p.get('enabled') for p in installed): raise RuntimeError('ContextOS registration preflight failed')
            with (home / 'config.toml').open('a') as policy: policy.write('\n[plugins."contextos@contextos-development".mcp_servers.contextos.tools.contextos]\napproval_mode = "approve"\n')
        events = root / 'events.jsonl'; stderr = root / 'stderr.log'
        began = time.monotonic(); thread = None; stop_reason = None; cursor = 0; terminal = False
        with events.open('w') as out, stderr.open('w') as err:
            process = subprocess.Popen([args.codex, 'exec', '--json', '--color', 'never', '--cd', str(workspace), '--output-last-message', str(root / 'final.txt'), PROMPT], cwd=workspace, env=env, stdout=out, stderr=err, stdin=subprocess.DEVNULL, start_new_session=True)
            while process.poll() is None:
                time.sleep(1)
                with events.open() as stream:
                    stream.seek(cursor)
                    while True:
                        position = stream.tell()
                        line = stream.readline()
                        if not line or not line.endswith('\n'):
                            stream.seek(position)
                            break
                        try: event = json.loads(line)
                        except ValueError: continue
                        if event.get('type') == 'thread.started': thread = event['thread_id']
                        if event.get('type') in ['turn.completed', 'turn.failed']: terminal = True
                    cursor = stream.tell()
                _, count, inputs, outputs = observed(home, thread)
                if time.monotonic() - began > args.timeout: stop_reason = 'timeout'
                elif count >= args.max_requests: stop_reason = 'request budget'
                elif inputs >= args.max_input_tokens: stop_reason = 'input token budget'
                elif outputs >= args.max_output_tokens: stop_reason = 'output token budget'
                if terminal: stop_reason = None
                if stop_reason and not terminal:
                    try: os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError: pass
                    try: process.wait(timeout=10)
                    except subprocess.TimeoutExpired: os.killpg(process.pid, signal.SIGKILL)
                    break
            status = process.wait()
        elapsed = time.monotonic() - began
        rollouts, _, _, _ = observed(home, thread)
        grade = subprocess.run(['node', str(REPO / 'scripts/development-install-grader.mjs'), str(workspace / 'scripts/install-plugin.mjs')], text=True, capture_output=True, env=env, timeout=120)
        quality = json.loads(grade.stdout)
        changed = command(['git', 'diff', '--name-only', 'HEAD'], workspace, env).splitlines() + command(['git', 'ls-files', '--others', '--exclude-standard'], workspace, env).splitlines()
        scope_pass = all(p == 'scripts/install-plugin.mjs' or (p.startswith('packages/mcp/test/') and p.endswith('.test.mjs')) or p.startswith('.contextos/') for p in changed)
        (root / 'repair.patch').write_text(command(['git', 'diff', '--binary', 'HEAD', '--', 'scripts/install-plugin.mjs', 'packages/mcp/test/plugin-install.test.mjs'], workspace, env))
        run = {'arm': arm, 'model': args.model, 'effort': args.effort, 'baseCommit': base_commit, 'promptSha256': sha(PROMPT.encode()), 'plugin': plugin, 'cliVersion': args.cli_version, 'status': status, 'stopReason': stop_reason, 'elapsedSeconds': round(elapsed, 2), 'events': str(events), 'rollouts': [str(p) for p in rollouts], 'workspace': str(workspace), 'home': str(home), 'quality': quality, 'scopePass': scope_pass}
        (root / 'run.json').write_text(json.dumps(run, indent=2))
        summary = json.loads(command(['node', str(REPO / 'scripts/development-metrics.mjs'), str(root / 'run.json')], REPO, env))
        (root / 'summary.json').write_text(json.dumps(summary, indent=2))
        print(json.dumps({'arm': arm, 'valid': summary['validForComparison'], 'metrics': summary['metrics'], 'stopReason': stop_reason}), flush=True)
        return summary
    finally:
        (home / 'auth.json').unlink(missing_ok=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', default='gpt-6-luna'); parser.add_argument('--effort', default='max')
    parser.add_argument('--codex', default=os.environ.get('CODEX_CLI_PATH', shutil.which('codex')))
    parser.add_argument('--setup-codex', default=shutil.which('codex'))
    parser.add_argument('--plugin', type=pathlib.Path, default=REPO / 'plugins/contextos')
    parser.add_argument('--ref', default='v2.7.1'); parser.add_argument('--pairs', type=int, choices=range(1, 6), default=1)
    parser.add_argument('--arms', nargs='+', choices=['native', 'contextos'], default=['native', 'contextos'])
    parser.add_argument('--timeout', type=int, default=600); parser.add_argument('--max-requests', type=int, default=12)
    parser.add_argument('--max-input-tokens', type=int, default=300000); parser.add_argument('--max-output-tokens', type=int, default=12000)
    parser.add_argument('--chatgpt-http', action='store_true', help='Use saved ChatGPT auth over HTTP/SSE instead of WebSocket')
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    if any(x <= 0 for x in [args.timeout, args.max_requests, args.max_input_tokens, args.max_output_tokens]): parser.error('budgets must be positive')
    args.plugin = args.plugin.resolve()
    output = (args.output or REPO / '.contextos/benchmarks' / ('development-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))).resolve()
    if output.exists(): parser.error('output directory already exists; each run needs a fresh directory')
    auth_home = pathlib.Path(os.environ.get('CODEX_HOME', pathlib.Path.home() / '.codex'))
    env = dict(os.environ)
    args.cli_version = command([args.codex, '--version'], REPO, env).strip()
    base_commit = command(['git', 'rev-parse', args.ref + '^{commit}'], REPO, env).strip()
    archive = subprocess.check_output(['git', 'archive', base_commit], cwd=REPO)
    output.mkdir(parents=True)
    results = []
    for pair in range(args.pairs):
        order = args.arms if pair % 2 == 0 else list(reversed(args.arms))
        for arm in order: results.append(execute(arm, len(results) + 1, args, output, archive, base_commit, auth_home))
    (output / 'report.json').write_text(json.dumps({'schemaVersion': 1, 'task': 'canonical-parser-integrity', 'budgets': {'requests': args.max_requests, 'inputTokens': args.max_input_tokens, 'outputTokens': args.max_output_tokens, 'seconds': args.timeout}, 'results': results, 'limitations': ['Small task pilot, not a universal savings estimate.', 'Input includes cached tokens; token counts are not a currency bill.', 'Peak request input is a context-occupancy proxy, not the desktop context gauge.', 'Budget checks occur between recorded responses and can overshoot by one in-flight request.']}, indent=2))
    print(json.dumps({'report': str(output / 'report.json')}))
