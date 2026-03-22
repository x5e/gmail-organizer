# Gmail Organizer MCP Connector

A remote [Model Context Protocol (MCP)](https://spec.modelcontextprotocol.io) server that gives Claude the ability to actively **organize a user's Gmail inbox** — applying and removing labels at the message, thread, and batch level.

Unlike Anthropic's official Gmail connector (read-only), this connector exposes write operations, making it possible to ask Claude to triage your inbox, label conversations by project or priority, archive handled threads, or bulk-relabel thousands of messages in a single operation.

> **Status:** Implementation complete. Two external review processes (Google OAuth verification + Anthropic directory submission) are required before it can be made available to the general public — see [Path to Public Availability](#path-to-public-availability) below.

---

## Table of Contents

- [What It Does](#what-it-does)
- [Tools Reference](#tools-reference)
- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Local Development](#local-development)
- [Running Tests](#running-tests)
- [Deployment](#deployment)
  - [Option A: PaaS (Railway / Render / Fly.io) — Recommended](#option-a-paas-railway--render--flyio--recommended)
  - [Option B: Google Cloud Run + Cloud SQL](#option-b-google-cloud-run--cloud-sql)
  - [Option C: AWS ECS Fargate + RDS](#option-c-aws-ecs-fargate--rds)
  - [Option D: AWS Lambda + API Gateway](#option-d-aws-lambda--api-gateway)
  - [Option E: VPS (DigitalOcean / Hetzner)](#option-e-vps-digitalocean--hetzner)
- [Google Cloud Project Setup](#google-cloud-project-setup)
- [Environment Variables](#environment-variables)
- [Connecting to Claude](#connecting-to-claude)
- [Path to Public Availability](#path-to-public-availability)
- [Security Design](#security-design)
- [Project Structure](#project-structure)
- [Technology Choices](#technology-choices)
- [License](#license)

---

## What It Does

### Capabilities added over the official Gmail connector

| Capability | Official connector | This connector |
|---|---|---|
| Read messages and threads | ✅ | ✅ |
| Search messages | ✅ | ✅ |
| List labels | ✅ | ✅ |
| Create draft replies | ✅ | ❌ (out of scope) |
| **Apply / remove labels on messages** | ❌ | ✅ |
| **Apply / remove labels on entire threads** | ❌ | ✅ |
| **Batch label up to 1,000 messages at once** | ❌ | ✅ |
| **Incremental mailbox sync via history API** | ❌ | ✅ |

### What is deliberately excluded

The connector uses the `gmail.modify` OAuth scope but intentionally does **not** expose:

- Sending or drafting email
- Trashing, deleting, or permanently removing messages
- Creating, renaming, or deleting label definitions
- Importing or injecting messages into the mailbox

`TRASH` and `SPAM` label IDs are blocked server-side on all write operations, preventing soft-deletion via label manipulation even if Claude were instructed to attempt it.

---

## Tools Reference

### Read-only tools (`readOnlyHint: true`)

| Tool | Description |
|---|---|
| `list_labels` | List all labels (system + user-created). Required before any labeling operation — callers need label IDs, not names. |
| `search_messages` | Search messages using Gmail's full query syntax (`from:`, `is:unread`, `label:`, etc.). Supports pagination. |
| `list_threads` | List conversation threads, optionally filtered by query or label ID. Operates natively at the conversation level. |
| `get_message` | Retrieve a single message with decoded body, headers, attachment metadata, and current label state. Supports `full`, `metadata`, and `minimal` format modes. |
| `get_attachment` | Retrieve the content of a specific attachment by ID. Automatically truncates large attachments (configurable `maxBytes`). |
| `get_thread` | Retrieve all messages in a conversation thread, including label state for each message. |
| `get_history` | Return mailbox changes (messages added, labels applied/removed) since a given `historyId`. Enables efficient incremental sync. |
| `get_profile` | Return account email address, total message count, and current `historyId`. A useful starting point for change tracking. |

### Write tools (`destructiveHint: false`)

| Tool | Description |
|---|---|
| `modify_message_labels` | Add and/or remove labels on a single message. Validates all label IDs before submitting to Google. |
| `modify_thread_labels` | Add and/or remove labels on every message in a thread simultaneously. |
| `batch_modify_message_labels` | Add and/or remove labels on up to 1,000 messages in one request. Ideal for bulk inbox operations. |

All write tools:
- Block `TRASH` and `SPAM` label IDs
- Validate that all submitted label IDs exist in the user's account before calling Google's API
- Return the updated resource (or a confirmation with affected count) on success

---

## Architecture Overview

```
Claude (claude.ai)
        │
        │  POST /mcp  (Streamable HTTP, Bearer token = user UUID)
        ▼
┌─────────────────────────────────────────────────────────┐
│                  Fastify HTTP Server                     │
│                                                         │
│  POST /mcp              ─► MCP SDK (stateless mode)     │
│  GET  /oauth/authorize  ─► PKCE authorization redirect  │
│  GET  /oauth/callback   ─► token exchange + storage     │
│  GET  /health           ─► load balancer health check   │
│                                                         │
│  Per-request flow:                                      │
│    1. Extract user ID from Bearer token                  │
│    2. Look up encrypted refresh token in PostgreSQL      │
│    3. Decrypt + refresh access token if needed          │
│    4. Call Gmail REST API                               │
│    5. Return structured result to Claude                 │
└─────────────────────────────────────────────────────────┘
        │                          │
        ▼                          ▼
  PostgreSQL                 Gmail API
  (users, oauth_tokens,      (googleapis.com)
   oauth_state tables)
```

**Key design decisions:**

- **Stateless MCP transport** — each POST to `/mcp` is fully self-contained; no per-session in-memory state. This means horizontal scaling works without sticky sessions.
- **Encrypted tokens at rest** — refresh tokens are encrypted with AES-256-GCM before storage. The database never sees plaintext credentials.
- **Proactive token refresh** — access tokens are cached in the database and refreshed proactively 5 minutes before expiry, avoiding latency spikes and unnecessary round-trips to Google.
- **PKCE OAuth flow** — the state verifier never leaves the server, protecting against authorization code interception.

---

## Prerequisites

- **Node.js 20+**
- **Docker** (for the test PostgreSQL instance; not required for production if you have a database elsewhere)
- A **Google Cloud project** with the Gmail API enabled and OAuth credentials configured (see [Google Cloud Project Setup](#google-cloud-project-setup))

---

## Local Development

```bash
# 1. Clone the repository
git clone https://github.com/your-org/gmail-organizer.git
cd gmail-organizer

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Edit .env — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
# TOKEN_ENCRYPTION_KEY, DATABASE_URL, BASE_URL

# 4. Start the development server (auto-restarts on file changes)
npm run dev
```

The server will start on `http://localhost:3000` (or whatever `PORT` is set to).

**Generating a TOKEN_ENCRYPTION_KEY:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Running database migrations manually** (the server runs them automatically on startup, but you can also run them by hand):

```bash
npm run migrate
```

---

## Running Tests

Tests require Docker to be running (for the PostgreSQL test container). The `npm test` command starts the container automatically.

```bash
# Start the test database and run all tests (recommended)
npm test

# Run tests in watch mode (development)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

**What the tests cover:**

- All 11 MCP tool handlers — correct request construction, response transformation, error handling per error code
- Token encryption/decryption — tamper detection, nonce uniqueness, round-trip correctness
- Access token refresh logic — proactive refresh, post-401 retry, caching behavior
- Label validation — `TRASH`/`SPAM` blocking, label existence checking
- MIME body decoding — base64url decode of message bodies and attachments
- Input validation — Zod schema enforcement for all tool inputs
- Full OAuth flow — authorization redirect → callback → token storage → retrieval
- Database schema integrity — migrations apply cleanly to a fresh database
- PKCE code verifier round-trip

Tests use [MSW (Mock Service Worker)](https://mswjs.io) to intercept all outbound HTTP calls (Gmail API + Google OAuth token endpoint) at the network layer, so no live credentials are needed.

**Test database configuration** (from `docker-compose.yml`):

| Setting | Value |
|---|---|
| Host | `localhost:5433` |
| Database | `gmail_organizer_test` |
| Username | `test` |
| Password | `test` |

---

## Deployment

The server is a standard Node.js HTTP application with a PostgreSQL database. It has no cloud-provider-specific dependencies and can be deployed anywhere. Below are step-by-step instructions for the five most common approaches.

### Option A: PaaS (Railway / Render / Fly.io) — Recommended

**Best for:** Getting live quickly with minimal infrastructure work. Automatic TLS, GitHub-triggered deploys, managed PostgreSQL. Costs $35–65/month at 75k users.

**Using Railway as an example:**

1. Create a [Railway](https://railway.app) account and connect your GitHub repository.
2. Create a new project → "Deploy from GitHub repo" → select this repository. Railway detects Node.js automatically.
3. Add a PostgreSQL database: "New" → "Database" → "PostgreSQL". Railway automatically injects `DATABASE_URL`.
4. Set environment variables in the Railway dashboard (Variables tab):
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `TOKEN_ENCRYPTION_KEY` (generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)
   - `BASE_URL` → your Railway app URL (e.g. `https://gmail-organizer.up.railway.app`)
5. Railway gives you a public URL automatically. Register it as an authorized redirect URI in Google Cloud Console:
   `https://your-app.up.railway.app/oauth/callback`
6. Push a commit — Railway builds and deploys automatically.
7. Verify: `curl https://your-app.up.railway.app/health`

**Start command** (set in Railway's "Start command" field):

```bash
npm run build && npm start
```

---

### Option B: Google Cloud Run + Cloud SQL

**Best for:** Pay-per-request pricing with no idle cost; same network as the Gmail API means low-latency calls. Costs $50–55/month at 75k users.

1. Install the [gcloud CLI](https://cloud.google.com/sdk/docs/install) and authenticate.
2. Enable APIs: `gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com`
3. Create a `Dockerfile` in the project root:

   ```dockerfile
   FROM node:20-alpine
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --omit=dev
   COPY . .
   RUN npm run build
   EXPOSE 8080
   ENV PORT=8080
   CMD ["npm", "start"]
   ```

4. Build and push the container:

   ```bash
   gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/gmail-mcp-server
   ```

5. Create a Cloud SQL PostgreSQL instance (smallest tier is sufficient: `db-g1-small`).
6. Store secrets in Secret Manager:

   ```bash
   echo -n "your-client-id" | gcloud secrets create GOOGLE_CLIENT_ID --data-file=-
   # Repeat for GOOGLE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY
   ```

7. Deploy to Cloud Run:

   ```bash
   gcloud run deploy gmail-mcp-server \
     --image gcr.io/YOUR_PROJECT_ID/gmail-mcp-server \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --add-cloudsql-instances YOUR_PROJECT:REGION:INSTANCE \
     --set-secrets GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,...
   ```

8. Get the service URL and register it as a Google OAuth redirect URI:
   `https://YOUR-SERVICE-URL/oauth/callback`

> **Tip:** Set `--min-instances 1` to eliminate cold starts on OAuth flows.

---

### Option C: AWS ECS Fargate + RDS

**Best for:** Teams already on AWS, or projects that need mature enterprise tooling. Costs $68–75/month at 75k users.

1. Create an ECR repository and push a Docker image (same `Dockerfile` as Option B).
2. Create an RDS PostgreSQL instance (`db.t3.micro` is sufficient) in a VPC with security groups that allow inbound 5432 only from the ECS security group.
3. Store secrets in AWS Secrets Manager: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`.
4. Create an ECS cluster (Fargate), task definition (0.5 vCPU / 1 GB RAM), and service (desired count: 2 for redundancy).
5. Create an Application Load Balancer with an HTTPS listener (free TLS cert from AWS Certificate Manager).
6. Point a custom domain's CNAME to the ALB DNS name.
7. Register `https://your-domain.com/oauth/callback` in Google Cloud Console.

See [`HOSTING_OPTIONS.md`](HOSTING_OPTIONS.md) for the full step-by-step walkthrough.

---

### Option D: AWS Lambda + API Gateway

**Best for:** Lowest cost at scale if you're already comfortable with Lambda. Costs $29–35/month at 75k users. Note: cold starts can cause delays on OAuth flows.

Wrap the Fastify app using [`@fastify/aws-lambda`](https://github.com/fastify/aws-lambda-fastify), deploy with the AWS SAM CLI, and use DynamoDB instead of PostgreSQL for token storage (or keep RDS and connect via Lambda VPC config).

See [`HOSTING_OPTIONS.md`](HOSTING_OPTIONS.md) for details.

---

### Option E: VPS (DigitalOcean / Hetzner)

**Best for:** Absolute lowest monthly cost; full control. Costs $24–39/month at 75k users on DigitalOcean, roughly $20–24 on Hetzner.

1. Provision an Ubuntu 22.04 VPS (2 vCPU / 4 GB RAM is comfortable headroom).
2. Install Node.js 20 and PostgreSQL (or use a managed database add-on).
3. Clone the repo, `npm install`, `npm run build`, configure `.env`.
4. Use [PM2](https://pm2.keymetrics.io) to keep the process running:

   ```bash
   npm install -g pm2
   pm2 start dist/server.js --name gmail-mcp
   pm2 save && pm2 startup
   ```

5. Install nginx as a reverse proxy and use [Certbot](https://certbot.eff.org) for a free TLS certificate:

   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d your-domain.com
   ```

6. Point your domain to the server IP and register the callback URL in Google Cloud Console.

See [`HOSTING_OPTIONS.md`](HOSTING_OPTIONS.md) for the full walkthrough.

---

## Google Cloud Project Setup

These steps are required before you can run the connector with real Google accounts.

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create a new project.

2. Enable the Gmail API:
   - Navigate to **APIs & Services → Library**
   - Search for "Gmail API" and click **Enable**

3. Configure the OAuth consent screen:
   - Go to **APIs & Services → OAuth consent screen**
   - Choose **External** (for personal testing; see below for production)
   - Fill in app name, support email, and developer contact
   - Add the scope: `https://www.googleapis.com/auth/gmail.modify`
   - Add your own Google account as a **Test user**

4. Create OAuth credentials:
   - Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Add an authorized redirect URI: `https://your-domain.com/oauth/callback`
     (for local dev: `http://localhost:3000/oauth/callback`)
   - Copy the **Client ID** and **Client Secret** into your `.env` file

> **Testing mode:** While the consent screen is in **Testing** status, the connector works fully for up to 100 test users you add manually. No Google review is needed for personal use or development.

> **Production mode:** To allow any Google user to connect, you must complete [Google's OAuth verification process](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) for the `gmail.modify` restricted scope. This takes 2–6 weeks and requires a CASA security assessment. See [Path to Public Availability](#path-to-public-availability) for the full timeline.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | ✅ | OAuth client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | ✅ | OAuth client secret |
| `TOKEN_ENCRYPTION_KEY` | ✅ | 32-byte AES-256-GCM key, base64-encoded. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `DATABASE_URL` | ✅ | PostgreSQL connection string, e.g. `postgres://user:pass@host:5432/dbname` |
| `BASE_URL` | ✅ | Public HTTPS URL of this server, e.g. `https://your-domain.com` (no trailing slash). Used to construct the OAuth callback URL. |
| `PORT` | — | HTTP port to listen on (default: `3000`) |
| `LOG_LEVEL` | — | Pino log level: `trace`, `debug`, `info`, `warn`, `error` (default: `info`) |
| `ALLOWED_ORIGIN` | — | CORS allowed origin (default: `*`; in production, set to Claude's domain) |

**Never commit real secrets to source control.** For production, use a secrets manager (Google Secret Manager, AWS Secrets Manager, Doppler, etc.) rather than `.env` files.

---

## Connecting to Claude

Once your server is deployed and a Google Cloud project is configured:

1. In Claude (claude.ai or the desktop app), go to **Settings → Connectors**.
2. Click **Add connector** and select **Custom connector**.
3. Enter your server's MCP URL: `https://your-domain.com/mcp`
4. Claude will initiate the OAuth flow — you'll be redirected to Google to grant access.
5. After authorizing, Claude will have access to all 11 Gmail tools.

**Example prompts you can use after connecting:**

- *"Label all unread newsletters in my inbox with the 'Newsletter' label."*
- *"Show me threads from the last week where I was directly addressed but haven't replied."*
- *"Archive everything from noreply@github.com older than 30 days."*
- *"What's changed in my inbox since yesterday? Use the history API."*

---

## Path to Public Availability

Being listed in Anthropic's Connectors Directory (one-click install for all Claude users) requires two independent review processes:

### 1. Google OAuth App Verification

Because `gmail.modify` is a [restricted scope](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), Google requires:

- **Brand verification** (2–3 business days): Verify domain ownership; configure consent screen with app name, logo, and privacy policy URL.
- **Restricted scope review** (2–6 weeks): Submit a justification for requesting `gmail.modify`. Google reviews whether the use case qualifies.
- **CASA security assessment** (2–4 weeks): Required for all apps handling restricted scopes that can access data through a third-party server. Conducted by an [authorized assessment lab](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification#assessment-labs). Cost: ~$500–$4,500/year depending on tier.

Until this process is complete, the connector works for up to 100 manually-added test users.

### 2. Anthropic Connectors Directory Submission

To be listed in Claude's built-in connector browser:

- The server must be publicly hosted at a stable HTTPS URL.
- All tools must include `readOnlyHint` or `destructiveHint` annotations (already done).
- The server must comply with [Anthropic's MCP Directory Policy](https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq).
- Submit via Anthropic's connector directory review form.

The two reviews are independent and can be pursued in parallel.

**Estimated total timeline from code-complete to public availability: 2–3 months**, primarily driven by Google's review processes.

| Phase | Estimated Duration |
|---|---|
| Google brand verification | 2–3 business days |
| Google restricted scope review | 2–6 weeks |
| CASA security assessment | 2–4 weeks |
| Anthropic directory review | Variable |

---

## Security Design

**Token encryption:** OAuth refresh tokens are encrypted with AES-256-GCM before being written to PostgreSQL. Each encryption uses a freshly generated 12-byte nonce; the stored value is `nonce || ciphertext || auth_tag`. The database never sees plaintext token values. A database credential leak alone is insufficient to recover user tokens.

**PKCE OAuth flow:** The code verifier is generated server-side, stored in the `oauth_state` table, and never transmitted to the client. Only the SHA-256 challenge is sent to Google. This prevents authorization code interception attacks.

**TRASH/SPAM blocking:** All write tools reject label IDs `TRASH` and `SPAM`, regardless of how the request is formed. This prevents prompt injection attacks where malicious email content might attempt to instruct Claude to move messages to the trash.

**Label existence validation:** All write tools validate that the submitted label IDs exist in the user's account before sending any mutation to Google. This prevents silent failures and reduces the impact of hallucinated label IDs.

**Per-user token isolation:** Each user's token is stored and retrieved by UUID; there is no mechanism by which one user's token can be used to access another user's data.

**Secrets never logged:** The Pino logger is configured to redact `Authorization` headers, `access_token`, `refresh_token`, and `encrypted_refresh_token` fields at all log levels.

**Rate limiting:** The `/mcp` endpoint enforces a per-user rate limit (100 requests/minute, keyed on the bearer token) using `@fastify/rate-limit`.

---

## Project Structure

```
.
├── src/
│   ├── server.ts                  # Fastify app builder + entry point
│   ├── config.ts                  # Environment variable loading/validation
│   ├── mcp.ts                     # MCP server + StreamableHTTP handler
│   ├── crypto.ts                  # AES-256-GCM encrypt/decrypt
│   ├── db/
│   │   ├── index.ts               # postgres.js connection pool
│   │   ├── migrate.ts             # SQL migration runner
│   │   ├── users.ts               # users + oauth_tokens DB operations
│   │   └── oauth-state.ts         # oauth_state DB operations
│   ├── gmail/
│   │   └── client.ts              # Gmail REST API wrapper (all 11 endpoints)
│   ├── oauth/
│   │   ├── handlers.ts            # /oauth/authorize + /oauth/callback routes
│   │   └── tokens.ts              # Token exchange, refresh, caching
│   ├── tools/
│   │   ├── index.ts               # All 11 MCP tools registered here
│   │   └── validation.ts          # TRASH/SPAM blocking + label existence check
│   ├── mocks/
│   │   ├── handlers/              # MSW mock handlers (Gmail API + OAuth)
│   │   │   ├── gmail-labels.ts
│   │   │   ├── gmail-messages.ts
│   │   │   ├── gmail-threads.ts
│   │   │   ├── gmail-profile.ts
│   │   │   ├── gmail-history.ts
│   │   │   └── google-oauth.ts
│   │   └── server.ts              # MSW Node server setup
│   └── test/
│       ├── global-setup.ts        # Vitest global setup (runs migrations)
│       ├── setup.ts               # Per-test setup (starts/resets MSW)
│       └── db-helpers.ts          # Test database helpers
├── migrations/
│   └── 001_initial.sql            # Database schema
├── docker-compose.yml             # PostgreSQL test container (port 5433)
├── .env.example                   # Environment variable template
├── tsconfig.json
├── vitest.config.ts
└── package.json
```

**Test files** live alongside source files:

- `src/crypto.test.ts` — encryption unit tests
- `src/db/migrate.integration.test.ts` — migration integration tests
- `src/db/oauth-state.test.ts` — OAuth state DB tests
- `src/gmail/client.test.ts` — Gmail client unit tests
- `src/oauth/handlers.integration.test.ts` — OAuth flow integration tests
- `src/oauth/tokens.test.ts` — Token refresh logic tests
- `src/tools/tools.integration.test.ts` — End-to-end tool handler tests
- `src/tools/validation.test.ts` — Label validation unit tests

---

## Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict mode) | Best MCP SDK support; type safety for credential handling |
| MCP SDK | `@modelcontextprotocol/sdk` (official) | Stability; required for Anthropic directory submission |
| MCP transport | Streamable HTTP, stateless | Current standard; trivially horizontally scalable |
| HTTP framework | Fastify | Performance; TypeScript support; native Pino integration |
| Rate limiting | `@fastify/rate-limit` | Per-user abuse prevention + Google API quota protection |
| Database | PostgreSQL | Durable, transactional token storage |
| DB client | `postgres` (postgres.js v3) | Plain SQL; no ORM abstraction; built-in pooling |
| Token encryption | AES-256-GCM, Node `crypto` | Plaintext never reaches the database; no 3rd-party crypto library |
| OAuth flow | Authorization Code + PKCE | Required by spec; protects against code interception |
| Input validation | Zod | Native to MCP SDK tool definitions; runtime validation + type inference |
| Logging | Pino (structured JSON) | Native to Fastify; fastest Node logger; compatible with all log platforms |
| Test framework | Vitest | Native TypeScript; fast; Jest-compatible API; first-class ESM support |
| HTTP mocking | MSW | Network-level interception; exercises the full request path |
| DB in tests | Real Postgres via Docker Compose | No mock drift; reproducible on any developer machine |

For the full rationale behind each decision, see [`TECH_CHOICES.md`](TECH_CHOICES.md).

For the complete technical specification, see [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md).

For the project overview and context, see [`OVERVIEW.md`](OVERVIEW.md).

For a detailed cost analysis of all hosting options, see [`HOSTING_OPTIONS.md`](HOSTING_OPTIONS.md).

---

## License

[MIT](LICENSE)
