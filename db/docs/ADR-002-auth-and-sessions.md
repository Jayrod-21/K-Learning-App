# ADR-002: Authentication and session strategy

**Status:** Accepted
**Date:** 2026-05-28
**Owners:** Core schema (A1)
**Supersedes:** Supabase Auth (which owned `auth.users` and JWT sessions in the prior schema)
**Depends on:** ADR-001 (foundation)

## Context

We moved off Supabase (2026-05-27). Supabase Auth provided `auth.users`, JWT
session tokens, RLS row-scoping via `auth.uid()`, and email verification. With
self-hosted Postgres, we own all of that.

Today the app has a single human user (Jared). Tomorrow it may not — the design
needs to assume one user without painting us into a corner if that changes.

## Decisions

### D1. Password hashing: **Argon2id**

- Argon2id won the Password Hashing Competition (2015) and is the OWASP
  recommendation as of the current cheat-sheet revision. It resists both GPU
  attacks (via memory hardness) and side-channel attacks (via the hybrid 'd'
  variant of the original Argon2).
- Concrete parameters chosen at the app layer, not the DB. Initial baseline:
  `memory=64 MiB, iterations=3, parallelism=1`. The DB column stores the full
  PHC-encoded string (`$argon2id$v=19$m=…$…`), so parameter upgrades are
  rotatable per-user on next login (the verifier reads the params off the hash).
- **Alternatives considered:**
  - **bcrypt** — Battle-tested but capped at 72 input bytes and not memory-hard.
    Acceptable, but argon2id is strictly better for new code in 2026.
  - **scrypt** — Memory-hard, well-understood, but the ecosystem moved on; argon2id
    is the modern default.
  - **PBKDF2** — Rejected. Not memory-hard; tunability via iterations alone is
    insufficient against modern hardware.
- **Trade-off:** Argon2id needs a native library (libsodium or argon2-cffi in
  Python). That's already in the dependency budget for the Express/Python app.

### D2. Session strategy: **server-side opaque tokens**, not stateless JWTs

- **Why:** Server-side sessions can be revoked in O(1) by deleting/marking the
  row. JWTs cannot — once issued they're valid until expiry unless you maintain
  a revocation list, at which point they're not stateless any more.
- **Token shape:** 32 random bytes from `os.urandom`/`crypto.randomBytes` (256-bit).
  Base64url-encoded for the cookie value (no padding, URL-safe, no escaping needed).
- **DB storage:** SHA-256 hex digest of the raw bytes, not the raw token. A DB
  compromise yields hashes, not active credentials. Lookup pattern:
  `SELECT … FROM sessions WHERE token_hash = encode(digest($raw_token, 'sha256'), 'hex')`.
- **Lifetime:** 30 days absolute (`expires_at = issued_at + interval '30 days'`).
  Idle timeout (`last_seen_at` older than 7 days) enforced at app layer.
- **Rotation:** A "remember me" extension issues a NEW row and a new cookie; the
  old row is revoked. We never mutate `expires_at` in place. This guarantees
  every cookie corresponds to a stable session identity.

### D3. Cookie attributes (locked)

| Attribute | Value | Why |
|---|---|---|
| `HttpOnly` | yes | JS can't read it → XSS can't exfiltrate the session. |
| `Secure` | yes | Cookie only sent over HTTPS. (Behind Cloudflare Tunnel + origin TLS.) |
| `SameSite` | `Strict` | No cross-site sends. Eliminates CSRF for state-changing requests. |
| `Path` | `/` | Single app, no need to scope. |
| `Domain` | (omitted) | Host-only cookie — narrower scope is safer. |
| Name | `km_sid` | Short, app-specific, not "session" (which hints at value). |

### D4. CSRF: SameSite=Strict is the primary defense

- With `SameSite=Strict`, browsers refuse to send the cookie on cross-site
  requests. That removes the classic CSRF vector for state-changing endpoints.
- Defense in depth: state-changing endpoints additionally require either the
  `Origin` header to match the app's known origin, or a double-submit token
  for the rare case a CDN strips `Origin`. (Implementation lives in the API
  layer; this ADR locks that the DB doesn't need a CSRF token table.)

### D5. RLS: skipped at the DB level; row scoping enforced at the app layer

- **Why:** RLS in single-user mode adds operational complexity (managing a
  per-request DB role) without buying meaningful isolation — there is only
  one principal. The single `application_name = 'korean-master-api'` role
  authenticates and gates queries via parameterized `WHERE user_id = $1`.
- **What changes if we go multi-user:** We add a per-request DB session
  variable (`SET LOCAL app.user_id = $1`) and a set of `USING (user_id = current_setting('app.user_id')::bigint)` RLS policies, OR keep app-layer scoping.
  The schema (every user-state table has `user_id NOT NULL` with an FK to
  `users.id`) is RLS-ready either way.

### D6. Email verification, MFA, rate-limited registration

The standing orders say "first three deploy priorities: email verification,
MFA, invite codes or rate-limited registration." This ADR locks the DB
contract for them:
- **Email verification:** `users.email_verified_at` is the source of truth.
  Verification tokens use the same `gen_random_bytes(32)`+SHA-256 pattern as
  sessions; they live in a future `email_verification_tokens` table (not in
  this migration — added when the API ships).
- **MFA:** Deferred until the multi-user trigger. When added, it'll be a
  `user_mfa_factors` table with TOTP secrets (encrypted) and recovery codes.
- **Rate-limited registration:** No DB schema needed beyond the unique-email
  constraint we already have; per-IP rate limiting happens in the API layer.

### D7. Audit log table: deferred

- ADR-001 D6 notes this is deferred. We'll add `auth_events` (login success,
  login failure, password change, MFA enrollment) when the app ships a
  login screen. For now, the structured app log is the audit trail.

## Consequences

- **Loaders:** Migration 002 (corpora) does NOT need an authenticated user;
  it runs as the migration role (no session needed).
- **API layer:** Every request loads the session by `token_hash`, joins to
  `users`, checks `expires_at > now() AND revoked_at IS NULL`, bumps
  `last_seen_at`. Single index hit (`ix_sessions_active_lookup`) on the hot path.
- **Logging:** Session tokens are NEVER logged. Hash-prefix only (`token_hash[0:8]`)
  for correlation across log lines.
- **Pen-test surface:** SQL injection on email lookup (parameterized only),
  credential stuffing (rate limit + lockout), session hijack (cookie attrs +
  IP/UA anomaly logging — not auth, just telemetry).

## Open questions

- Whether to add a CAPTCHA on login when failure-rate spikes. Deferred until
  we see real traffic.
- Whether to support "log out everywhere" — yes, easily: `UPDATE sessions SET revoked_at = now(), revoked_reason = 'user_global_logout' WHERE user_id = $1 AND revoked_at IS NULL`. No schema change needed.
