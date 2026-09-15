# Out-of-Context Command Execution
id: rule-out-of-context-commands
category: performance
summary: Run build and test commands through out-of-context runner to preserve conversation tokens.

## Best Practice
1. Use run_command for tests, builds, and scripts.
2. The runner preserves full raw logs in .contextos/logs/ while returning a concise, token-efficient receipt.
3. When failures occur, the receipt automatically captures relevant error diagnostics and stack traces without noise.
