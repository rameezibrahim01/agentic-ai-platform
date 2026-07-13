# Getting started — see the platform work in 15 minutes

## What this is, in three sentences

This platform lets a company run AI agents the way it runs employees: every
agent has a written job description (an immutable version), it can only touch
the systems it was explicitly granted, anything risky stops and waits for a
human to approve it, and everything it ever did is in a tamper-evident log.
You create and run agents from a web page — no code. It runs entirely inside
your own network: your database, your servers, optionally your own models.

## 1. Boot it

You need Docker. From the repo:

```sh
cd deploy
cp .env.example .env          # then edit: set POSTGRES_PASSWORD to anything
docker compose up -d --build  # first build takes a few minutes
```

Open **http://localhost:3000** and sign in with the development account
`dev-admin` / `dev-password` (a real deployment uses your company SSO —
see `deploy/DEPLOYMENT.md`).

> Without an `ANTHROPIC_API_KEY` the platform runs a built-in stub model:
> every governance step below is real, the "intelligence" is scripted.
> Adding a key later is one line in `.env`.

## 2. Create your first agent (in the browser)

Go to **agents → create agent**. Fill in:

- **name**: `walkthrough-agent`
- **description**: my first agent
- **prompt**: append the walkthrough note
- **model**: `stub-model`
- **tools**: tick `notes.append@v1` (a safe demo tool that writes one line
  to a file — the platform's stand-in for "update the CRM")
- leave the budgets as they are

Press **save immutable version**.

**What just happened:** you created `walkthrough-agent@v1` — a *version*,
not an editable record. Improving the agent later means saving `@v2`; `@v1`
never changes, so an auditor can always answer "what exactly was this agent
told to do on that day?". The creation itself was recorded in the operations
audit table, with your name on it.

## 3. Promote it to prod

On the agent's page you'll see two environment rows: **dev** already points
at your new version (a brand-new agent starts life in dev — that's why
"promote to dev" would have nothing to do), and **prod** says *no pointer
yet*. On the **prod** row, press **promote to prod**.

**What just happened:** environments are pointers at versions. Promotion
moves the pointer; rollback moves it back — one click, no rebuild, because
the old version never stopped existing. Notice the version is marked
*unproven — no eval suite*: agents shipped with the platform are gated by
automated test suites in CI, and the platform refuses to pretend your
hand-made agent has passed tests it doesn't have.

## 4. Run it

On the agent's page press **run it**, type anything as input, press
**start run**. You land on the run's live timeline.

**What just happened:** the run is executing under *prod* policy. The agent
decided to use its `notes.append` tool — a **write**, so the platform did
NOT execute it. The timeline shows the run paused at `awaiting_approval`.
The model never touches systems directly; it only *proposes*, and a gateway
you control disposes.

## 5. Approve its write

Open the **approval inbox**. You'll see the pending request: which agent,
acting for whom, what tool, what arguments. Press **approve**.

**What just happened:** the run resumed, the note was written (exactly once
— even if approvals or retries race), and the run completed. Back on the
timeline you can read the whole story: started → model called → intent →
policy said "requires approval" → requested → granted by you → executed →
completed. That chain is append-only and survives restarts, crashes, and
time.

## 6. Where the money went

Open **costs**. Every run's token usage and cost is metered per step and
rolled up per agent — budgets are enforced by the engine (a runaway agent
is stopped mid-run), not by asking the model nicely.

## Where departments fit

Everything you just did can be repeated per department (accounts, finance,
HR…) as isolated **tenants**: each gets its own database schema, its own
task queue, its own encryption key, and console sessions that cannot see
across. See `deploy/tenants.config.json` and `deploy/DEPLOYMENT.md`.

## Going deeper

- `deploy/DEPLOYMENT.md` — real deployments: SSO/SCIM, per-tenant keys,
  Kubernetes/Helm, air-gapped sites.
- `docs/architecture.md` — why it's built this way (the seven commitments).
- `scripts/drills/run-all.sh` — every claim above, machine-checked; the
  walkthrough you just did by hand runs in CI as `drill-p5-1-authoring.sh`.
