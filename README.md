# natsel-control

Control Plane of [natsel](https://github.com/vvapnik/natsel) (POC): the gene pool, species and populations
live in Cloudflare D1; every change of a traffic distribution is published to Workers KV, where the
Breeder reads it on the edge. The API is a Cloudflare Worker protected by a bearer token
(`Authorization: Bearer <API_TOKEN>`); Cloudflare Access can replace the token later.

The Control Plane decides the distribution of traffic between species for each population;
the Breeder only executes it.

## Model

- **Gene** `<locus>.<name>` with 2+ alleles; allele 0 is the default. Gene names are never reused.
- **Species**: one allele of every live gene. A new gene enters every live species with allele 0.
- **Population**: species competing for one niche; its **distribution** gives each species a share (sums to 100%).
- **Invariant**: every allele is carried by at least one live species. A new gene's non-default alleles
  are reported as `orphans` by `GET /api/pool` until species carry them; a species cannot go extinct
  if it is the last carrier of an allele or still has traffic.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/pool` | live genes, species count, orphan alleles |
| GET, POST | `/api/genes` | list; register `{ name, description?, alleles: [labels] }` |
| POST | `/api/genes/sync` | sync with the genes in the deployed code `{ genes: [{ name, alleles }], dry_run? }`: creates new genes, appends new alleles, marks genes missing from the code removed; conflicts (fewer alleles, a removed name back) are reported, not applied; an empty list is refused |
| DELETE | `/api/genes/:name` | remove a gene (fixed or extinct) |
| GET, POST | `/api/species` | list (`?all=1` with extinct); create `{ name?, parent_id?, alleles: { gene: allele } }` |
| POST | `/api/species/:id/extinct` | extinction |
| GET | `/api/species/:id/history` | species history |
| GET, POST | `/api/populations` | list; create `{ id, name? }` |
| GET, DELETE | `/api/populations/:id` | population with its distribution |
| PUT | `/api/populations/:id/distribution` | `{ "<species id>": percent }`, two decimals max, sum 100 |
| GET | `/api/populations/:id/snapshot` | what the Breeder sees |

### KV snapshot (`population:<id>`)

```json
{ "population": "default", "version": 3, "published_at": "…",
  "species": [ { "id": "sp-33b978f5", "share_bp": 9000, "dna": "hero.cta=0;hero.headline=0" } ] }
```

`share_bp` is in basis points (10000 = 100%); `dna` is the unsigned payload, the Breeder signs it.
Species with a zero share are left out.

## Development

```bash
npm install
cp .dev.vars.example .dev.vars   # disables the Access check locally
npm run migrate:local
npm run dev
npm test
```

Deploy: create the D1 database and KV namespace, put their ids into `wrangler.jsonc`, then

```bash
npx wrangler secret put API_TOKEN   # e.g. the output of: openssl rand -base64 32
npm run migrate:remote
npm run deploy
```

Optional Cloudflare Access: set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` of the Access application; it then
replaces the token. Without either the Worker refuses every request.

natsel is developed with the help of Claude Code (Anthropic). License: MIT.
