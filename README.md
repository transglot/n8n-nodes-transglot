# n8n-nodes-transglot

An [n8n](https://n8n.io) community node package for [transglot](https://transglot.ai).

It gives you:

- **transglot** (action node): push source files, run AI translation, pull localized files, and read project / batch status.
- **transglot Trigger** (trigger node): start a workflow when a project event fires (batch completed, keys created, QA finished, …), via REST hooks.

Everything talks to your transglot install over the **deploy-token API** (`{baseUrl}/v1/...`). A deploy token *is* the project (deploy-key model), so there is no project id in any URL.

---

## Requirements and pricing

Requires a Transglot account, a project and a project access token. Hosted API access requires a paid Transglot plan (Starter or above). AI translation uses the workspace word allowance; usage and billing settings apply. See https://transglot.ai/pricing/ for current terms. The trigger requires webhook access and a reachable n8n webhook URL.

## Installation

**0.1.1 release candidate:** 0.1.0 is already on npm; 0.1.1 is being prepared for a provenance-backed update. The package is not yet verified by n8n. n8n Cloud installation requires verification; self-hosted installation depends on your n8n community-package policy.

Install it from the n8n UI:

1. Go to **Settings → Community Nodes → Install**.
2. Enter the package name: `n8n-nodes-transglot`.
3. Agree to the risk prompt and install.

Or, for a self-hosted instance, install into your n8n custom-nodes directory:

```bash
cd ~/.n8n/nodes        # or your N8N_CUSTOM_EXTENSIONS path
npm install n8n-nodes-transglot
```

Then restart n8n. See the n8n docs on [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/).

> **Publication:** n8n verification requires a public source repository and a GitHub Actions npm release with provenance. Run the official n8n package validation and a live smoke test before publishing. Do not publish this verification candidate directly from a local machine. The prepared submission kit includes a workflow template and reviewer instructions.

---

## Credentials

Create a **transglot API** credential:

| Field | Example | Notes |
| --- | --- | --- |
| **Base URL** | `https://api.transglot.ai` | The API root, with **no `/api` segment** (removed when the API moved to its own host). All calls go under `{baseUrl}/v1/...`. |
| **API Token** | `tgl_…` | A project **deploy token** minted in the web app. Stored encrypted by n8n. |

The token is sent as `Authorization: Bearer <token>`. Clicking **Test** issues
`GET {baseUrl}/v1/project`. A 200 confirms the URL, token, and project without changing
anything.

A deploy token carries abilities (`push` / `pull` / `manage` / `read` / `write`). The
operations here need:

| Operation | Endpoint | Ability |
| --- | --- | --- |
| Project → Get | `GET /v1/project` | any deploy ability |
| Project → Push Source | `POST /v1/push` | `push` |
| Project → Translate | `POST /v1/translate` | `manage` |
| Project → Pull | `GET /v1/pull` | `pull` |
| Batch → Get | `GET /v1/batches/{id}` | any deploy ability |
| Trigger subscribe / unsubscribe | `POST` / `DELETE /v1/webhooks` | `manage` |
| Trigger event catalog | `GET /v1/webhooks/events` | any deploy ability |

---

## Action node: `transglot`

### Project → Get

`GET /v1/project`. Returns
`{ id, name, slug, source_locale, locales[], keys_count, message_syntax, icu_dialect }`.

### Project → Push Source

`POST /v1/push` as `multipart/form-data`. Uploads one source file (read from a binary
property on the input item) and returns the push diff
(`{ keys_created, keys_deleted, source_updated, translations_written, conflicts[], unknown_keys[], warnings[], batch, quota_exceeded }`).
The node builds the same fields the CLI sends: `file` (the bytes plus a file name),
`format`, `locale`, and `mode=sync_removals` only when Sync Removals is on.

- **Input Binary Field**: the binary property holding the file to upload (default `data`).
  Feed it from a **Read/Write Files from Disk** or **HTTP Request** node.
- **Format**: the codec used to parse the uploaded source (same 20 formats as Pull).
- **Locale**: the locale the uploaded file's values are in (a configured project locale).
- **File Name** (Additional Fields): overrides the uploaded file name; defaults to the
  binary field's own file name. A `{locale}` placeholder is replaced with the Locale.
- **Sync Removals** (Additional Fields): when on, keys absent from the file are deleted
  from the project (`mode=sync_removals`). Off by default so a partial file never prunes keys.

**`{locale}`-collision guard.** When one Push node processes several input items, the node
refuses to upload the *same* resolved file name under two *different* locales in a single
execution, because that would push the same file twice. Give each locale its own name (add a
`{locale}` placeholder to **File Name**, or use distinct file names). Under
**Continue On Fail** the collision is reported as a per-item error instead of aborting.

### Project → Translate

`POST /v1/translate`. Starts an AI batch and returns **202** with the batch handle
(`{ id, status, trigger, total, completed, failed, … }`). Poll it with **Batch → Get**.

- **Scope**: `missing` | `stale` | `all` | `selected`.
- **Key IDs** (Additional Fields): comma-separated key IDs, used with `selected` (max 2000).
- **Locales** (Additional Fields): comma-separated target locales; empty = all configured targets.

Only one AI batch may run at a time; a second call returns **409** `active-batch` with the
running `batch_id`.

### Project → Pull

`GET /v1/pull?format=&locale=&min_state=`. Returns the serialized locale file. The node
emits `{ format, locale, content, parsed }`, where `content` is the raw file body and `parsed`
is the JSON-decoded object when the format is JSON-shaped (`json_*`, `flutter_arb`,
`laravel_json`). 20 formats are supported (JSON, Android XML, iOS `.strings`/`.xcstrings`,
Flutter ARB, XLIFF 1.2 / 2.0, Gettext `.po`, YAML, CSV, XLSX, `.properties`, `.resx`,
Markdown, Unity CSV, Unreal `.po`, …).

### Batch → Get

`GET /v1/batches/{id}`. Enable **Include Failures** to add `include=failures` and get the
per-item `[{ key, locale, error }]` list.

### Example: read a source file from disk and push it

A minimal **Read/Write Files from Disk → transglot** workflow that uploads
`locales/en.json` as the English source:

1. **Read/Write Files from Disk** (Read operation)
   - **File(s) Selector**: `locales/en.json`
   - **Put Output in Field**: `data`
2. **transglot**
   - **Resource**: `Project`
   - **Operation**: `Push Source`
   - **Input Binary Field**: `data`
   - **Format**: `JSON (Nested)`
   - **Locale**: `en`
   - (optional) **Additional Fields → Sync Removals**: on, to prune keys dropped from the file

To push several locales from one run, feed multiple binary items (one per file) and set
**File Name** to `strings.{locale}.json` with a per-item **Locale** so the uploads never
collide. Chain **Batch → Get** afterward to poll any translation batch the push queued
(the diff's `batch` field carries its id).

---

## Trigger node: `transglot Trigger`

Pick an **Event** (loaded live from `GET /v1/webhooks/events`, with a static fallback):

`batch.completed`, `batch.failed`, `key.created`, `key.updated`, `key.deleted`,
`translation.updated`, `translation.reviewed`, `language.added`, `glossary.updated`,
`qa.completed`, `source_drift.repaired`.

Lifecycle (REST hooks):

- **Activate** → `POST /v1/webhooks` with `{ url: <n8n webhook URL>, events: [<event>] }`;
  the returned subscription `id` is stored in the node's static data.
- **Deactivate / delete** → `DELETE /v1/webhooks/{id}`.

Each delivery is an HTTP `POST` whose body is emitted verbatim as the workflow item:

```json
{
  "event": "batch.completed",
  "delivered_at": "2026-07-08T09:41:00+00:00",
  "project": { "id": 12, "slug": "acme-web" },
  "batch": { "id": 4821, "status": "completed", "trigger": "push", "total": 240, "completed": 240, "failed": 0, "language_breakdown": { "fr": 120, "de": 120 }, "started_at": "2026-07-08T09:39:13+00:00", "finished_at": "2026-07-08T09:41:00+00:00" }
}
```

Some events **coalesce** (a burst of key/translation changes is debounced into one delivery
with `{ count, samples, window_seconds }` instead of the block shown above). The event
catalog (and each event's `coalesced` / `window_seconds` contract) is what the dropdown reads.

### Verifying delivery signatures (`X-Transglot-Signature`)

Every delivery is HMAC-signed. When you subscribe, the `POST /v1/webhooks` response includes
a `secret` **once** (it is never returned again). transglot signs the raw request body and
sends these headers:

| Header | Meaning |
| --- | --- |
| `X-Transglot-Event` | the event name |
| `X-Transglot-Delivery` | a unique delivery id |
| `X-Transglot-Timestamp` | unix seconds, part of the signed message |
| `X-Transglot-Signature` | `sha256=<hex>` |

The signature is Stripe-shaped:

```
signature = "sha256=" + HMAC_SHA256( key = secret, message = "{timestamp}.{rawBody}" )
```

The trigger verifies the HMAC over the exact request bytes with a constant-time comparison,
rejects timestamps outside a five-minute window (past or future), and checks the selected event
before emitting any workflow data. Invalid signatures return HTTP 401; a mismatched event returns
HTTP 400. Missing raw body bytes or a missing signing secret also fail closed.

The reveal-once secret is retained in the node's private workflow static data, following n8n's
REST-hook pattern, and removed when the subscription is deleted. Treat workflow exports and
backups containing static data as sensitive; limit access to the workflow and protect the n8n
database. The project API token remains in n8n credentials.

**Upgrading from 0.1.0:** deactivate and reactivate each Transglot Trigger workflow. Legacy
subscriptions without a retained signing secret are replaced on activation. This also renews a
subscription when its selected event changes. The timestamp window limits old replays; it does
not deduplicate repeated valid deliveries within the window. Use `X-Transglot-Delivery` at your
webhook gateway if your downstream action requires delivery-ID deduplication.

---

## Development

```bash
npm install
npm run build      # tsc -> dist/, then copies node icons into dist/
npm test           # action, trigger lifecycle and webhook authentication tests
npm run typecheck  # tsc --noEmit
npm run lint:community  # official n8n community-node rules
```

Before publishing, run the official n8n community-node linter
(`@n8n/eslint-plugin-community-nodes` / `eslint-plugin-n8n-nodes-base`). It is the canonical
gate for the n8n registry and checks node/credential/`package.json` conventions this local
ESLint config does not.

Full end-to-end validation (the credential **Test** button, the loadOptions dropdown, and the
webhook create/delete lifecycle) requires a running n8n instance pointed at a real transglot
install, because those code paths call `httpRequestWithAuthentication` / `getNodeWebhookUrl`, which
only exist inside the n8n runtime. The jest suite mocks that surface to assert the exact
requests the node builds.

## License

MIT


## Example workflows

The `examples/` directory includes two inactive workflows without credentials: translate missing strings and poll the batch, or react to `batch.completed`. Import one into n8n, select your Transglot credential, and confirm the project’s locales and usage settings before execution.
