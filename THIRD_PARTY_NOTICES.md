# Third-Party Notices

yas-harness bundles no third-party source code. It depends on the packages
listed below, each distributed under its own license by its own authors.

Full license texts ship inside each package under `node_modules/<name>`.
The authoritative list of versions is `package-lock.json`.

## Runtime dependencies

| Package | Version | License |
| --- | --- | --- |
| [pg](https://github.com/brianc/node-postgres) | ^8.22.0 | MIT |

## Development dependencies

| Package | Version | License |
| --- | --- | --- |
| [@eslint/js](https://github.com/eslint/eslint) | ^9.19.0 | MIT |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | ^22.13.0 | MIT |
| [@types/pg](https://github.com/DefinitelyTyped/DefinitelyTyped) | ^8.20.0 | MIT |
| [eslint](https://github.com/eslint/eslint) | ^9.19.0 | MIT |
| [eslint-config-prettier](https://github.com/prettier/eslint-config-prettier) | ^10.0.1 | MIT |
| [prettier](https://github.com/prettier/prettier) | ^3.4.2 | MIT |
| [tsx](https://github.com/privatenumber/tsx) | ^4.19.2 | MIT |
| [typescript](https://github.com/microsoft/TypeScript) | ^5.7.3 | Apache-2.0 |
| [typescript-eslint](https://github.com/typescript-eslint/typescript-eslint) | ^8.22.0 | MIT |
| [vitest](https://github.com/vitest-dev/vitest) | ^3.0.4 | MIT |

## Container images

| Image | License |
| --- | --- |
| [pgvector/pgvector](https://github.com/pgvector/pgvector) | PostgreSQL License |
| [node](https://github.com/nodejs/docker-node) (Alpine variants) | MIT |

## Reference projects

The following projects were studied as architectural references while building
this harness. **No code was copied from them**, and none is a dependency:

- [eve](https://github.com/vercel/eve)
- [OpenClaw](https://github.com/openclaw/openclaw) — MIT
- [Corsair](https://github.com/corsairdev/corsair) — Apache-2.0

---

Keep this file in step with `package.json` whenever a direct dependency is
added, removed or relicensed.
