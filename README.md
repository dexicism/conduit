# Conduit

A workflow automation platform I built to run on my own laptop for free. Drag steps onto a canvas, wire them up, hit publish. It handles the boring glue work: a Telegram bot that answers with AI, form answers that land in a Google Sheet, a chat page for a website, emails, calendar invites, scheduled jobs.

What's in it:

- **Visual editor:** 30-ish step types, a config panel generated from each step's schema, data references with a variable picker, undo/redo, copy/paste, sticky notes, auto-layout, auto-save with conflict handling.
- **Execution engine:** test runs with live output, webhook / schedule / manual / form / chat / error / sub-workflow triggers, publishing, run history, sandboxed Code steps (isolated-vm), SSRF-safe HTTP steps.
- **AI:** an Agent with tools and memory, Classify, Sentiment, Moderate and Extract steps, and a chat Builder that drafts workflows on the canvas. Runs on a free local model through Ollama, or on Claude if you have a key.
- **Apps:** Telegram, Gmail, Google Sheets, Google Calendar, Google Drive, Slack, WhatsApp Business, PostgreSQL and SMTP. Every app action also works as an agent tool. Accounts are stored encrypted.
- **Teams and billing:** workspaces with invites and roles, per-step credits, plans, Stripe subscriptions.
- **Platform:** API keys and a public REST API (`/api/v1`), signed outgoing webhooks, an MCP server with OAuth 2.1 so AI assistants can read and edit workflows, two-step sign-in.

## Quick start on Windows (one click)

Double-click **Start Conduit** (on the desktop, or `Start Conduit.cmd` in this folder). It starts the local AI (Ollama), the database and the app, loads the AI model, and opens http://localhost:3000. The first start takes about a minute. Two minimized "Conduit" windows stay open while it runs.

Double-click **Stop Conduit** to stop the app and the database cleanly. Ollama keeps running in the tray.

Telegram bots, schedules and other workflows run only while Conduit is running.

## Requirements

- Node.js 22.12+ (24.22+ recommended)
- No Docker needed. The dev database runs the official `mongod` binary, which downloads automatically on first run.

## Run locally

From the repo root, run each command in its own terminal:

```bash
npm install
npm run db        # MongoDB replica set on 127.0.0.1:27018 (keep running)
npm run dev       # http://localhost:3000
```

On first run, create `apps/web/.env.local` from [apps/web/.env.example](apps/web/.env.example). Only `BETTER_AUTH_SECRET` is required.

**Signing in without an email provider.** If `RESEND_API_KEY` and `SMTP_URL` are both unset, sign-in codes are written to a local outbox. Read it at <http://localhost:3000/dev/outbox>. The login screen links to it. This mode is refused in production.

**Workflow runs.**

- **In development:** the execution worker starts inside `npm run dev`, so nothing else needs to run.
- **In production:** run it separately with `MONGODB_URI=... npm start -w worker`, and as many copies as you need. Set `CONDUIT_WORKER=off` on the web servers.
- **Private addresses:** HTTP steps can't reach private or internal addresses unless `HTTP_ALLOW_PRIVATE_NETWORK=1`.

**AI.** Two real providers. Set one in `apps/web/.env.local`, and the same settings wherever the worker runs.

