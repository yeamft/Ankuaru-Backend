# ANKUARU backend

One TypeScript service (Express 5 on Node.js 22+) backed by PostgreSQL.

```text
React / TanStack frontend
       | REST + server-sent events
       v
ANKUARU API :4000  (backend)
       |
       v
  PostgreSQL
```

The API owns authentication, listings, inquiries, Telegram imports, admin
moderation, audit events, and realtime delivery. It is stateless apart from the
database, so you can run several instances behind a load balancer: sessions,
rate limits, and realtime fan-out all go through PostgreSQL.

## Code structure

`backend/src` is organized as a modular monolith: each business module owns
its domain code and exposes a small public API through its `index.ts`:

```text
src/
  config/                # Environment parsing and PostgreSQL pool setup
  modules/
    admin/
    auth/
    content/                # News publishing and exchange-rate management
    kyc/                    # Individual and business verification applications
    marketplace/
  infrastructure/        # Migrations, database transaction and realtime adapters
  shared/                # Domain-neutral helpers
  app.ts                 # HTTP application and cross-module composition
  server.ts              # Process startup and graceful shutdown
```

The API uses a modular monolith organized around its actual domains rather than
generic user/workspace examples. Each module owns its HTTP behavior and domain
data access, and exposes a small public API through `index.ts`. `app.ts`
composes the modules; `server.ts` owns process lifecycle. Keep configuration in
`config/`, database/realtime adapters in `infrastructure/`, and reusable,
domain-neutral helpers in `shared/`.

This replaces the earlier Express gateway + Axum trade service + Redis split. The
endpoints and response shapes are unchanged, except for the pagination and
realtime notes below.

## Project layout

```text
src/
  server.ts                 Startup: config, migrations, realtime listener, HTTP server
  app.ts                    Express wiring: middleware and module routes only
  config/env.ts             Environment variables -> typed config
  infrastructure/
    database/               Pool, transactions, migration runner
    realtime/               Per-process event hub and the LISTEN/NOTIFY connection
  shared/                   Errors, HTTP error handling, pagination, input helpers
  modules/
    auth/                   Accounts and sessions; guards.ts protects other modules' routes
    marketplace/            Listings, inquiries, Telegram imports, inquiry events
    admin/                  Moderation, verification, settings, audit trail
    events/                 GET /api/events stream
    health/                 GET /api/health
```

Each module follows the same pattern:

- `routes/` maps paths to handlers.
- `controllers/` reads the request, applies guards, and writes the response.
- `services/` validates input, runs SQL, and enforces business rules.

A module's `index.ts` is its public API, and other code imports from there only.
`infrastructure/` and `shared/` never import from `modules/`.

## Run locally

Start PostgreSQL (or point `DATABASE_URL` at your own instance):

```sh
docker compose -f backend/docker-compose.yml up -d
cd backend
cp .env.example .env
npm install
npm run dev
```

The API listens on `http://127.0.0.1:4000` by default. It applies pending SQL
migrations from `backend/migrations/` at startup, before accepting requests. An
advisory lock makes sure only one instance migrates at a time. Each migration runs
in its own transaction and is recorded with a checksum in `schema_migrations`;
editing an applied migration stops startup. Add changes as new numbered files.
Databases already migrated by the old Axum service (`_sqlx_migrations`) are
adopted automatically, without migrations running a second time.

| Variable              | Default                 | Purpose                                      |
| --------------------- | ----------------------- | -------------------------------------------- |
| `DATABASE_URL`        | required                | PostgreSQL connection string                 |
| `HOST` / `PORT`       | `127.0.0.1` / `4000`    | Bind address                                 |
| `DATABASE_POOL_SIZE`  | `10`                    | Connections per instance (plus one listener) |
| `SESSION_TTL_SECONDS` | `86400`                 | Session lifetime                             |
| `ENABLE_DEMO_AUTH`    | `false`                 | Demo identities (development/test only)      |
| `PHONE_OTP_SECRET` | required in production | HMAC key for phone OTP codes (at least 32 characters) |
| `SMS_DELIVERY_URL` / `SMS_DELIVERY_TOKEN` | no default | SMS gateway endpoint and bearer token |
| `SMS_SENDER_ID` | optional | Sender ID sent to the configured SMS gateway |

The SMS gateway receives a JSON POST with `to`, `message`, and optional
`sender_id` fields. Local development without a gateway returns a development
code to the client; this behavior is disabled outside development/test.

### Legacy marketplace import

After configuring `DATABASE_URL`, run `npm run legacy:import` from `backend/`
to import offers and news created on or after `LEGACY_IMPORT_SINCE` (defaults to
`2026-10-01T00:00:00+03:00`). `LEGACY_NEWS_SINCE` can set a different cutoff for
news only. `LEGACY_API_BASE_URL` can override the source API
base URL. News is read from `UserService/fetchnewsdetails` and published as
ANKUARU posts; Telegraph article text is used for the body when the source URL
is a `telegra.ph` page. The importer validates every source response before
writing and can be rerun safely: it adds unseen records without replacing
profiles, listings, news posts, or activity already present on this site.

