# Boilerworks — Django + Next.js + CopilotKit

Production-ready Django + Next.js boilerplate with an **agentic in-app copilot pre-wired**. Everything from [boilerworks-django-nextjs](https://github.com/ConflictHQ/boilerworks-django-nextjs) — forms engine, workflow engine, visual builders, session auth, GraphQL, Celery, role-based permissions, audit trails — plus a CopilotKit copilot whose agent lives in Django, speaks the AG-UI protocol, and can only do what the logged-in user can do.

See [`bootstrap.md`](bootstrap.md) for conventions, patterns, and how to add new features.

---

## Triage POC: maintenance-request triage for housing cooperatives

This checkout is a proof of concept built on the template, made for **CopilotKit Certified Developer** ([the bar](https://www.copilotkit.ai/certification#the-bar)). An AI assistant for a housing cooperative admin takes a resident's maintenance request (text and optionally a photo). It classifies the request by category and priority, proposes a contractor, and creates the ticket only after the admin approves it. It also learns from admin corrections through **CopilotKit Intelligence**.

The plan, in Polish, is in `../PLAN_POC_TRIAGE.md`.

| Piece | Where |
|---|---|
| Domain (Building, Unit, Category, Contractor, Ticket) | `backend/triage/` |
| Ticket workflow `new → proposed → approved → assigned → closed` (plus `proposed → new` for corrections) | `backend/triage/workflow.py`, Boilerworks workflow engine, audit trail in `TransitionLog` |
| Agent (Pydantic AI, in the Django process, over AG-UI) | `backend/copilot/` |
| CopilotKit v2 runtime + Intelligence client + Learning Container `triage-demo-2` | `frontend/app/api/copilotkit/[[...slug]]/route.ts` |
| Chat sidebar, threads drawer, tool renders, shared-state types | `frontend/copilot/` |

**Trimmed frontend.** The Boilerworks template's demo UI was removed from the frontend so only what the triage demo needs is left: `/dashboard` (demo charts), `/playground`, `/documentation`, `/table`, `/form`, `/hooks`, `/secured`, the Form Engine UI (`/forms` + `components/forms`), the template data tables, the "Projects" and team-switcher sidebar scaffolding, and the copilot's `show_form_definitions` / form-draft cards. Left: `/triage` (home), `/workflows`, `/settings`, login/auth, the copilot sidebar, threads drawer and Inspector. The backend forms engine and the agent's form tools stay (only the prompt rule for `show_form_definitions` was dropped); the template *Features* list further down describes the upstream template.
| Triage screen (`/triage`: embedded chat + live ticket list) | `frontend/app/(app)/triage/`, `frontend/components/triage/` |
| AG-UI shared state (ticket list + draft) | `backend/copilot/triage_state.py` |
| Dev-only login bridge (no Auth0 locally) | `backend/auth1/dev_login.py` |
| Skill delivery (published Skills → agent instructions) | `frontend/copilot/learned-skills.ts`, `frontend/app/api/copilotkit-skills/route.ts`, `backend/copilot/learned_skills.py` |

### Infrastructure

```
Browser (Next.js UI: /triage, chat, ticket list, threads drawer, CopilotKit Inspector)
   │  AG-UI over HTTP + SSE (cookies: backend_jwt / sessionid)
   ▼
ui container :3000 (Next.js 16 dev server)
   ├─ /api/copilotkit/*        CopilotKit v2 runtime + CopilotKitIntelligence client ──► CopilotKit Intelligence (managed cloud):
   │                           (identifyUser → Django /app/copilot/whoami/)               threads, AG-UI event history, Learning, Skills
   ├─ /api/copilotkit-skills   published Skills snapshot (SkillRegistry)  ◄──────────────┘
   └─ HttpAgent ──► boilerworks-local :8000 (Django 6, ASGI)
                      ├─ /app/copilot/agui/   Pydantic AI agent over AG-UI (tools, HITL, STATE_SNAPSHOT)
                      │      └─► LLM: AnthropicModel → OpenRouter (Claude Haiku 4.5) or Anthropic
                      ├─ /app/gql/config/     Strawberry GraphQL (triageTickets, triageCategories, ...)
                      ├─ /app/admin/          Django admin (triage data, workflows, TransitionLog)
                      └─ /app/auth1/dev-login dev-only login bridge
                            │
                            ├─ postgres-local :5432 (Postgres 17: app data, workflow state, sessions)
                            ├─ redis-local :6379 (cache incl. Skill-snapshot cache, Celery broker)
                            └─ minio-local :9000 / console :9001 (S3-compatible storage for ticket photos)
```

| Container | Port(s) | Compose profile | Role |
|---|---|---|---|
| `boilerworks-local` | 8000 | default | Django: GraphQL, admin, AG-UI agent endpoint |
| `ui` | 3000 | default | Next.js dev server + CopilotKit runtime. `node_modules` live in an anonymous volume inside the container. |
| `postgres-local` | 5432 | default | Postgres 17, database `boilerworks`. Data in `docker/runtime/postgres-local/postgres_data` |
| `redis-local` | 6379 | default | cache + Celery broker |
| `celery-worker`, `celery-beat` | none | default | async workflow actions, scheduled tasks |
| `mailpit-local` | 8025 (UI), 1025 (SMTP) | default | catches outgoing mail |
| `minio-local` (+ `minio-init`) | 9000, 9001 | `storage` | ticket photos (bucket `boilerworks`) |
| `opensearch-local` | 9200 | `search` | search indexing. Not needed for the POC; its "Failed to index" log noise is harmless. |
| `flower`, exporters | 5555, … | `monitoring` | not needed |

Things that live outside Docker:
- **CopilotKit Intelligence (managed):** project `triage-poc`, Learning Container `triage-demo-2` (`COPILOT_LEARNING_CONTAINER_ID`, default `triage-demo-2`). Dashboard at https://dashboard.operations.copilotkit.ai. The Developer plan includes 5 learning runs a month.
- **LLM provider:** OpenRouter or Anthropic.

The code is bind-mounted into the containers (`backend/` → `/boilerworks`, `frontend/` → `/app`). Django autoreloads and Next hot-reloads, so editing files never needs a rebuild. Rebuild the image (`./run.sh rebuild`) only after a `Pipfile` change.

Ports 3000, 8000, 5432, 6379 and 9000 must be free. Stop any other local stack that uses them first. Browsers share `localhost` cookies across ports, so another app's cookies can also break login (see *Log in*).

### Minimal demo stack

The demo only needs six containers. Everything else in the template can stay off.

| Needed | Why |
|---|---|
| `boilerworks-local` | the Django agent (AG-UI), GraphQL, admin, workflow engine |
| `ui` | Next.js and the CopilotKit runtime, which is the connection to Intelligence |
| `postgres-local` | data, sessions, workflow state, `TransitionLog` |
| `redis-local` | Django cache: rate limits and the learned-Skill cache |
| `minio-local` + `minio-init` | ticket photos (multimodal scene) |

These are **not needed**: `celery-worker` and `celery-beat` (ticket transitions have no workflow actions), `mailpit-local` (no outgoing mail), `opensearch-local`, `flower` and the exporters.

Start only the minimal set:

```bash
docker compose -f docker/docker-compose.yaml --profile storage up -d boilerworks-local ui postgres-local redis-local minio-local minio-init
```

Stop the extras if a full `./run.sh` started them:

```bash
docker compose -f docker/docker-compose.yaml stop celery-worker celery-beat mailpit-local
```

**Feature flags.** Add these to `backend/config/local.env` (gitignored), then recreate the backend with `docker compose -f docker/docker-compose.yaml up -d --force-recreate --no-deps boilerworks-local`:

```dotenv
FEATURE_OPENSEARCH=false     # no search indexing; also removes the "Failed to index profile" log noise
FEATURE_METABASE=false
FEATURE_ROCKETCHAT=false
```

Check them with `docker exec boilerworks-local python manage.py features`. Keep these on:

- **`FEATURE_FORMS`, `FEATURE_WORKFLOWS`, `FEATURE_COPILOT`:** the agent endpoint is mounted only when all three are enabled, and tickets use the workflow engine.
- **`FEATURE_PUSH_NOTIFICATIONS`:** other apps import `pushnotif` models directly, so turning it off crashes Django at startup. This is a template limitation.
- **`FEATURE_CELERY`:** its Django apps stay installed even though the worker containers are stopped.

**Authentication stays.** Boilerworks `auth1` provides Django sessions (normally issued after an Auth0 login), and permissions come from groups via organization membership. The demo needs this:

- **CopilotKit Intelligence scopes threads to a user.** `identifyUser` goes through `/app/copilot/whoami/`.
- **Approvals are audited.** Approving requires the *Triage Admin* role, and the `TransitionLog` records who approved.
- **The agent can only do what the user can do.** Every agent tool re-checks the user's permissions.

Locally, Auth0 is replaced by the dev-only `/app/auth1/dev-login` bridge (see *Log in*), so you don't need to configure Auth0.

### Requirements

- **Docker Desktop.** Python, pipenv and Node run inside the containers.
- **An LLM key.** The agent uses `AnthropicModel`. Point it either at Anthropic directly or at OpenRouter (see below).
- **A CopilotKit Intelligence project** (for threads, learning and Skills). Get it with `npx copilotkit@latest login` and create a project (free Developer plan), or run the CopilotKit onboarding CLI. Without `CPK_INTELLIGENCE_API_KEY` the app still runs: the chat, tools and approval cards work, but there is no threads drawer, no Automatic Learning and no Skill delivery.

### 1. Environment

**`backend/config/local.env`** (gitignored; `./bootstrap.sh` creates it from `example.env`).

The LLM goes through OpenRouter's Anthropic-compatible API, so it needs no code change:

```dotenv
ANTHROPIC_API_KEY=sk-or-v1-...                        # OpenRouter key (or a real sk-ant- key)
ANTHROPIC_BASE_URL=https://openrouter.ai/api          # omit when using Anthropic directly
COPILOT_MODEL=anthropic:anthropic/claude-haiku-4.5    # OpenRouter model id after "anthropic:"
                                                      # direct Anthropic: anthropic:claude-haiku-4-5
```

Use a stronger model (e.g. `anthropic:anthropic/claude-sonnet-5.5`) if the learning demo needs it. After changing `local.env`, recreate the backend containers. A plain restart does not re-read `env_file`:

```bash
docker compose -f docker/docker-compose.yaml up -d --force-recreate boilerworks-local celery-worker celery-beat
```

**`frontend/.env`** (gitignored). The CopilotKit CLI writes it. The runtime passes the key to `CopilotKitIntelligence`, and it is server-only:

```dotenv
CPK_INTELLIGENCE_API_KEY=...
COPILOT_LEARNING_CONTAINER_ID=triage-demo-2   # optional; this is the default
```

**`frontend/local.env`** (gitignored). Compose loads it for the `ui` container:

```dotenv
NEXT_PUBLIC_COPILOT_ENABLED=true
```

### 2. First run (from scratch)

1. **Set up the stack.**

   ```bash
   git clone <this repo> triage-poc && cd triage-poc
   ./bootstrap.sh                                                        # creates backend/config/local.env and a secret key, builds the Docker image
   # edit backend/config/local.env: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, COPILOT_MODEL (see step 1 above)
   printf 'NEXT_PUBLIC_COPILOT_ENABLED=true\n' > frontend/local.env      # turn the copilot UI on
   ./run.sh                                                              # start the stack and run migrations
   docker compose -f docker/docker-compose.yaml --profile storage up -d  # MinIO for ticket photos
   ./run.sh superuser                                                    # your admin account (interactive)
   ./run.sh manage seed_triage                                           # cooperative demo data (adds superusers to Triage Admin)
   ```

2. **Connect CopilotKit Intelligence (once per machine and project).** Run these from `frontend/`:

   ```bash
   npx --yes copilotkit@latest login                                                        # browser sign-in
   npx --yes copilotkit@latest project select                                               # select or create a project; writes CPK_INTELLIGENCE_API_KEY to frontend/.env
   npx --yes copilotkit@latest learning containers create --id triage-demo-2 --name triage-demo-2 --json
   ```

   The Learning Container id must match `COPILOT_LEARNING_CONTAINER_ID` in `frontend/.env` (default `triage-demo-2`). To start a fresh learning space, create a new container and set that variable. After you change `frontend/.env`, restart the UI with `docker restart ui`.

3. **Check that it works.**

   ```bash
   curl -s http://localhost:3000/api/copilotkit/info | python3 -m json.tool | head -20   # "mode": "intelligence", runtimeEntitlements "ready"
   ```

   Then log in through `/app/auth1/dev-login` (next section) and open http://localhost:3000/triage.

**Daily use:** `./run.sh` to start (MinIO keeps running if it was started), and `./run.sh stop` to stop. Data persists across restarts: Postgres in `docker/runtime/postgres-local/postgres_data` (bind mount, gitignored) and MinIO in the `minio-data` volume.

`seed_triage` is idempotent. Use `./run.sh manage seed_triage --flush` to wipe and re-create the triage data only. It creates:

- **Organization and group:** "Linden Street Housing Cooperative" (`linden-coop`), with a **Triage Admin** group that holds all superusers. Ticket permissions only apply through organization membership, so re-run the seed after creating a new superuser.
- **Buildings and units:** Building A / Building B (12 and 14 Linden Street, Springfield), units A/1–A/5 and B/1–B/5.
- **Categories:** 7 of them: Plumbing, Electrical, Heating, Building Administration, Elevators, Cleaning, Other.
- **Contractors:** 7 of them: FlowFix Plumbing, BrightSpark Electric, WarmHome Heating, Linden Coop Building Management, LiftPro Elevators, CleanBlock Services, HandyCrew.
- **Tickets:** 6 sample tickets across all workflow states, with transition history.

The seed deliberately does **not** encode the cooperative's rule that elevator issues go to building administration. The agent has to learn it from one admin correction (the learning demo).

### 3. Log in (local)

The frontend normally logs in through Auth0, and the `AUTH0_*` values are placeholders locally. Use the dev-only bridge instead. It responds only when `DEBUG` is on and the configuration is `Local`.

1. Open http://localhost:8000/app/auth1/dev-login.
2. Sign in with your superuser on the Django admin form.
3. You are sent to http://localhost:3000/triage (the home page), already logged in.

If you get **CSRF 403**, **401 Unauthorized** in the chat, or **"Agent run failed: HTTP 401"** in the Inspector, the browser is sending a stale or user-less session. The usual cause is old `localhost` cookies from another local app or an earlier login, because cookies are shared across ports. Open `/app/auth1/dev-login` again to get a fresh session. If that doesn't help, clear the cookies for `localhost` or use `127.0.0.1`.

Pages can still look logged in, because GraphQL's DEBUG `autologin` treats anonymous requests as the default test user. The copilot doesn't do that. It checks the user through `/app/copilot/whoami/`, which has no autologin.

### 4. Where things are

| What | URL |
|---|---|
| **Triage screen** (demo, home page after login; `/` redirects here): embedded chat + live **Tickets** list + threads drawer | http://localhost:3000/triage |
| Workflow builder (list / new / builder) and Settings, with the **Assistant** chat sidebar + threads drawer on the right | http://localhost:3000/workflows, http://localhost:3000/settings |
| Triage data (tickets, buildings, units, categories, contractors) | http://localhost:8000/app/admin/triage/ |
| Ticket workflow instances / definition | http://localhost:8000/app/admin/workflows/workflowinstance/ |
| CopilotKit runtime info | http://localhost:3000/api/copilotkit/info |
| CopilotKit Inspector | the CopilotKit (kite) button in the app: Home shows *Intelligence connected*, Rich Threads, AG-UI Events |
| CopilotKit Intelligence dashboard (threads, Learning, Skills) | https://dashboard.operations.copilotkit.ai |
| MinIO console (ticket photos) | http://localhost:9001 (`minioadmin` / `minioadmin`) |

### 5. Commands

```bash
./run.sh                    # start the stack (migrations included)
./run.sh stop               # stop it
./run.sh status             # container status
./run.sh logs 200           # Django logs
docker logs -f ui           # Next.js / CopilotKit runtime logs
./run.sh manage seed_triage [--flush]
./run.sh migrate
./run.sh makemigrations triage
./run.sh perms              # regenerate config/roles_gen.py after model permission changes
./run.sh schema             # export the GraphQL schema for the frontend
```

**Tests and lint.** `pytest` in the container currently fails on the `snapshottest` plugin under Python 3.12, so use Django's runner. flake8 and isort are not installed in the image, so run them on the host:

```bash
docker exec boilerworks-local python manage.py test triage copilot auth1
docker exec ui npx vitest run
docker exec ui npm run typecheck
docker exec ui npm run lint
docker exec ui npm run format:check
cd backend && uvx flake8==7.3.0 --max-line-length=140 triage copilot auth1 && uvx isort==8.0.1 --check-only triage copilot auth1
```

Frontend `node_modules` live only inside the `ui` container (anonymous volume), so run every `npm`/`npx` command through `docker exec ui …`.

### 6. What to ask the Assistant

Open http://localhost:3000/triage (first item in the nav) and start each scenario in a **New Conversation** from the threads drawer. On `/triage` the chat is embedded in the page, so the global Assistant sidebar is not mounted there. The agent:

1. resolves the unit (`find_units`)
2. lists categories and contractors (`list_categories`, `list_contractors`)
3. shows a **ticket card** (`propose_triage`, human-in-the-loop) with **Approve** / **Correct**, while the list on the right shows a **Draft / in progress** row

Each backend tool call shows as a compact chip in the stream (`useDefaultRenderTool`), and `create_ticket` has its own *Ticket created* card (`useRenderTool`).

Only after your decision does it call `create_ticket`. That creates the `Ticket` and moves it through `propose → approve` in the workflow engine. The new ticket appears at the top of the list with a brief green ring, without a page refresh.

| Scenario | Message | Expected |
|---|---|---|
| Happy path | `The kitchen tap in flat A/4 keeps dripping. Reported by Anna Novak.` | Plumbing / FlowFix Plumbing / normal. Click **Approve** and the ticket is `approved`. |
| Photo (multimodal) | Paste or drag an image (or use **+**), then `Water leaking under the sink in flat B/2, see photo. Reported by Kate Lewis.` | The agent describes the defect from the photo, and the card shows "Photo attached". The photo is stored in MinIO and linked to the ticket. |
| Learning 1: the mistake | `The elevator in stairwell B stops between floors. Reported by John Smith, flat B/3.` | The agent proposes Elevators / LiftPro Elevators. Click **Correct**, choose *Building Administration* (the contractor auto-selects *Linden Coop Building Management*), add the comment `In our cooperative all elevator issues go to building administration — we have a service contract.`, then click **Save correction**. |
| Learning 1b: more evidence (each in its own new thread) | `The lift doesn't come to the 4th floor in Building A. Reported by Peter Green, flat A/5.` and `Strange grinding noise from the elevator in Building B. Reported by Laura White, flat B/1.` | Same correction as *Learning 1*: **Correct** → *Building Administration* / *Linden Coop Building Management*, with the same comment. |
| Learning 2: carry-forward (new thread) | `There's a squeaking noise in the elevator in Building A. Reported by Mary Wilson, flat A/4.` | After CopilotKit Intelligence has learned and approved the Skill, the agent proposes *Building Administration* and cites the lesson. |
| History | Reload the page and reopen a thread from the drawer | Messages, tool chips, the card and its decision are all restored, and so is the list state (the header shows the snapshot's *Updated* time). |

Formats: photos can be jpeg, png, webp or gif (not HEIC), and are shrunk to 1568 px before sending.

Check the database:

```bash
docker exec boilerworks-local python manage.py shell -c "from triage.models import Ticket; print([(t.unit.number, t.status, t.admin_correction) for t in Ticket.objects.order_by('-created_at')[:5]])"
```

### Learning demo (stage 4)

The bar asks to *"show it corrected once, then show it carrying that correction forward."* The cooperative rule is
not in the code, the prompt or the seed. The agent only gets it from a Skill that CopilotKit Intelligence learned
and an admin approved.

**How a published Skill reaches the agent (Skill delivery).** The runtime does not inject Skills into the AG-UI
request. `getLearningContainerId` only tags threads for analysis, and agents pull published Skills through an
Intelligence SDK adapter ([Skill delivery docs](https://docs.copilotkit.ai/intelligence/learned-skills)). There is
no Pydantic AI adapter, so:

1. The Next.js runtime runs CopilotKit's own `SkillRegistry` (`@copilotkit/runtime/internal/learned-skills`, the
   one the Mastra and LangGraph adapters use). It uses the server-held `CPK_INTELLIGENCE_API_KEY` and container
   `triage-demo-2`, and serves the verified snapshot at `GET /api/copilotkit-skills`. That endpoint needs a signed-in
   session. It revalidates with Intelligence via ETag every 5 s.
2. Before each run, the Django AG-UI view pulls that endpoint server-to-server (`COPILOT_SKILLS_URL`, default
   `http://ui:3000/api/copilotkit-skills`) with the run's own `Authorization: Session <key>`. It caches the result
   for `COPILOT_SKILLS_CACHE_SECONDS` (60 s) in the Django cache.
3. The agent appends an **"Approved lessons from CopilotKit Intelligence (organization scope)"** block to its
   instructions (`copilot.agent.learned_lessons`). The block holds each Skill's name, description and `SKILL.md`,
   and the agent cites an applied lesson as `Lesson: <name>` (the card also accepts the older `Lekcja: <name>`).
   The ticket card then shows a **Lesson applied** badge. With no published Skills, nothing is appended.

**Inspector vs. dashboard.** The CopilotKit Inspector's *Automatic Learning* tab always shows the project's default
Learning Space (`triage-poc`). It only knows a container configured statically, and this app assigns threads with
the recommended `getLearningContainerId` selector. To review Insights, candidates and Skills for `triage-demo-2`, use
the Intelligence dashboard or the CLI.

Trust boundary: lessons come only from that server-side fetch. `RunAgentInput.context`, `forwardedProps`, `state`
and messages from the browser are never read as lessons.

**Steps (live, on camera)**

1. **Correct it once.** In `/triage`, open a **New Conversation** and run *Learning 1* from the table above. The
   agent proposes Elevators / LiftPro Elevators. Click **Correct**, pick *Building Administration*, add the
   comment, then click **Save correction** and let it create the ticket. Each correction belongs in its own New
   Conversation. More corrected threads give the run more evidence (see *Learning 1b*).

   **Change only the category.** The learning run learns from the fields you actually change, not only from the
   comment. Set *Category* to Building Administration, check that the contractor switched to Linden Coop Building
   Management, leave the priority alone, and use the same comment every time. A correction that changes only the
   priority teaches the opposite rule: keep elevators with LiftPro.

   Check the saved corrections before you spend a run. Every line should end with `['category', 'contractor']`:

   ```bash
   docker exec boilerworks-local python manage.py shell -c "from triage.models import Ticket; [print(t.unit.number, t.category.code, t.contractor.slug, list((t.admin_correction or {}).get('changed_fields', {}))) for t in Ticket.objects.exclude(admin_correction={}).order_by('-created_at')]"
   ```
2. **Learn.** In the [Intelligence dashboard](https://dashboard.operations.copilotkit.ai), open **Automatic
   Learning**, then **triage-demo-2**, then **Start manual run now**. This uses one of the 5 monthly runs. Follow it
   under **Analysis results**, then check **Insights** and **Skills**.
3. **Approve.** Approve the Skill candidate in the dashboard, or from the CLI in `frontend/`:

   ```bash
   npx --prefer-offline --yes copilotkit@4.23.1 learning candidates list triage-demo-2 --json
   npx --prefer-offline --yes copilotkit@4.23.1 learning candidates get triage-demo-2 <candidate-id>
   npx --prefer-offline --yes copilotkit@4.23.1 learning candidates approve triage-demo-2 <candidate-id>
   npx --prefer-offline --yes copilotkit@4.23.1 learning skills list triage-demo-2 --json
   ```

   In the container's **Skills** tab, **Skill delivery** must show **Delivery enabled**.
4. **Check delivery.**
   - Open http://localhost:3000/api/copilotkit-skills while signed in. It should show the new Skill under
     `skills` and a new `revision`.
   - Run `docker exec boilerworks-local python manage.py triage_lessons --clear` to drop Django's 60 s cache.
   - After the next message in `/triage`, check what the agent actually loaded. Either run
     `docker exec boilerworks-local python manage.py triage_lessons --full`, or look at the Django log line
     `copilot skill delivery: 1 approved lesson(s) loaded [<name>] (status=ok, container=triage-demo-2, revision=…)`
     (`./run.sh logs`).
5. **Carry it forward.** Open a **New Conversation** and send
   `There's a squeaking noise in the elevator in Building A. Reported by Mary Wilson, flat A/4.` Expect
   **Building Administration** / Linden Coop Building Management on the first card, with `Lesson: <name>` in the
   reasoning and the **Lesson applied** badge. Click **Approve**.

If the run ends with an Insight but no Skill candidate, nothing can be approved or delivered. Add one or two more
corrected threads with an explicit comment, then run again. A Skill appears in the agent at the earliest one cache
window after approval (≤ 60 s, or right away after `triage_lessons --clear`).

### 7. CopilotKit integration notes

- **Packages:** `@copilotkit/react-core`, `react-ui` and `runtime` are pinned to `1.76.0`, and `@ag-ui/client` to `1.0.1`. CopilotKit requires `zod` 3.25.76 and `lucide-react` 0.525.0.
- **Runtime:** the v2 `CopilotRuntime` with `CopilotKitIntelligence`, mounted on the full route subtree (`/api/copilotkit/*`; the provider uses `useSingleEndpoint={false}`). Thread REST routes are served for the Inspector and the drawer.
- **Learning Container:** `getLearningContainerId` returns `triage-demo-2` for `boilerworks_agent`. The Intelligence *project* is `triage-poc`; `triage-demo-2` is a Learning Container inside it. A single container is used for the whole cooperative (organization scope). Its published Skills come back to the agent through Skill delivery (see *Learning demo (stage 4)*).
- **`identifyUser`:** resolves the Django user via `GET /app/copilot/whoami/`. This endpoint has no DEBUG autologin, unlike GraphQL `me`. A missing or stale session returns 401.
- **Shared state (AG-UI):** the agent is stateful. `CopilotDeps` implements Pydantic AI's `StateHandler` (a dataclass with a `state` field), so `AGUIAdapter` loads `RunAgentInput.state` into it on every run. The state is `{tickets, draft, last_created_guid, last_updated}` and the backend pushes it as `STATE_SNAPSHOT` events (`backend/copilot/triage_state.py`):
  - **run start:** the ticket list is refreshed from the database, and the draft is reconciled with the admin's answer to `propose_triage`;
  - **`propose_triage` call:** the view's stream wrapper turns the tool-call arguments into `draft`, with no extra LLM tool;
  - **`create_ticket` success:** the tool returns a `ToolReturn` whose `metadata` is the snapshot (fresh list, draft cleared). Pydantic AI emits it right after the tool result.

  The frontend reads `agent.state` with v2 `useAgent` (`frontend/components/triage/LiveTriageTicketList.tsx`) and merges it by guid with the GraphQL `triageTickets(limit)` query. The query fills the list before any run and keeps tickets from other threads, because switching threads resets `agent.state`. Every new snapshot refetches the query. Intelligence stores the snapshots with the thread, so reopening a thread restores its state.
- **Known follow-ups:**
  - thread-ownership checks on the thread routes (not needed for a single-user POC)
  - the Pydantic AI AG-UI adapter drops `useCopilotReadable` / `useAgentContext` context unless the view is moved to the two-step `AGUIAdapter.from_request` form
  - `npm run build` has not been run

---

## Stack

| Layer | Tech |
|---|---|
| Backend | Django 6, Strawberry GraphQL, DRF, Celery, Postgres, Redis, OpenSearch |
| Frontend | Next.js 16 (App Router), Apollo Client, TypeScript, Tailwind CSS, shadcn/ui |
| Copilot | CopilotKit (React UI) + Pydantic AI agent in Django over the AG-UI protocol |
| Infra | Docker Compose — all services containerised |

---

## Features

### AI Copilot
- **CopilotKit** chat sidebar in the Next.js app, restyled to shadcn/Tailwind
- Agent lives **in the Django process** (Pydantic AI over the AG-UI protocol) — direct ORM access, no separate agent service
- **Session-auth end to end**: the copilot endpoint sits behind the same httpOnly-cookie session auth as GraphQL; every tool re-checks group permissions, so the agent can only do what the logged-in user can do
- Tools wired to the engines below: draft form definitions (forms engine), inspect states and execute transitions (workflow engine) — transitions are **human-in-the-loop** (approve/deny in the UI before anything runs)
- Generative UI: tool results render as components, with page context via `useCopilotReadable`
- Feature-flagged and additive — without an `ANTHROPIC_API_KEY` the template runs as plain django-nextjs

### Forms Engine
- **JSON Schema-based** form definitions with 21+ field types
- Visual form builder in **Django admin** (drag-and-drop, per-type config, JSON toggle)
- Visual form builder in **Next.js** (React, live preview, @dnd-kit)
- Dynamic renderer (`DynamicForm`) that generates forms from schema at runtime
- Field types: text, textarea, number, date, time, email, URL, select, multi-select, radio, file upload, signature, rating, scale, PIN, percentage split, section headers, page breaks, images
- Conditional logic engine (show/hide/require/calculate based on field values)
- Versioned definitions with publish/archive lifecycle
- Form submissions with validation, scoring, and prefill

### Workflow Engine
- **DB-configurable state machines** (states, transitions, conditions, actions)
- Visual workflow builder in **Django admin** (state/transition editor with validation)
- Visual workflow builder in **Next.js** (ReactFlow canvas with drag-and-drop)
- State config: attached forms, assigned roles, colors, initial/final flags
- Transition conditions: role checks, field comparisons, auth checks
- Transition actions: notifications, emails, webhooks, field updates
- Async action execution via **Celery** (Temporal.io integration planned)
- GenericForeignKey — attach workflows to any Django model
- Immutable audit trail (TransitionLog)

### Auth & Permissions
- Django session auth via `auth1` app (Auth0 SSO flow)
- Frontend auth gate with entry-point redirects (frontend login → frontend, admin login → admin)
- Group-based permissions (never assigned directly to users)
- Field-level permission filtering on GraphQL types
- Permission guard components (server + client)

### GraphQL API
- **Strawberry GraphQL** with strawberry-graphql-django
- Async dataloaders with `sync_to_async`
- Relay-style connections with `total_count`
- Mutation audit logging via schema extension
- Rate limiting on GraphQL endpoints

### Frontend
- Next.js 16 App Router with server + client components
- Apollo Client with SSR hydration (`@apollo/client-integration-nextjs`)
- shadcn/ui component library + Tailwind CSS
- Dashboard with chart components (Recharts — area, bar, donut)
- Data tables with server-side pagination, filtering, sorting
- 7-language i18n (next-intl)
- Dark mode, breadcrumbs, sidebar navigation
- Sentry error tracking, global error boundary

### Infrastructure
- Docker Compose with all services (Django, Postgres, Redis, Next.js, Celery, Flower, OpenSearch, MinIO, Mailpit)
- Feature toggle system (`config/features.py`) with Docker Compose profiles
- Health check endpoint (`/health/`)
- Prometheus metrics endpoint (`/metrics`)
- OpenTelemetry tracing (configurable exporter)
- S3-compatible file storage via MinIO

---

## Getting Started

**Requirements:** Docker Desktop only. Python, pipenv, and Node run inside containers.

```shell
# Clone and start
git clone https://github.com/ConflictHQ/boilerworks-django-nextjs-copilotkit.git
cd boilerworks-django-nextjs-copilotkit

# First time
./bootstrap.sh

# Daily
./run.sh          # start the stack
./run.sh stop     # stop
./run.sh logs     # tail Django logs
./run.sh health   # per-service health check
```

To enable the copilot, set `ANTHROPIC_API_KEY` in `backend/config/local.env` (see `example.env`). Everything else works without it.

---

## Local URLs

| Service | URL |
|---|---|
| Frontend | http://localhost:3000 |
| Django Admin | http://localhost:8000/app/admin/ |
| GraphQL Playground | http://localhost:8000/app/gql/config/ |
| Health Check | http://localhost:8000/health/ |
| Flower (Celery) | http://localhost:5555 |
| Mailpit | http://localhost:8025 |
| MinIO Console | http://localhost:9001 |
| Metrics | http://localhost:8000/app/metrics/ |

---

## Common Commands

```shell
./run.sh migrate               # run migrations
./run.sh makemigrations <app>  # create new migration
./run.sh schema                # export GraphQL schema
./run.sh perms                 # regenerate config/roles_gen.py
./run.sh shell                 # Django Python shell
./run.sh manage <cmd>          # any manage.py command
```

Or via Make (inside the Django container):

```shell
make test       # run tests
make seed       # load dev fixtures
make lint       # flake8 + isort
make reindex    # rebuild OpenSearch indices
```

---

## Code Quality

Backend enforces **PEP 8** via flake8 and isort (max line length: 140).
Frontend uses **Prettier** with `prettier-plugin-tailwindcss`.

```shell
# Backend
make lint

# Frontend
npm run format:check
npm run format
```

---

## Permissions

Permissions are group-based — never assign them directly to users.

1. Define permissions in `config/permissions.py`
2. Regenerate the enum: `./run.sh perms`
3. Assign to groups via Django admin
4. Check in code: `P.FOO_VIEW.check(info.context.user)`

See [bootstrap.md](bootstrap.md) for the full pattern.

---

## History

Boilerworks has been built and battle-tested in production at [CONFLICT](https://weareconflict.com) for 5 years. Git history was scrubbed for open-source publication.

---

## Contributing

We'd love for people to use Boilerworks, extend it, and make it better. File issues, open PRs, or start a discussion. See [CONTRIBUTING.md](CONTRIBUTING.md) if it exists, or just jump in.

---

## License

MIT

---

Boilerworks is a [CONFLICT](https://weareconflict.com) brand. CONFLICT is a registered trademark of CONFLICT LLC.
