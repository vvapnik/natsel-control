# AGENTS.md

Notes for AI coding agents working in this repository.

- natsel is developed with the help of Claude Code (Anthropic).
- Language of the public repo: English. Vocabulary follows the natsel glossary (gene, allele, species, population, Breeder, `dna`).
- Pure rules live in `src/rules.js` and are unit-tested (`npm test`); D1/KV code in `src/index.js`.
- Schema changes only as new files in `migrations/`; never edit an applied migration.
- Never weaken `src/auth.js` / `src/access.js`: `ACCESS_DISABLED=1` is for `.dev.vars` only.
