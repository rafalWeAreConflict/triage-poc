# Boilerworks Bootstrap

This is the primary conventions document for the Boilerworks Django platform.

An agent given this document and a business requirement should be able to generate correct, idiomatic code without exploring the codebase.

---

## What's Already Built

| Layer | What's there |
|---|---|
| Auth | Session-based auth (auth1), admin login, rate limiting on auth endpoints |
| Data | Postgres, `Tracking` base model (created/updated/deleted by + at, version, soft deletes, audit history on all models) |
| API | GraphQL (Strawberry), DRF, file upload (MinIO local / S3 prod) |
| Permissions | django-role-permissions, per-model/per-field permission checks, GQL middleware |
| Async | Celery worker + beat, Redis broker, DatabaseScheduler |
| Search | OpenSearch, ProfileDocument, signals for incremental indexing, `make reindex` |
| Email | django-ses (prod), Mailpit (local) |
| Feature flags | django-constance, admin UI, fieldsets |
| Rate limiting | django-ratelimit on auth endpoints |
| Admin | Custom dark theme, BaseCoreAdmin (import/export, tracking fields), DJDT |
| Rule engine | Conditions + Actions + RuleProviderMixin, Celery-backed evaluation |
| State machine | DFA model, cron-scheduled transitions via Celery beat |
| Copilot | Pydantic AI agent over AG-UI (`copilot` app), CopilotKit UI in the frontend, permission-checked tools over the forms + workflow engines |
| Infra | Docker Compose: postgres, redis, opensearch, minio (S3), celery-worker, celery-beat, mailpit, ui |
| CI | GitHub Actions: lint (pre-commit) + tests (postgres + redis services) |
| Seed | `make seed`, numbered fixtures, `--flush` flag |

---

## App Structure

| App | Purpose |
|---|---|
| `auth1` | Session-based authentication, login views, rate limiting |
| `core` | User, Profile, Address, Notification, ResourceFile, OpenSearch setup, telemetry, signals |
| `core_logs` | Permission access logging (`PermissionAccessLog`) |
| `core_rule_engine` | Rule definitions, conditions, actions, model signal triggers |
| `core_ui` | UI components, file processors |
| `copilot` | AG-UI copilot agent (Pydantic AI): endpoint view, tools, deps |
| `organization` | Organization + OrganizationMember models, member status |
| `pushnotif` | Push notifications, delivery methods, Celery tasks |
| `scheduled_task` | Background scheduled tasks |
| `testdata` | Dev fixtures, `seed` management command |

---

## Conventions

### Models

All business models inherit from one of:

**`Tracking`** (abstract) — use for any model that needs audit trails:
```python
from core.models import Tracking

class Invoice(Tracking):
    amount = models.DecimalField(...)
```
Provides: `version` (auto-increments on save), `created_at/by`, `updated_at/by`, `deleted_at/by`, `history` (simple_history).

**`BaseCoreModel(Tracking)`** (abstract) — use for named, addressable entities:
```python
from core.models import BaseCoreModel

class Product(BaseCoreModel):
    price = models.DecimalField(...)
```
Adds: `guid` (UUID, external identifier), `name`, `slug` (auto-generated, unique), `description`. Use `slug` as the natural key. Never expose integer PKs in the API — use `guid` or the relay global ID.

**Soft deletes:** set `deleted_at` and `deleted_by`, don't call `.delete()` on business objects.

---

### GraphQL (Strawberry)

Each app has: `appname/schema/types.py`, `queries.py`, `mutations.py`, `__init__.py`

Schema assembly: `config/schema.py` merges all apps. View: `core/schema/views.py`.

**Types:**
```python
import strawberry_django
from strawberry.types import Info
from core.schema.common import permission_filtered_queryset

@strawberry_django.type(Product)
class ProductType:

    @classmethod
    def get_queryset(cls, queryset, info: Info):
        return permission_filtered_queryset(queryset, info)
```

