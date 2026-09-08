# Contributing to mdflow

Thanks for helping improve mdflow. Focused bug reports, reproducible benchmark results, documentation fixes, and small pull requests are especially useful while the project is young.

## Before opening an issue

1. Search existing issues and confirm the problem still occurs on the latest release.
2. Run `node --version`; the CLI and MCP server require Node.js 22 or later.
3. Include the command you ran, the result you expected, and the smallest useful error excerpt.
4. Remove tokens, private paths, repository secrets, and proprietary source code from logs or graph excerpts.

## Local development

```bash
npm ci
npm test
npm run plugin:build
```

For changes to context retrieval, AST slicing, mutation, storage, or log sanitization, also run:

```bash
npm run benchmark
```

The macOS app can be compiled with:

```bash
npm run desktop:build
```

## Pull requests

- Keep the change focused and explain the concrete trigger and resulting behavior.
- Add or update tests when behavior, storage, parsing, or rollback semantics change.
- Keep `.mdflow/graph.json` synchronized when the change alters architecture, plans, or verification evidence.
- Do not commit `.mdflow/mdflow.sqlite`, local credentials, generated build directories, or private project data.
- Include screenshots for visible macOS app changes.

By contributing, you agree that your work is licensed under the repository's [MIT License](LICENSE).
