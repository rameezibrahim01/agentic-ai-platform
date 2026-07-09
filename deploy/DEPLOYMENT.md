# Deployment

Client-site deployment is a first-class distribution model (architecture commitment #7).
One codebase, two profiles:

**1. Compose profile (pilots, small footprints, the Phase 1 artifact test)** — this directory.
`docker compose --env-file ../.env up` brings up Postgres + self-hosted Temporal (+ UI).
Worker/console services are commented until their Dockerfiles land (ticket 003 onward).

**2. Helm profile (production client sites)** — added at the Phase 1 exit; installs the entire
platform (control + data plane) on the client's Kubernetes.

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