**Queries:**
```python
import strawberry
from strawberry.types import Info

@strawberry.type
class Query:

    @strawberry.field
    def products(self, info: Info, search: str = '') -> list[ProductType]:
        if not info.context.user.is_authenticated:
            raise GraphQLError('Authentication required')
        qs = Product.objects.all()
        if search:
            qs = qs.filter(name__icontains=search)
        return qs
```

**Mutations — always return `MutationResult` (ok + errors):**
```python
import strawberry
from strawberry.types import Info
from core.schema.common import MutationResult
from core.schema.mutations.base import restricted_serializer_mutate

@strawberry.type
class Mutation:

    @strawberry.mutation
    def create_product(self, info: Info, name: str, price: str) -> MutationResult:
        Product.p('model').add.check(info.context.user)
        return restricted_serializer_mutate(
            ProductSerializer, Product, info,
            data={'name': name, 'price': price},
        )
```

**Context:** Resolvers access user, dataloaders, and permissions via `info.context` (`StrawberryContext` from `core/schema/context.py`):
```python
info.context.user                    # authenticated user
info.context.organization            # user's active org
info.context.request_language        # preferred language
info.context.request_timezone        # user timezone or SYSTEM_TIME_ZONE
info.context.check_permission(...)   # cached permission check
info.context.get_loader(name, fn)    # get/create dataloader
```

**Auth check at the top of every resolver and mutation** — no exceptions.

---

### Permissions

Permissions are defined in `config/permissions.py` using `ModelPermissions`. The generated enum lives in `config/roles_gen.py` (regenerate with `make perms`).

Check permissions via:
```python
from config.roles_gen import P

P.PRODUCT_VIEW.check(info.context.user)          # raises PermissionDenied if denied
P.PRODUCT_CHANGE.check(info.context.user, False)  # returns False instead of raising
```

Define permissions in `config/permissions.py`:
```python
from config.permissions import ModelPermissions, FieldPermissions
from core.utils.permissions import AbstractPermissions

class ProductPermissions(ModelPermissions):
    model = FieldPermissions(
        view=P.PRODUCT_VIEW,
        add=P.PRODUCT_ADD,
        change=P.PRODUCT_CHANGE,
        delete=P.PRODUCT_DELETE,
    )
```

Assign permissions to groups in admin, never directly to users.

---

### Admin

All admin classes inherit from `BaseCoreAdmin`:
```python
from core.utils.admin import BaseCoreAdmin
from django.contrib import admin

@admin.register(Product)
class ProductAdmin(BaseCoreAdmin):
    list_display = ('name', 'slug', 'created_at')
    search_fields = ('name', 'slug')
```

`BaseCoreAdmin` automatically handles: `created_by/updated_by/deleted_by` as raw ID fields, audit fields as readonly, `save_model` setting created/updated by. Uses `ImportExportMixin` — all models get CSV import/export in admin.

---

### Celery Tasks

Tasks live in `appname/tasks.py`. Use `@app.task()` and import models inside the function:
```python
from config.celery import app

@app.task()
def process_invoice(invoice_id):
    from invoicing.models import Invoice
    invoice = Invoice.objects.get(id=invoice_id)
    invoice.process()
```

For retryable tasks:
```python
@app.task(bind=True, max_retries=3)
def send_notification(self, user_id):
    try:
        ...
    except Exception as exc:
        raise self.retry(exc=exc, countdown=60)
```

Async actions from workflow transitions go through `appname/tasks.py`.

---

### Copilot (AG-UI agent)

The copilot is a Pydantic AI agent served over the AG-UI protocol from a Django
async view at `POST /app/copilot/agui/` (`copilot/views.py`). Feature-gated by
`FEATURE_COPILOT`; requires `ANTHROPIC_API_KEY` (unset → 503, the rest of the
app is unaffected). Model configured via `COPILOT_MODEL`
(default `anthropic:claude-sonnet-5`).

**Auth.** The view rejects anonymous requests with 401 before any model call.
The authenticated user rides in `CopilotDeps`; the frontend bridge
(`frontend/app/api/copilotkit/route.ts`) authenticates the server-to-server hop
with `Authorization: Session <key>` from the `backend_jwt` cookie — the same
credential the Apollo clients send.