- **Free, on your own computer (Ollama):** install [Ollama](https://ollama.com), run `ollama pull qwen3:8b`, and set `AI_PROVIDER=ollama`.
  - Every AI step and the Builder use that one model (`OLLAMA_MODEL`), whatever model the step names.
  - It needs about 8 GB of free memory. It's slower than Claude and makes more mistakes building workflows.
  - Test runs of AI steps don't use credits, since a local model costs nothing to run. Live runs use credits as usual.
  - Other models that handle tools: `llama3.1:8b`, `qwen3:14b` (better, needs about 16 GB).
  - **Speed and quality (measured on an RTX 3050 laptop GPU with 4 GB, `qwen3:8b`):** a simple answer or tool call takes 4–8 s after the model loads (about 25 s the first time). Building a 3-step workflow with the AI Builder worked. A 4-step request took about 3.5 minutes and added only the first step, though the model's reply claimed all four. The Builder panel's change label lists the steps that were really added, so check it.
  - **Ollama crashes with a "CUDA error" on some NVIDIA laptop GPUs:** run `setx OLLAMA_LLM_LIBRARY cuda_v12`, quit Ollama from the system tray, and open it again from the Start menu.
  - **Check it yourself:** `npx tsx scripts/try-ollama.mts` (answers, tools, JSON output) and `npx tsx scripts/try-builder.mts "your request"` (the Builder).
- **Claude (paid per use):** set `ANTHROPIC_API_KEY`.
- **Without either:** AI steps and the Builder are hidden.
- **Local trial without a key:** `AI_PROVIDER=fake` turns on a rule-based test model, with no real intelligence. It's refused in production.
- **Model choice:** each AI step picks Claude Opus 5.5 (default), Sonnet 5.5 or Haiku 5.5.
- **Refusals:** on Opus and Sonnet, a request Claude declines is automatically retried on Anthropic's fallback model.

**Telegram on your own PC (free, no tunnel).** When the app's address is localhost, Telegram bots use polling: the worker asks Telegram for new messages every few seconds, so your PC doesn't need a public address. Publishing a workflow with a Telegram trigger removes any old webhook from the bot and skips messages sent before it went live. Set `TELEGRAM_MODE=webhook` or `TELEGRAM_MODE=polling` to choose. With several workers in polling mode, set `TELEGRAM_POLL=0` on all but one.

**Incoming hooks on your own PC (free).** Webhook and form triggers called from outside, and Telegram in webhook mode, need an address the internet can reach. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`winget install Cloudflare.cloudflared`) and run `cloudflared tunnel --url http://localhost:3000`. It prints an `https://….trycloudflare.com` address. Put it in `apps/web/.env.local` as `PUBLIC_URL=…` and restart the app.
- The address changes every time the tunnel restarts. In webhook mode, publish your Telegram workflows again after a change so Telegram learns the new address.
- While the tunnel runs, anyone with the address can reach your app's pages, and the sign-in page still protects your account. Close the tunnel when you're not using it.

**Connected apps.** Saved accounts are encrypted with `CONDUIT_ENCRYPTION_KEY`. It's required in production and must be the same on the web app and every worker. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Development creates one in `.data/encryption.key`.

- **Google (Gmail, Sheets):** set `CONNECT_GOOGLE_CLIENT_ID` and `CONNECT_GOOGLE_CLIENT_SECRET`, and add `{BETTER_AUTH_URL}/api/credentials/oauth/callback` as a redirect URI. Enable the Gmail and Sheets APIs in the Google Cloud project. Without these, Google steps are hidden.
- **Telegram triggers:** in webhook mode (the default when `PUBLIC_URL` isn't localhost), Telegram must be able to reach `PUBLIC_URL` over public HTTPS. Polling mode needs no public address.
- **Databases and SMTP:** private and internal addresses are blocked unless `HTTP_ALLOW_PRIVATE_NETWORK=1`.

**Billing (Stripe).** Set these to offer paid plans:
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO` and `STRIPE_PRICE_MAX` (monthly subscription price IDs)

Point a Stripe webhook at `{BETTER_AUTH_URL}/api/billing/webhook` with these events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.paid`. Without these settings, everyone stays on the Free plan and upgrade buttons are hidden.

**Google and GitHub sign-in.** Set the client ID and secret for either provider in `.env.local` and its button appears. Without them the button is hidden, so it is never a dead control.

## Tests

```bash
npm test                 # unit + integration tests (core, nodes, engine, runtime)
npm run typecheck        # all workspaces
npm run e2e              # Playwright, needs `npm run db` running; starts its own server on :3100
```

The E2E suite signs in through the real OTP flow, using a separate `conduit_e2e` database and outbox.

## Layout

```
apps/web        Next.js 16 app: marketing, auth, dashboard, REST API (/api/*)
packages/core   Shared zod schemas, graph validation, expression references, error codes
packages/nodes  Step definitions (fields, handles, examples), parameter + connection rules
packages/engine Pure workflow runner + step executors + cron (unit-tested, no I/O)
packages/runtime Job queue, worker, sandbox (isolated-vm), SSRF-safe HTTP, publish/triggers
apps/worker     Standalone production worker
scripts/        dev-db.mjs (local MongoDB)
docs/           Architecture, database schema, API
```
