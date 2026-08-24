# Operator account recovery (Phase 2.1)

Two independent recovery paths exist for a locked-out account. Which one
applies depends on what the user has lost.

## 1. Forgot password — self-service, no operator involved

A user who remembers their email but not their password uses the in-app
"Forgot password?" link on the sign-in screen (or navigates directly to
`/reset-password`). This drives:

- `POST /auth/password-reset/request` — emails a reset link to the account's
  verified address. The response is always the same generic 200 whether or
  not the email exists (no enumeration signal), and issuance is cooldown-
  gated (60s) so the endpoint can't be used to mail-bomb an inbox.
- `POST /auth/password-reset/confirm` — the emailed link (`/reset-password
  #token=…`) carries a single-use, 1-hour-expiring token. Submitting a new
  password consumes it, overwrites `users.password_hash`, and revokes EVERY
  live session for the account, all in one transaction. There is no
  auto-login — the user signs in fresh with the new password.

Token + threat-model details: `server/src/auth/passwordReset.ts`,
`db/migrations/094_password_reset_tokens.up.sql`.

**This path does NOT help if the account also requires MFA and the user has
lost their second factor** — password reset gets them past the password
check, but login still stops at the TOTP/recovery-code challenge. See below.

## 2. Both TOTP and recovery codes lost — operator required

If a user has lost their authenticator app AND their recovery codes, there is
no self-service path (mandatory MFA has no in-app "disable 2FA" — that would
be the takeover vector MFA exists to close). An **operator** must run the
`mfa-reset` CLI against the account:

```
cd server
MFA_RESET_EMAIL=user@example.com npm run mfa:reset
```

(or pass the email as the first CLI argument instead of the env var).

What it does (`server/src/scripts/mfa-reset.ts`), in one transaction:

1. Deletes the account's TOTP factor (`user_totp`).
2. Deletes all of the account's recovery codes (`user_recovery_codes`).
3. Revokes every live session for the account (`revokeAllUserSessions`,
   reason `mfa_reset`) — a reset is a security event, so any existing
   session (including one an attacker might be holding) dies too.

The user's next login falls into the normal forced-enrollment flow and
re-enrolls a fresh TOTP factor + recovery-code set, exactly as at first
sign-up.

**Verify the requester's identity out-of-band before running this** — the
CLI has no network auth of its own; shell + DB access to the host IS the
authorization boundary. Do not run it off an unauthenticated email request
alone (that would recreate the account-takeover-via-support-desk vector MFA
is meant to close).

### Decision summary

| Lost                                   | Path                                     |
| --------------------------------------- | ----------------------------------------- |
| Password only                           | Self-service: "Forgot password?" → `/reset-password` |
| TOTP device only (has recovery codes)   | Self-service: sign in, use a recovery code at the MFA challenge |
| TOTP device AND recovery codes          | Operator: `npm run mfa:reset` (see above) |
| Password AND TOTP AND recovery codes    | Self-service password reset first, then (still MFA-blocked) operator `mfa:reset` |