**Tools** live in `copilot/agent.py`: a sync implementation (ORM work) wrapped
by an async AG-UI-facing function, registered via the `TOOLS` tuple in
`build_agent()`. Every tool follows the same shape:

```python
def _my_tool_sync(user, ...) -> dict[str, Any]:
    if not P.MYMODEL_VIEW.check(user, raised_error=False):
        return _denied('view my models')
    ...  # thin wrapper over an existing engine/service — no new business logic
    return {'status': 'ok', ...}

async def my_tool(ctx: RunContext[CopilotDeps], ...) -> dict[str, Any]:
    """Docstring is the tool description the model sees — say what it needs."""
    return await sync_to_async(_my_tool_sync, thread_sensitive=True)(ctx.deps.user, ...)

# then add `my_tool` to the TOOLS tuple
```

Rules, same as GraphQL: permission check first (group-based, `P.*` enums),
external IDs only (slug / relay global ID via `GlobalIDUtils` — never integer
PKs), permission failures are tool *results* (not exceptions) so the agent can
explain.

**Human-in-the-loop.** Mutating tools with consequences (workflow
transitions; inert drafts are exempt) return
`{'status': 'confirmation_required', ...}` on the first call and change
nothing. The agent then calls `confirm_workflow_transition` — a **frontend**
tool registered by CopilotKit that renders the approve/deny card and returns
`{approved: true|false}` — and only re-calls the backend tool with
`confirmed=true` on approval. Keep this invariant for any new mutating tool,
and test both halves. `confirmed=true` alone is not trusted: the view rebuilds
the human's decisions (the frontend tools' results) from the submitted AG-UI
history (`copilot/approvals.py`), and the tool acts only on an unused decision
that matches what it is about to do — `create_ticket` needs the matching
`propose_triage` decision, `execute_workflow_transition` an approved
`confirm_workflow_transition` for the same instance and target state. One
decision authorises one action. This stops the model from acting without the
human (e.g. after a prompt injection); it does not stop the signed-in user from
forging their own history, as they hold the permission anyway. A new
consequential tool needs the same check.

**Frontend names must not collide — and render names must match.** Backend
tool names rendered by the frontend are mirrored in
`frontend/copilot/config.ts` (`COPILOT_TOOL_*` constants); a mismatch means
the render silently never fires. Frontend-registered tools (like
`confirm_workflow_transition`) must NOT share a name with any backend tool —
AG-UI merges both toolsets and pydantic-ai raises a hard error on duplicates.

**Tests** (`copilot/tests/`): drive the agent with Pydantic AI's
`TestModel`/`FunctionModel` (`ALLOW_MODEL_REQUESTS=False` — never live LLM
calls), real database, both allowed and denied cases per permission-gated
tool, and the unconfirmed/confirmed HITL pair.

---

### Tests

Use `schema.execute_sync()` for GraphQL tests:
```python
from django.test import TestCase
from config.schema import schema
from core.schema.context import StrawberryContext

class ProductTest(TestCase):

    def setUp(self):
        from organization.models import Organization, OrganizationMember
        self.org = Organization.objects.create(name='TestOrg')
        self.user = User.objects.create_superuser(username='test', email='t@t.com', password='x')
        OrganizationMember.objects.create(organization=self.org, member=self.user, is_active=True)
        self.user.profile.active_organization = self.org
        self.user.profile.save()

    def _context(self):
        from unittest.mock import MagicMock
        request = MagicMock()
        request.user = self.user
        request.session = {}
        request.headers = {}
        return StrawberryContext(request)

    def test_create_product(self):
        result = schema.execute_sync(
            'mutation { createProduct(name: "Widget", price: "9.99") { ok errors { field messages } } }',
            context_value=self._context(),
        )
        self.assertIsNone(result.errors)
        self.assertTrue(result.data['createProduct']['ok'])
```

