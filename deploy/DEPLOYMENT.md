# Deployment

Client-site deployment is a first-class distribution model (architecture commitment #7).
One codebase, two profiles:

**1. Compose profile (pilots, small footprints, the Phase 1 artifact test)** — this directory.
`docker compose --env-file ../.env up` brings up Postgres + self-hosted Temporal (+ UI).
Worker/console services are commented until their Dockerfiles land (ticket 003 onward).

**2. Helm profile (production client sites)** — `deploy/helm/agentic-platform` (ticket 049):
worker + console on the client's Kubernetes against client-provided Postgres/Temporal
endpoints; every compose config knob maps to values, secrets ride as secretKeyRef NAMES
only, and CI verifies the chart by rendering (`drill-p4-4-helm-render.sh`). Offline
installs: `deploy/helm/AIRGAP.md`.

## The shippable-dependency rule
Every runtime dependency is open-source, self-hostable, or client-provided:
Postgres and Temporal bundled or client-managed; traces over OTel into the client's stack;
SSO via SAML/OIDC directly against the client IdP (no SaaS identity broker in the artifact);
secrets from the client's Vault/KMS. The only required egress is the model endpoint —
pluggable between Anthropic API, private Bedrock/Vertex/Azure endpoints, a client-internal
LLM gateway, or a documented air-gap profile with locally served models (reduced capability,
stated honestly).

## Releases
Semver'd artifact = images + chart + forward-only migrations, installable offline from a
registry tarball. Telemetry phone-home is opt-in. License verification works offline.

## The read-only SQL tool (ticket 045)
`sql.query@v1` exists only when `tools.config.json` lists it AND names the
connection env var:

```json
{ "tools": ["sql.query@v1"], "sqlTools": { "connectionEnv": "SQL_TOOL_DATABASE_URL" },
  "grants": [{ "agent": "your-agent@v1", "tools": [{ "name": "sql.query", "version": "v1" }] }] }
```

The env var holds the connection string (a read-scoped role is on the client;
belt: every query also runs inside a `READ ONLY` transaction with a statement
timeout and a row cap). A named-but-empty env refuses boot. Point it at a
replica or a scoped role — never the platform's own superuser.

## The agents registry has two writers (tickets 053/055)
`agents.config.json` is edited by `scripts/promote.sh`/`rollback.sh` AND by
the console (builder creates, promote/rollback pointer moves). The file
stays the single source of truth with last-writer-wins between them; both
sides validate the WHOLE file before writing, so a concurrent edit can be
lost but never corrupted. Versions are append-only from every writer —
028's digest suite still fails CI if a published version's spec changes.
Console-authored versions have no golden eval suite: promoting one is
allowed but marked `unproven` in the UI and in `ops_audit` (regenerate the
manifest with `scripts/evals/gen-console-manifest.sh` when suites change).
Rollback is never gated — by eval status or anything else.

## Connectors (tickets 057/058)
Agents reach real systems only through config-named connectors:

- **Files & spreadsheets** (`fileTools`): point `docsDir` at a read-only
  mount of the department's documents and `dataDir` at a SEPARATE writable
  folder for appended rows. The shipped profile uses `./demo-docs` and the
  `sheets` volume — replace the mount, keep the shape. Reads are capped and
  path-contained; `sheet.append` is a governed write (prod approval).
- **Email** (`mailTools`): point `imapUrlEnv`/`smtpUrlEnv` at env vars
  holding your IMAP/SMTP URLs (credentials embedded — secrets, named-var
  pattern). Add the mail hosts to `egressAllowlist` and set
  `allowedRecipientDomains` or every send is refused (deny by default).
  No SMTP = read-only mailbox. IMAP/SMTP keep this fully on-premise.

Enable a connector's tools in `tools.config.json` (`tools` array + a grant
per agent), restart the worker, and the builder's tool picker shows them.
