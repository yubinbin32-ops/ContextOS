#!/usr/bin/env python3
"""Real coding-task evaluation. Consumes saved Codex account usage, serially."""
import argparse
import datetime
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import tarfile
import time
from development_budget import BudgetLedger, ProgressGuard, read_events, stop_reason, usage_records
from development_tasks import task_spec, grader_command, changed_tests, allowed, run_tests

REPO = pathlib.Path(__file__).resolve().parent.parent
PROMPT = 'Fix a real installation integrity bug in this repository. scripts/install-plugin.mjs --check verifies the canonical server bundle but currently accepts missing or stale canonical parser assets. It must reject missing or byte-different server/web-tree-sitter.wasm and all shipped grammars/*.wasm under CONTEXTOS_HOME, identify the affected path, and remain read-only. Preserve active-cache and registered-version checks and source-equals-plugin installation support. Add meaningful regression coverage and run the relevant installer tests. Make the smallest complete repair. Do not publish, commit, change unrelated code, or delegate to other agents. Finish with a concise summary and test results.'

def sha(data):
    return hashlib.sha256(data).hexdigest()

def command(argv, cwd, env, timeout=120):
    result = subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True,
                            timeout=timeout, stdin=subprocess.DEVNULL)
    if result.returncode:
        raise RuntimeError('Command failed: ' + str(argv[:3]) + '\n' + result.stderr[-1600:])
    return result.stdout

