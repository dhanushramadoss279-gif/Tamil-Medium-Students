# TMS Academy authentication and premium access

This project remains the existing static HTML academy, served by an Express application so HTML lessons cannot be fetched directly without an active subscription. Google OAuth sessions, user data, payments, and subscriptions are handled on the server. The application is not Next.js, so it uses Passport Google OAuth rather than Auth.js.

## Project additions

```text
api/
  index.js                         Vercel Express entry point
  speak.js                         Existing AI endpoint, now routed through access checks
lib/
  config.js                        Required configuration validation
  database.js                      Prisma and PostgreSQL connection pools
  payments.js                      Orders, capture verification, and webhook processing
  passport.js                      Google OAuth user creation and persistent login
  security.js                      Payment/webhook HMAC and same-origin checks
  subscriptions.js                 Expiry and calendar-month access rules
middleware/
  require-active-subscription.js   Authentication and premium route guards
prisma/
  schema.prisma                    User, subscription, payment, and learning history tables
  migrations/                      PostgreSQL migrations
public/
  auth-ui.js                       Profile, membership status, and logout bar
  tms-design.css                   Shared responsive and dark-mode design tokens
  tms-navigation.js                Shared responsive navigation and account-aware homepage
  profile.js                       Profile, subscription status, and recent lesson history
  subscribe.js                     Razorpay Checkout browser flow
data/lessons/                      Structured content snapshots for twelve tense pilot lessons
templates/lesson-template.js       Shared renderer for the structured pilot lessons
scripts/import-tense-pilot.js      Rebuilds tense pilot snapshots from original HTML files
routes/
  payment-routes.js                Server-side create-order and verify endpoints
test/
  access-control.test.js           Login and protected API access tests
  google-oauth-state.test.js       OAuth session-state and PKCE validation tests
  payment-validation.test.js       Ownership, amount, currency, capture, and idempotency tests
  security.test.js                 Calendar expiry and signature tests
views/
  login.html                       Google sign-in page
  profile.html                     Account and membership status
  subscribe.html                   ₹49/month payment and renewal page
  payment-success.html             Verified-payment success page
app.js                             Express routes and protected HTML delivery
server.js                          Local Node server entry point
vercel.json                        Vercel function files and request rewrites
.env.example                        Safe environment variable placeholders
```

The existing lesson and course HTML files remain unchanged and protected by the server. The homepage (`/` and `/index.html`) is publicly viewable, but its lesson links still require sign-in and an active membership. `/dashboard`, `/courses`, `/courses/:slug`, and the protected `.html` lesson routes are subscription-checked before HTML is sent. The server does not expose the project root as a static directory.

The shared UI is layered onto existing HTML pages using `public/tms-design.css` and `public/tms-navigation.js`; course content and quiz logic remain intact. The homepage reads the account/subscription endpoint to show login, renewal, or active membership states. The shared header, mobile navigation, and footer are rendered from one server/client implementation. The monthly price is set once as `SUBSCRIPTION_AMOUNT_PAISE` (default `4900`, or ₹49) and the backend sends it to the payment screen; the frontend cannot change the charged amount.

For active subscribers, opening a lesson records the real visit in `UserProgress`. The profile page displays recently opened lessons, not fabricated completion percentages. Existing pages do not yet report lesson completion, XP, streaks, or quiz scores, so these are not displayed or inferred. The additions preserve the existing individual HTML URLs; the project has not been bulk-converted to a new framework or had lesson content migrated out of those files.

The lesson-template migration is incremental and currently covers twelve tense lessons: simple present, simple past, simple future, present continuous, past continuous, future continuous, present perfect, past perfect, future perfect, present perfect continuous, past perfect continuous, and future perfect continuous. Their structured snapshots under `data/lessons/` preserve the original lesson body, styles, and interactive quiz scripts; original `.html` files remain in place as the source baseline. Runtime serves these twelve lessons through `templates/lesson-template.js` at their existing `.html` URLs and `/courses/:slug`. To refresh the snapshots after intentionally editing a pilot source page, run `node scripts/import-tense-pilot.js`. Other lessons continue to be served from their original HTML files; this is not a bulk migration.

## Database

The PostgreSQL schema is in `prisma/schema.prisma`. The User model stores the Google provider and creation/update timestamps. The additive migration `20260927111500_user_identity_metadata` backfills these fields without deleting or replacing existing users. Session rows use the PostgreSQL-backed `connect-pg-simple` store (`user_sessions`); its configured `createTableIfMissing` option creates the session table when the app first connects.

The schema includes:

- `User`: Google ID, provider, profile, email, and creation/update times.
- `Subscription`: status, Razorpay order/payment IDs, amount in paise, start, expiry, and creation time.
- `Payment`: order and payment IDs, payment status, amount, currency, and captured date.
- `UserProgress`: actual lesson visits and timestamps for the signed-in user.
- `RazorpayWebhookEvent`: event IDs for replay/idempotency protection.

Subscriber and payment data can be queried from the database without adding a user-facing admin route. For example:

```sql
SELECT COUNT(*) AS total_users FROM "User";
SELECT COUNT(*) AS active_subscribers
FROM "Subscription"
WHERE status = 'ACTIVE' AND "expiryDate" > NOW();
SELECT COUNT(*) AS expired_subscriptions
FROM "Subscription"
WHERE status = 'EXPIRED';
SELECT p.amount, p.currency, p."capturedAt", p."userId", s."expiryDate"
FROM "Payment" p
JOIN "Subscription" s ON s.id = p."subscriptionId";
```