Imported profiles keep their source IDs and are not identity-verified. A
profile can be claimed only by registering with the same unambiguous phone
number and completing this site's phone OTP verification. Passwords, sessions,
and administrator roles are never imported. Source-active, non-hidden offers
are visible on the marketplace while inactive or hidden offers remain closed.
Inquiry and account-management actions remain unavailable until the owner
claims the profile and completes the site's verification requirements.

The frontend reads `VITE_API_URL` (default `http://localhost:4000`). The API
allows browser requests from any origin; protected endpoints still require
authentication. For an Expo-hosted preview, set `VITE_API_URL` to a publicly
reachable HTTPS API URL. `localhost` refers to the device or browser running
the preview, not your development computer, and CORS cannot override that
browser loopback-address restriction.
`VITE_REALTIME_URL` is no longer used.

When running many instances, budget `instances × (DATABASE_POOL_SIZE + 1)`
connections, or put PgBouncer (or a managed pooler) in front of PostgreSQL. The
realtime listener needs a session-mode connection, because `LISTEN` does not work
through transaction-mode pooling.

## Endpoints

```text
GET    /api/health                  Database health (503 when unreachable)
POST   /api/auth/phone-otp          Request an OTP before registration or verification
POST   /api/auth/phone-otp/verify   Verify the signed-in account's phone number
GET    /api/listings                Live listings; ?intent=buy|sell&category=… (paged)
GET    /api/listings/:id            Live listing detail
POST   /api/listings                Create a listing for the signed-in user
GET    /api/my-listings             The signed-in user's listings, any status (paged)
POST   /api/my-listings/:id/publish Publish a prepared listing after KYC approval
POST   /api/imports/telegram        Parse a copied Telegram trade post into a reviewable listing
GET    /api/inquiries               Inquiries the user sent or received (paged)
POST   /api/listings/:id/inquiries  Send an inquiry to the listing owner
PATCH  /api/inquiries/:id           Update status (New, Responded, Resolved, Closed)
GET    /api/events                  Server-sent event stream for the signed-in user
GET    /api/admin/overview          Admin operational metrics
GET/PATCH /api/admin/listings       Listing review and moderation (paged)
GET/PATCH /api/admin/traders        Trader verification and account status (paged)
GET/PATCH /api/admin/verifications  Verification queue, pending first (paged)
GET/PATCH /api/admin/inquiries      Privacy-safe inquiry oversight, no message bodies (paged)
GET/PATCH /api/admin/settings       Persisted marketplace settings
GET/POST /api/kyc                   Read or submit individual/business verification
GET    /api/content/news            Published posts for the public journal
GET/POST/PATCH /api/content/admin/posts        Admin post creation and publishing
GET/POST /api/content/admin/exchange-rates     Admin exchange-rate history
GET    /api/admin/users             Accounts; ?q= (name or email), ?account_role=, ?status= (paged)
POST   /api/admin/admins            Make a registered account an admin: {"email"} or {"user_id"}
DELETE /api/admin/admins/:id        Remove an account's admin access
```

Errors are JSON: `{"error": "<code>", "message": "<text>"}`.

### Pagination

Paged endpoints return a JSON array of at most `limit` items (default 50, max
100), newest first. When more rows exist, the response carries an
`X-Next-Cursor` header; pass it back as `?cursor=…` to fetch the next page.
Cursors are keyset-based, so pages stay consistent while new rows arrive. Callers
that ignore the header get the first 50 items.

### Realtime

`GET /api/events` is a `text/event-stream` authenticated like any other request
(a Bearer session, or a demo identity when enabled). New inquiries arrive as:

```text
id: evt_…
event: inquiry.created
data: {"id":"evt_…","event_type":"inquiry.created","recipient_user_id":"…","occurred_at":"…","inquiry":{…}}
```

The event is raised with `pg_notify` inside the transaction that creates the
inquiry, so it is delivered only if that transaction commits, and it reaches
streams on every instance. Streams send a keep-alive every 25 seconds and close
when the session is revoked (logout, suspension, password change). Events raised
while a client is disconnected are not replayed; clients should reload their
inquiry list after reconnecting.

## Listing API

A listing requires `intent` (`buy` or `sell`), `category`, and `product`.
Optional fields are `quantity`, `price_amount` (a non-negative number),
`price_currency` (default `USD`), `available_from` (`YYYY-MM-DD`), `description`, and
`image_url`. The owner is always the signed-in user. The public market returns only
`Active` and `Closing Soon` listings.

## Telegram trade-post imports

`POST /api/imports/telegram` accepts copied group messages with a stable
`message_id` and `text`. It recognizes the common coffee template (intent, origin,
grade, process, transaction, and quantity) and creates a **Pending Review**
listing. Imports are idempotent per Telegram message ID, including concurrent
imports of the same message. Runs of seven or more digits (phone numbers) are
removed from the stored description. Unrecognized chat messages return `422`
rather than being published as marketplace content.