def terminate(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()

def regression_grade(workspace, archive, paths, root, env, task):
    if not paths:
        return {'pass': False, 'reason': 'No regression tests changed'}
    repaired = run_tests(task, workspace, paths, env)
    (root / 'repaired-tests.log').write_text(repaired['log'])
    shadow = root / 'regression-seed'
    shadow.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        source.extractall(shadow)
    if not (shadow / 'node_modules').exists():
        (shadow / 'node_modules').symlink_to(REPO / 'node_modules', target_is_directory=True)
    for name in paths:
        destination = shadow / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(workspace / name, destination)
    before = run_tests(task, shadow, paths, env)
    (root / 'seed-tests.log').write_text(before['log'])
    return {'pass': repaired['status'] == 0 and before['status'] != 0,
            'modifiedTests': paths, 'seedStatus': before['status'],
            'repairedStatus': repaired['status']}

def execute(arm, ordinal, args, output, archive, base_commit, auth_home, bounds, pair_id):
    root = output / (str(ordinal) + '-' + arm)
    workspace, home, context = root / 'repo', root / 'codex', root / 'contextos'
    workspace.mkdir(parents=True)
    home.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        source.extractall(workspace)
    task = args.task_spec
    prompt = task['prompt']
    instruction_dirs = {workspace, *workspace.parents, workspace / task['testDir']}
    for name in task['sources']:
        directory = (workspace / name).parent
        while directory != workspace and workspace in directory.parents:
            instruction_dirs.add(directory)
            directory = directory.parent
    instructions_absent = not any(workspace.rglob('AGENTS.md')) and not any((directory / 'AGENTS.md').is_file() for directory in instruction_dirs)
    if instructions_absent:
        prompt += ' Applicable AGENTS.md files in this prepared workspace, known source/test directories and ancestors were checked before launch: none. Do not repeat instruction discovery or re-read unchanged source.'
    if task['repo'] != 'ContextOS' and (workspace / '.contextos').exists():
        # Preserve imported context outside both arms; measure an explicitly cold local setup.
        shutil.move(str(workspace / '.contextos'), root / 'input-context-backup')
    if task['repo'] == 'ContextOS':
        shutil.copytree(args.plugin, workspace / 'plugins/contextos', dirs_exist_ok=True)
    (workspace / 'node_modules').symlink_to(REPO / 'node_modules', target_is_directory=True)
    env = dict(os.environ, CODEX_HOME=str(home), CONTEXTOS_HOME=str(context),
               CONTEXTOS_PLUGIN_ID='contextos@contextos-development',
               CONTEXTOS_LEAN_SURFACE='1', CONTEXTOS_DISABLE_MICRO='1', CONTEXTOS_CODEX_BIN=args.setup_codex)
    for key in ('CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TURN_ID', 'NODE_TEST_CONTEXT',
                'CONTEXTOS_CLOUD_URL', 'CONTEXTOS_CLOUD_TOKEN', 'CONTEXTOS_PROJECT_ID'):
        env.pop(key, None)
    plugin = {'bundleSha256': sha((args.plugin / 'server/contextos-mcp.mjs').read_bytes()),
              'skillSha256': sha((args.plugin / 'skills/contextos/SKILL.md').read_bytes()),
              'version': json.loads((args.plugin / '.codex-plugin/plugin.json').read_text())['version']}
    bootstrap = root / 'plugin-bootstrap'
    bootstrap.mkdir()
    shutil.copytree(args.plugin, bootstrap / 'plugins/contextos')
    (bootstrap / 'scripts').mkdir()
    shutil.copyfile(REPO / 'scripts/install-plugin.mjs', bootstrap / 'scripts/install-plugin.mjs')
    (bootstrap / '.agents/plugins').mkdir(parents=True)
    shutil.copyfile(REPO / '.agents/plugins/marketplace.json', bootstrap / '.agents/plugins/marketplace.json')
    if task['repo'] == 'ContextOS':
        metadata = json.loads((workspace / 'package.json').read_text())
        metadata['version'] = plugin['version']
        (workspace / 'package.json').write_text(json.dumps(metadata, indent=2) + '\n')
        command(['node', 'scripts/sync-version.mjs'], workspace, env)
    try:
        auth = auth_home / 'auth.json'
        if not auth.is_file():
            raise RuntimeError('Saved Codex authentication is required')
        shutil.copy2(auth, home / 'auth.json')
        (home / 'auth.json').chmod(0o600)
        config = ('model = ' + json.dumps(args.model) + '\nmodel_reasoning_effort = ' +
                  json.dumps(args.effort) + '\napproval_policy = "never"\n' +
                  'sandbox_mode = "workspace-write"\nweb_search = "disabled"\n')
        if task.get('compactLimit'):
            config += 'model_auto_compact_token_limit = ' + str(task['compactLimit']) + '\n'
        if args.chatgpt_http:
            config += ('model_provider = "evaluation-http"\n[model_providers.evaluation-http]\n'
                       'name = "OpenAI Codex HTTP"\nbase_url = "https://chatgpt.com/backend-api/codex"\n'
                       'requires_openai_auth = true\nsupports_websockets = false\n')
        config += '[memories]\ngenerate_memories = false\nuse_memories = false\n[features]\nmulti_agent = false\nplugins = true\n'
        (home / 'config.toml').write_text(config)
        command(['git', 'init', '-q'], workspace, env)
        with (workspace / '.git/info/exclude').open('a') as ignored:
            ignored.write('\nnode_modules\n__pycache__/\n*.pyc\n')
        for argv in (['git', 'add', '.'],
                     ['git', '-c', 'user.name=ContextOS Evaluation', '-c',
                      'user.email=eval@example.invalid', 'commit', '-qm', 'evaluation snapshot']):
            command(argv, workspace, env)
        prepared_archive = subprocess.check_output(['git', 'archive', 'HEAD'], cwd=workspace, env=env)
        input_tree = command(['git', 'rev-parse', 'HEAD^{tree}'], workspace, env).strip()
        if arm == 'contextos':
            for argv in ([args.setup_codex, 'plugin', 'marketplace', 'add', '.', '--json'],
                         [args.setup_codex, 'plugin', 'add', 'contextos@contextos-development', '--json'],
                         ['node', 'scripts/install-plugin.mjs'], ['node', 'scripts/install-plugin.mjs', '--check']):
                command(argv, bootstrap, env)
            installed = json.loads(command([args.setup_codex, 'plugin', 'list', '--json'], bootstrap, env))['installed']
            if not any(p['name'] == 'contextos' and p['version'] == plugin['version'] and p.get('enabled') for p in installed):
                raise RuntimeError('ContextOS registration preflight failed')
            with (home / 'config.toml').open('a') as policy:
                policy.write('\n[plugins."contextos@contextos-development".mcp_servers.contextos.tools.contextos]\napproval_mode = "approve"\n')
        (root / 'launch.json').write_text(json.dumps({'modelStarted': False}))
        (root / 'prompt.txt').write_text(prompt)
        events = root / 'events.jsonl'
        began = time.monotonic()
        thread, reason, cursor, terminal = None, None, 0, False
        guard = ProgressGuard()
        stages = [prompt] + ([task['followup']] if task.get('followup') else [])
        initial_quality = None
        for stage, stage_prompt in enumerate(stages):
            terminal = False
            argv = ([args.codex, 'exec', '--json', '--color', 'never', '--cd', str(workspace)] if stage == 0 else
                    [args.codex, 'exec', 'resume', '--json', thread])
            argv += ['--output-last-message', str(root / ('final-' + str(stage) + '.txt')), stage_prompt]
            with events.open('a') as out, (root / 'stderr.log').open('a') as err:
                process = subprocess.Popen(argv, cwd=workspace, env=env, stdout=out, stderr=err,
                                           stdin=subprocess.DEVNULL, start_new_session=True)
                (root / 'launch.json').write_text(json.dumps({'modelStarted': True, 'pid': process.pid, 'stage': stage}))
                try:
                    while process.poll() is None:
                        time.sleep(1)
                        fresh, cursor = read_events(events, cursor)
                        for event in fresh:
                            if event.get('type') == 'thread.started':thread = event['thread_id']
                            if event.get('type') in ('turn.completed', 'turn.failed'):terminal = True
                            reason = reason or guard.consume(event)
                        _, usage = usage_records(home, thread)
                        elapsed_now = time.monotonic() - began
                        budget_reason = stop_reason(usage, elapsed_now, bounds)
                        within = all(usage[k] <= bounds[k] for k in ('requests','inputTokens','uncachedInputTokens','outputTokens')) and elapsed_now <= bounds['seconds']
                        reason = reason or (None if terminal and within else budget_reason)
                        if reason and not terminal:
                            terminate(process)
                            break
                    status = process.wait()
                except BaseException:
                    terminate(process)
                    raise
            fresh, cursor = read_events(events, cursor)
            for event in fresh:
                if event.get('type') == 'thread.started':thread = event['thread_id']
            if status != 0 or reason:break
            if stage == 0 and task.get('followup'):
                initial = subprocess.run(grader_command(task, REPO, workspace),text=True,capture_output=True,env=env,timeout=120)
                initial_quality = json.loads(initial.stdout)
                if not initial_quality['pass']:
                    reason = 'Initial repair failed independent grading; resume not started'
                    break
                _, usage = usage_records(home, thread)
                reason = stop_reason(usage, time.monotonic() - began, bounds)
                if reason:break
        elapsed = round(time.monotonic() - began, 2)
        rollouts, _ = usage_records(home, thread)
        grade = subprocess.run(grader_command(task, REPO, workspace),
                               text=True, capture_output=True, env=env, timeout=120)
        quality = json.loads(grade.stdout)
        if task.get('followup'):
            resumed = subprocess.run(['node',str(REPO/'scripts/development-resume-grader.mjs'),str(workspace/'scripts/install-plugin.mjs')],text=True,capture_output=True,env=env,timeout=120)
            quality['resume'] = json.loads(resumed.stdout)
            quality['initial'] = initial_quality
            quality['pass'] = quality['pass'] and bool(initial_quality and initial_quality['pass']) and quality['resume']['pass']
        changed = sorted(set(command(['git', 'diff', '--name-only', 'HEAD'], workspace, env).splitlines() +
                         command(['git', 'ls-files', '--others', '--exclude-standard'], workspace, env).splitlines()))
        test_paths = changed_tests(task, changed)
        scope = all(allowed(task, p, test_paths) for p in changed)
        regression = regression_grade(workspace, prepared_archive, test_paths, root, env, task) if scope else {'pass': False, 'reason': 'Out-of-scope changes'}
        quality['regression'] = regression
        quality['pass'] = quality['pass'] and regression['pass']
        (root / 'repair.patch').write_text(command(['git', 'diff', '--binary', 'HEAD', '--',
                                          *task['sources'], task['testDir']], workspace, env))
        run = {'arm': arm, 'pairId': pair_id, 'task': task['id'], 'requireObservedModel': True,
               'scenario': {'repo': task['repo'], 'kind': task['kind'], 'contextMode': 'curated-local' if task['repo'] == 'ContextOS' else 'cold-local', 'compactTokenLimit': task.get('compactLimit')}, 'inputTree': input_tree, 'model': args.model, 'effort': args.effort,
               'baseCommit': base_commit, 'promptSha256': sha((prompt + task.get('followup', '')).encode()),
               'plugin': plugin if arm == 'contextos' else None,
               'candidateSnapshot': plugin, 'cliVersion': args.cli_version,
               'provider': 'chatgpt-http' if args.chatgpt_http else 'default',
               'status': status, 'stopReason': reason, 'elapsedSeconds': elapsed,
               'bounds': bounds, 'events': str(events), 'rollouts': [str(p) for p in rollouts],
               'workspace': str(workspace), 'home': str(home), 'quality': quality,
               'scopePass': scope, 'requireOsMutation': arm == 'contextos' and not task['fallback'], 'allowNativeFallback': task['fallback'], 'businessChanged': [p for p in changed if not p.startswith('.contextos/')]}
        (root / 'run.json').write_text(json.dumps(run, indent=2))
        summary = json.loads(command(['node', str(REPO / 'scripts/development-metrics.mjs'),
                                    str(root / 'run.json')], REPO, env))
        (root / 'summary.json').write_text(json.dumps(summary, indent=2))
        print(json.dumps({'arm': arm, 'pairId': pair_id, 'valid': summary['validForComparison'],
                          'metrics': summary['metrics'], 'stopReason': reason}), flush=True)
        return summary
    finally:
        (home / 'auth.json').unlink(missing_ok=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=['gpt-6-luna'], default='gpt-6-luna')
    parser.add_argument('--effort', choices=['max'], default='max')
    parser.add_argument('--codex', default=os.environ.get('CODEX_CLI_PATH', shutil.which('codex')))
    parser.add_argument('--setup-codex', default=shutil.which('codex'))
    parser.add_argument('--plugin', type=pathlib.Path, default=REPO / 'plugins/contextos')
    parser.add_argument('--ref')
    parser.add_argument('--repo', type=pathlib.Path)
    parser.add_argument('--task', choices=['canonical-parser-integrity', 'ownership-refresh', 'alignment-types', 'installer-json-resume'], default='canonical-parser-integrity')
    parser.add_argument('--pairs', type=int, choices=range(1, 6), default=1)
    parser.add_argument('--arms', nargs='+', choices=['native', 'contextos'], default=['native', 'contextos'])
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--max-requests', type=int, default=16)
    parser.add_argument('--max-input-tokens', type=int, default=300000)
    parser.add_argument('--max-uncached-input-tokens', type=int, default=50000)
    parser.add_argument('--max-output-tokens', type=int, default=12000)
    parser.add_argument('--total-input-tokens', type=int, default=600000)
    parser.add_argument('--total-uncached-input-tokens', type=int, default=120000)
    parser.add_argument('--total-output-tokens', type=int, default=30000)
    parser.add_argument('--total-seconds', type=int, default=1800)
    parser.add_argument('--total-runs', type=int, default=3)
    parser.add_argument('--ledger', type=pathlib.Path)
    parser.add_argument('--chatgpt-http', action='store_true')
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    requested = {'requests': args.max_requests, 'inputTokens': args.max_input_tokens,
                 'uncachedInputTokens': args.max_uncached_input_tokens,
                 'outputTokens': args.max_output_tokens, 'seconds': args.timeout}
    limits = {'inputTokens': args.total_input_tokens, 'uncachedInputTokens': args.total_uncached_input_tokens,
              'outputTokens': args.total_output_tokens, 'seconds': args.total_seconds, 'runs': args.total_runs}
    if any(value <= 0 for value in [*requested.values(), *limits.values()]):
        parser.error('All budgets must be positive')
    if len(args.arms) != len(set(args.arms)):
        parser.error('Each arm may appear only once per pair')
    args.plugin = args.plugin.resolve()
    args.task_spec = task_spec(args.task, args.repo)
    source_repo = args.repo.resolve() if args.repo else REPO
    args.ref = args.ref or args.task_spec['ref']
    output = (args.output or REPO / '.contextos/benchmarks' /
              ('development-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))).resolve()
    if output.exists():
        parser.error('Output exists; each invocation requires a fresh directory')
    auth_home = pathlib.Path(os.environ.get('CODEX_HOME', pathlib.Path.home() / '.codex'))
    args.cli_version = command([args.codex, '--version'], REPO, os.environ).strip()
    synthetic = args.cli_version.startswith('synthetic-') and os.environ.get('CONTROLLER_TEST_SOURCE') == str(REPO) + os.sep
    version = re.search(r'codex-cli (\d+)\.(\d+)\.(\d+)', args.cli_version)
    if not synthetic and (not version or tuple(map(int, version.groups())) < (0, 159, 2)):
        parser.error('Execution CLI 0.159.2+ with primary response accounting is required; use --codex. An older --setup-codex is allowed for installation only.')
    base_commit = command(['git', 'rev-parse', args.ref + '^{commit}'], source_repo, os.environ).strip()
    archive = subprocess.check_output(['git', 'archive', base_commit], cwd=source_repo)
    output.mkdir(parents=True)
    ledger = BudgetLedger(args.ledger or output / 'ledger.json', limits)
    results, stopped = [], None
    try:
        for pair in range(args.pairs):
            order = args.arms if pair % 2 == 0 else list(reversed(args.arms))
            minimum = ({'inputTokens': 100000, 'uncachedInputTokens': 15000, 'outputTokens': 5000, 'seconds': 180} if args.task == 'alignment-types' else {'inputTokens': 200000, 'uncachedInputTokens': 35000, 'outputTokens': 8000, 'seconds': 240}) if len(order) == 2 else None
            bounds = ledger.allocate(requested, len(order), minimum)
            pair_id = sha((str(output) + ':' + str(pair)).encode())[:12] if len(order) == 2 else None
            for position, arm in enumerate(order):
                live_bounds = ledger.allocate(bounds, len(order) - position, minimum)
                result = execute(arm, len(results) + 1, args, output, archive,
                                 base_commit, auth_home, live_bounds, pair_id)
                results.append(result)
                ledger.record(result)
                if not result['validForComparison']:
                    stopped = 'Incomplete or incorrect task: repair locally before another model run'
                    break
            if stopped:
                break
    except (ValueError, RuntimeError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        stopped = str(error) or 'Controller interrupted'
        launches = list(output.glob('*/launch.json'))
        if any(json.loads(p.read_text()).get('modelStarted') for p in launches) and len(launches) > len(results):
            ledger.state['unknownUsage'] = True
            ledger.save()
    report = {'schemaVersion': 2, 'task': args.task, 'results': results,
              'requestedBounds': requested, 'campaign': ledger.state, 'stopReason': stopped,
              'limitations': ['Single task; not a universal savings estimate.',
              'Input includes cached input and output includes reasoning; counts are not currency.',
              'Response-boundary stop thresholds may overshoot by one in-flight request.',
              'Both complete arms with the same pairId are required for an A/B comparison.']}
    (output / 'report.json').write_text(json.dumps(report, indent=2))
    ledger.close()
    print(json.dumps({'report': str(output / 'report.json'), 'stopReason': stopped}), flush=True)
    return 0 if results and not stopped else 2

if __name__ == '__main__':
    raise SystemExit(main())
