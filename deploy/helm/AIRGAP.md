# Air-gapped installation

The platform's shippable-dependency rule (CLAUDE.md #8, `deploy/DEPLOYMENT.md`)
means an install needs nothing from the public internet at runtime. This is
the offline flow.

## 1. Build and bundle images (connected side)

```sh
docker build -t agentic-platform-worker:VERSION  -f apps/worker/Dockerfile .
docker build -t agentic-platform-console:VERSION -f apps/console/Dockerfile .
docker save agentic-platform-worker:VERSION agentic-platform-console:VERSION \
  | gzip > agentic-platform-VERSION-images.tgz
helm package deploy/helm/agentic-platform   # -> agentic-platform-0.1.0.tgz
```

Carry both tarballs (plus this repo's `deploy/` for reference configs) across
the gap.

## 2. Load into the client registry (gapped side)

```sh
docker load < agentic-platform-VERSION-images.tgz
docker tag agentic-platform-worker:VERSION  registry.client.internal:5000/agentic-platform-worker:VERSION
docker tag agentic-platform-console:VERSION registry.client.internal:5000/agentic-platform-console:VERSION
docker push registry.client.internal:5000/agentic-platform-worker:VERSION
docker push registry.client.internal:5000/agentic-platform-console:VERSION
```

## 3. Client-provided services and secrets

Postgres and Temporal are the client's (self-hosted, both open-source). Create
the connection secret — the chart only ever references it by NAME:

```sh
kubectl create secret generic platform-database \
  --from-literal=url='postgres://platform:…@postgres.client.internal:5432/platform'
```

Same pattern for optional keys (data keys, per-tenant keys, provider key,
session secret, SCIM token): one secret each, referenced from
`values.yaml`'s `secrets` block. Key material never enters values files.

## 4. Install offline

```sh
helm install platform agentic-platform-0.1.0.tgz \
  --set image.registry=registry.client.internal:5000/ \
  --set image.tag=VERSION \
  -f client-values.yaml
```

`client-values.yaml` carries the platform configs (tools/agents/limits/
tenants JSON) and secret NAMES. The values schema is strict — a typo'd key
refuses to render rather than silently deploying a misconfiguration.

## Honest notes

- **No model endpoint = reduced capability, stated plainly**: without a
  reachable model endpoint the worker runs the hermetic stub — every
  governance drill still passes; the agent is not intelligent. Private
  Bedrock/Vertex/Azure endpoints or a client-internal LLM gateway slot in
  via `MODELS_CONFIG` + `secrets.anthropicApiKey`-style refs.
- **Kill-switch flips in k8s** are `kubectl edit configmap` / GitOps commits
  (read-only ConfigMap mounts). The console's 047 web-flip path applies to
  the compose/bare-metal profile where the limits file is writable.
- **Browser agent creates in k8s** (ticket 053) hit the same wall: the
  agents registry rides the read-only ConfigMap, so the builder refuses
  with instructions. New versions land via GitOps edits to
  `configs.agents` in values; moving the registry to a writable volume is
  a client-infra decision, not a chart default.
- The real-cluster `helm install` is the human/infra half of this drill —
  CI verifies the chart by rendering (lint + template + invariant checks),
  recorded in `docs/drills/phase-4.md`.