For model-only tests use `django.test.TestCase` directly. No hardcoded values, no `pass` blocks, no fallback assertions.

---

### Code Style

This project follows **PEP 8** strictly, enforced by flake8 and isort pre-commit hooks. Key rules:
- Max line length: 140 characters (configured in `.flake8`)
- Imports sorted by isort; run `pipenv run isort .` to fix
- Two blank lines between top-level definitions
- Docstrings only where logic isn't self-evident

Run `make lint` or `pipenv run pre-commit run --all-files` before committing.

---

## Adding a New App

```bash
# 1. Create the app
./run.sh manage startapp myapp

# 2. Register in config/settings.py INSTALLED_APPS (before "End of Boilerworks")

# 3. Create models inheriting from Tracking or BaseCoreModel

# 4. Create migrations
make migrations

# 5. Create admin (inherit BaseCoreAdmin)

# 6. Create schema: myapp/schema/__init__.py
#    Wire into config/schema.py

# 7. Write tests extending BaseTest
make test
```

---

## Ports (local)

| Service | URL |
|---|---|
| Django API | http://localhost:8000 |
| Next.js UI | http://localhost:3000 |
| Django Admin | http://localhost:8000/app/admin/ |
| GraphQL | http://localhost:8000/app/gql/config/ |
| Copilot AG-UI | http://localhost:8000/app/copilot/agui/ (POST, session-authed) |
| Health | http://localhost:8000/health/ |
| Mailpit | http://localhost:8025 |
| OpenSearch | http://localhost:9200 |
| Postgres | localhost:5432 |
| Redis | localhost:6379 |
| Django metrics | http://localhost:8000/metrics |
| Postgres metrics | http://localhost:9187/metrics |
| Redis metrics | http://localhost:9121/metrics |
| MinIO S3 API | http://localhost:9000 |
| MinIO Console | http://localhost:9001 (minioadmin/minioadmin) |
| Flower (Celery) | http://localhost:5555 |

---

## Common Commands

```bash
make up           # Start the stack
make build        # Build and start
make down         # Stop the stack
make migrate      # Run migrations
make migrations   # Create new migrations (add app=<name> to scope)
make seed         # Load dev fixtures
make test         # Run tests
make lint         # Run flake8 + isort checks
make schema       # Export GraphQL SDL
make shell        # Shell into Django container
make logs         # Tail Django logs
make perms        # Regenerate config/roles_gen.py
make reindex      # Rebuild OpenSearch indices
make superuser    # Create Django superuser
make ps           # Show container status
```

---

## Process & brain

**Process mandate.** This template is a submodule of the boilerworks metarepo
([ConflictHQ/boilerworks](https://github.com/ConflictHQ/boilerworks)); its
`primers/PROCESS.md` is the full development process mandate for all template
work, and `primers/RELEASE_CHECKLIST.md` gates what ships.

**Navegador (code knowledge graph).** `.navegador/config.toml` configures the
[Navegador](https://github.com/ConflictHQ/navegador) graph for this repo
(local sqlite backend; `.navegador/graph.db` and `.navegador/.env` are
gitignored — the graph is a build artifact, rebuild it any time):

```bash
make navegador-ingest   # ingest . + enrich --framework django + export app/code-kg.json (conflict-kg/v1)
```

The exported `app/code-kg.json` is what the metarepo's
`aggregate-brains.py --code-kg` slot consumes.

**Brain node contract.** This repo is a federable brain node: `app/brain.json`
is the `{meta, nodes, edges}` envelope (version "1") defined by
`schemas/brain-envelope.schema.json` (nodes/edges conform to `brain-node` /
`brain-edge`). It is deterministic — nodes sorted by id, edges deduped and
sorted, `indent=1` — and **committed**, so the metarepo's `make aggregate-brain`
consumes it at the pinned SHA without running anything here.

```bash
make brain         # scripts/gen_brain_node.py -> app/brain.json (commit the result)
make check-brain   # validate against schemas/ + freshness (CI runs the same)
```