This is an import API, not a Telegram bot connection. A production bot/webhook should
verify Telegram's webhook secret before forwarding messages to this endpoint.

## Admin operations

Every state-changing admin operation writes an audit event in the same
transaction, so a failed audit write rolls back the change. Verification reviews
are guarded so concurrent decisions commit only once. Approval activates a pending
trader, but no review overrides a suspension. Real admin requests require a
valid Bearer session whose account has `account_role = 'admin'`. Public
registration and profile updates cannot grant this role or mark a trader
verified. With demo access enabled locally, the API also accepts
`x-demo-admin-id: admin-demo`; production always rejects it.

### Administrators

Admins sign in like any trader, with an account whose `account_role` is `admin`;
the role is read on every request, so granting or removing it takes effect at
once. Make the first admin from the command line, after that person has
registered through the app:

```sh
npm run admin:grant -- someone@example.com
```

Afterwards, admins add and remove others from the Users page. To prevent a
lockout, admins cannot remove their own admin access or suspend themselves, and
no change may leave the marketplace without an active admin. Granting, removing
and suspending are audited like every other admin change.

## Demo identities

Set `ENABLE_DEMO_AUTH=true` with `NODE_ENV=development` to use the existing demo
frontend. Requests without a Bearer token then act as `buyer-demo`, or as
`seller-demo` with `x-demo-user-id: seller-demo`. A supplied Bearer token is always
validated; an invalid token never falls back to demo access. Production rejects
every demo identity.

## Validation

```sh
cd backend
npm test
```

Tests run every migration and query against embedded PostgreSQL (PGlite with
pgcrypto), so they need no external database or Docker. They cover:

- identity rules, validation, pagination, Telegram imports, and inquiries
- realtime delivery and rollback
- admin audit rollback and concurrent verification reviews
- migration adoption from sqlx
- registration, login, sessions, suspension, and rate limits

PGlite has a single connection: concurrent tests run serially, and the realtime
listener uses PGlite's own `listen()` in place of a separate `pg` connection.

## Authentication and accounts

Sessions default to 24 hours (`SESSION_TTL_SECONDS`, allowed range 60–2592000
seconds).

| Method | Endpoint             | Body / result                                                                      |
| ------ | -------------------- | ---------------------------------------------------------------------------------- |
| POST   | `/api/auth/register` | `{email, password, display_name, role?}` → user and session, 201                   |
| POST   | `/api/auth/login`    | `{email, password}` → user and session, 200                                        |
| GET    | `/api/auth/me`       | Bearer session → `{user}`                                                          |
| PATCH  | `/api/auth/me`       | Bearer session plus `{display_name?, role?}` → `{user}`                            |
| POST   | `/api/auth/logout`   | Revoke the supplied session, 204; repeat calls are harmless                        |
| POST   | `/api/auth/password` | Bearer session plus `{current_password, new_password}` → 204; revokes all sessions |

Registration and login return this shape:

```json
{
  "user": {
    "id": "usr_...",
    "email": "trader@example.com",
    "display_name": "Example trader",
    "role": "seller",
    "account_role": "user",
    "verified": false,
    "status": "Active"
  },
  "access_token": "opaque-random-session-token",
  "token_type": "Bearer",
  "expires_at": "2026-10-24T12:00:00.000Z"
}
```

Send `Authorization: Bearer <access_token>` to account, listing, inquiry, and admin
endpoints. Tokens are opaque, not JWTs, and are never accepted in URLs. Only their
SHA-256 digests are stored. Passwords use salted, versioned scrypt hashes; new
passwords require at least 12 characters and are capped at 1024 UTF-8 bytes. Email
addresses are normalized to lowercase. Trader roles are `buyer`, `seller`, or
`both`; registration defaults to `both` and creates an active, unverified trader.
Business verification remains an administrator operation.

Logout revokes the current token. Password changes revoke every token, requiring a
fresh login. Each request reads the current account role and trader status, so
suspended traders cannot use existing sessions. Registration, login, and password
changes share a persistent limit of 30 attempts per client IP per 15 minutes,
including invalid input. Each process also caps concurrent password derivations at
two; temporary capacity exhaustion returns 503 with `Retry-After: 1`. The API does
not trust forwarded IP headers by default: behind a proxy, clients share its IP
budget until a trusted-proxy policy is configured for that deployment. Expired
sessions and rate-limit rows are cleaned hourly.

Create an account normally, then grant the first administrator role through an
operator-controlled database connection:

```sql
UPDATE accounts SET account_role = 'admin', updated_at = now()
WHERE email = 'your-admin@example.com';
```

Use HTTPS outside local development. The existing frontend login and dashboard
still use demo sessions; these backend endpoints are ready for frontend wiring.
Email verification and forgotten-password delivery are not implemented yet.
