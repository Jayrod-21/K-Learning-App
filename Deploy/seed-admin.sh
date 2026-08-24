#!/usr/bin/env bash
# =============================================================================
# Korean Master — seed-admin.sh
# -----------------------------------------------------------------------------
# Provision the operator account WITH ADMIN PRIVILEGES (Phase 2.2 admin-role
# foundation). Runs the compiled seed-user CLI INSIDE the active color's server
# container, which already holds DATABASE_URL + full config on km-internal (km-db
# is not published to the host, by design), with SEED_USER_ROLE=admin so the
# account this script creates actually GRANTS admin (users.role='admin',
# migration 095) — not just a name implying it.
#
# SECURITY (SENIOR_ENGINEER_BAR §3.6): the password is read with `read -s` (never
# echoed) and passed to the container over STDIN — it never appears in argv, the
# host/container process list, this terminal's scrollback, or any log. seed-user
# itself Argon2id-hashes it and never logs it. The account is created WITHOUT a
# TOTP factor; because MFA_REQUIRED=true, the FIRST login forces TOTP enrollment.
#
# Run this in YOUR OWN interactive terminal (it prompts):
#     bash Deploy/seed-admin.sh
# Idempotent, but NOT a no-op on re-run: re-running against an email that
# already exists UPGRADES that account to admin if it wasn't already (see
# seed-user.ts header — SEED_USER_ROLE=admin always wins on conflict) and
# never rotates the password.
# =============================================================================
set -Eeuo pipefail
# shellcheck source=Deploy/deployment-utils.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/deployment-utils.sh"
trap _on_err ERR

main() {
    require_cmd docker
    load_environment
    local active="$ACTIVE_ENVIRONMENT"
    local container="km-server-${active}"

    if ! docker inspect -f '{{.State.Running}}' "$container" >/dev/null 2>&1; then
        log_err "seed-admin: ${container} is not running — stand the stack up first (Deploy/local-standup.sh)."
        return 1
    fi

    local email display
    read -rp "Admin email [jaredmwilliams.me@gmail.com]: " email
    email="${email:-jaredmwilliams.me@gmail.com}"
    read -rp "Display name (optional, blank = none): " display

    local pw pw2
    read -rsp "Password (min 12 chars): " pw; echo
    read -rsp "Confirm password: " pw2; echo
    if [[ "$pw" != "$pw2" ]]; then
        log_err "seed-admin: passwords do not match."
        return 1
    fi
    if [[ ${#pw} -lt 12 ]]; then
        log_err "seed-admin: password must be at least 12 characters."
        return 1
    fi

    log_info "seeding ADMIN account for ${email} into ${container} (password via stdin — never logged)"
    # Email/display are NOT secret → passed via -e. SEED_USER_ROLE=admin is what
    # actually grants privilege here (Phase 2.2) — without it seed-user.js seeds
    # an ordinary user, same as the plain seed-user.sh path. The password is
    # piped on STDIN and read into an env var set INSIDE the container, so it is
    # never on a command line. seed-user.js reads SEED_USER_* from its environment.
    printf '%s\n' "$pw" | docker exec -i \
        -e SEED_USER_EMAIL="$email" \
        -e SEED_USER_DISPLAY_NAME="$display" \
        -e SEED_USER_ROLE="admin" \
        "$container" \
        sh -c 'IFS= read -r __pw; SEED_USER_PASSWORD="$__pw" node dist/scripts/seed-user.js'
    # Drop the plaintext from this shell's memory as soon as it's been handed off.
    unset pw pw2

    log_info "seed-admin: done — ${email} has role=admin."
    log_info "Next: open the app, log in with this email + password, and complete the"
    log_info "forced TOTP enrollment (scan the QR into your authenticator, save the recovery codes)."
}

main "$@"