The amount is stored as integer paise (`4900` = ₹49). `Payment.capturedAt` is the payment date; `Subscription.startDate` and `expiryDate` are the access period.

## Configure Google OAuth

1. In Google Cloud Console, create/select a project and configure the OAuth consent screen.
2. Create an OAuth client with application type **Web application**.
3. Add your site origin to **Authorized JavaScript origins** (for local development: `http://localhost:3000`).
4. Add this exact callback to **Authorized redirect URIs**:
   - Local: `http://localhost:3000/auth/google/callback`
   - Production: `https://YOUR_DOMAIN/auth/google/callback`
5. Put the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Keep the client secret out of all browser code and source control.

Google must return a verified email. That identity is upserted into `User`; sessions contain only the user ID and are stored in PostgreSQL.
The OAuth flow uses a random session-bound `state` value and S256 PKCE. A callback without the initiating browser session, with a mismatched state, or with a replayed state is rejected before its authorization code is exchanged.
`NEXTAUTH_URL` is not used because this static HTML project is not Next.js; `APP_URL` is the canonical callback and same-origin URL.

## Configure Razorpay

1. Activate a Razorpay merchant account and obtain its API **Key ID** and **Key Secret**. Use test-mode values locally.
2. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` on the server. The key ID is returned to Checkout; the secret is never returned to the browser.
3. In Razorpay Webhooks, set the endpoint to `https://YOUR_DOMAIN/api/webhooks/razorpay` and configure a webhook secret in `RAZORPAY_WEBHOOK_SECRET`.
4. Subscribe to `payment.captured` and `payment.failed`. The captured event synchronizes successful payments; failed events mark an unpaid order failed so the next attempt receives a fresh order.
5. Use a Razorpay **Order** for each ₹49 single-payment month. This is intentionally not a recurring auto-debit Razorpay Subscription: users pay again after expiry. The server reuses a pending order on retry and prevents order creation while access is active.

The browser creates neither orders nor entitlements. It requests an order from the signed-in server, opens Razorpay Checkout, then posts the Checkout response to `/api/payments/verify`. The server verifies the HMAC signature, checks the order belongs to that user, fetches the payment from Razorpay, checks order/amount/currency, captures an authorized payment if needed, and only then writes an active subscription. The webhook independently verifies the HMAC against the exact raw request body and processes captured payments idempotently. Webhook and checkout races cannot grant two months for one payment.

## Run locally

Requirements: Node.js 20+, PostgreSQL, and Google/Razorpay credentials.

```powershell
npm install
Copy-Item .env.example .env.local
```

Replace the placeholders in `.env.local` with actual configuration. `.env.example` is safe to commit; `.env.local` is ignored. Generate `AUTH_SECRET` with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Set `DATABASE_URL` to your local PostgreSQL database and run:

```powershell
npx prisma migrate deploy
npm start
```

The app listens at `http://localhost:3000`. For active development, use `npm run dev`. Set the Razorpay webhook URL to a public HTTPS tunnel while testing webhooks locally. Run `npm test` for OAuth state/PKCE, access-control, payment validation, calendar-expiry, and signature tests.

## Deploy to Vercel

1. Push the project to a private or public Git repository and import it into Vercel. Keep the project root set to this folder; do not configure it as a static-only deployment.
2. Provision managed PostgreSQL (for example, Neon or Supabase), then run `npx prisma migrate deploy` from a trusted machine with the production `DATABASE_URL`. Do not print or commit that URL.
3. Add every variable from `.env.example` to Vercel **Project Settings → Environment Variables**, with production values. Set `APP_URL` to the canonical HTTPS domain and use `NODE_ENV=production`.
4. Configure the Google production callback and Razorpay webhook URL for that same domain.
5. Deploy and test login, direct lesson URL denial, test payment verification, renewal, and expiry before switching Razorpay to live keys.

`vercel.json` routes all page and API requests through the Express function and includes the original HTML files in its bundle. This is essential: deploying the current HTML as public static assets would bypass access checks. Keep the Vercel catch-all rewrite and function file inclusion enabled. `robots.txt` and `sitemap.xml` expose only the public homepage; member/course routes are marked `noindex`.

## Access and expiry rules

`requireAuthenticatedUser` and the reusable `requireActiveSubscription()` middleware guard protected handlers. The root/dashboard, `/courses`, `/courses/:slug`, and every existing `.html` route use server-side subscription checks. Unauthenticated users are redirected to `/login`; signed-in users without active access are redirected to `/subscribe`. The same logic is applied before sending HTML, not just in browser JavaScript.

`expiryDate` is calculated as one UTC calendar month after verified payment, clamping month-end dates (for example January 31 to February 28/29). On each protected-page check and account-status request, subscriptions at or past expiry are changed to `EXPIRED` and denied. A new payment creates a new one-month term beginning when Razorpay confirms capture. The Razorpay webhook events used for Orders do not include a subscription-expired event; expiry is determined from this stored date.

## Production security checklist

- Use HTTPS and set `APP_URL` to the canonical HTTPS origin.
- Store all OAuth, Razorpay, database, and session secrets in the hosting provider's secret environment settings.
- Never commit `.env.local`; `.gitignore` excludes it.
- Use live Razorpay credentials only after test-mode end-to-end verification.
- Configure and verify the Razorpay webhook secret and required events.
- Keep PostgreSQL backups, restrict database network access, and run `prisma migrate deploy` as a deployment step.
- Do not add public static hosting of the root HTML files or remove the server-side page guard.
- Keep dependency updates and `npm audit` in the release review; session storage must remain PostgreSQL-backed in production.
