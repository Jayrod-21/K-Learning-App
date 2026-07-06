# Review — F-020 "Ask about this" → seed Chat (core mechanism + security slice)

- **Commit:** `97eff80` — `feat(chat): 'Ask about this' — seed Chat from a reviewed item (F-020)`
- **Slice:** `client/src/lib/askSeed.ts` (+ test), `client/src/components/AskAboutThisButton.tsx` (+ test), `client/src/pages/Chat.tsx` (+ `Chat.test.tsx`)
- **Reviewer:** independent senior React review (did not author this change)
- **Test run:** `docker run … vitest run askSeed.test.ts AskAboutThisButton.test.tsx Chat.test.tsx` → **28/28 passed** (1.12s)

## Verdict: **APPROVE** — 0 BLOCKERS, 1 SHOULD-FIX, 5 NITs, 3 PRAISE

The three highest-risk properties the prompt design depends on were each probed and hold definitively:

1. **Untrusted router state — SOUND.** Every field is runtime-validated, the clamp holds, and the seed grants no capability beyond what pasting text into the composer already grants.
2. **No-clobber — STRUCTURALLY TRUE.** The lazy `useState` initializer makes the seed a mount-time-only input; there is no code path in the current routing topology where a late-arriving state can touch `input` after mount.
3. **No auto-send — TRUE.** The seed's only egress is the initial value of `input`; `send()`/`runStream()` are reachable only from the Send button and the Enter key handler. Proven non-vacuously by test.

---

## 1. Untrusted router state (`readChatSeedState`) — verdict: SOUND

`askSeed.ts:120-138`. `history.state` is attacker-shapeable (any same-page script, a crafted `history.pushState`, a forged SPA entry). Checked every field against every hostile shape I could construct:

- **Non-object / null / primitive state** → `typeof state !== 'object' || state === null` rejects (`askSeed.ts:121`). `undefined`, `42`, `'seed'` all covered by the unit test (`askSeed.test.ts:125-133`).
- **`seedText` non-string** (number, `String` object, `{toString(){…}}`, array) → `typeof seedText !== 'string'` rejects all of them; `typeof new String('x') === 'object'` so boxed strings are correctly refused (`askSeed.ts:124`).
- **Blank/whitespace seedText** → `.trim() === ''` rejects; Chat renders with an empty composer and a disabled Send.
- **Huge seedText** (tested to 100k chars) → clamped to `MESSAGE_CHAR_CAP = 4000` via `truncate` (`askSeed.ts:126`). `trim()` on a pathological multi-MB string is O(n) but cannot crash — no recursion, no regex backtracking, no JSON parse.
- **`mode`** → allow-list membership check against the literal 5-member array (`askSeed.ts:129-134`); a non-string or unknown string (`'evil_mode'`) is *dropped*, not forwarded — so a forged mode can never reach `POST /conversation`. Verified the array exactly mirrors the `ConversationMode` union (`client/src/types/domain.ts:1371-1376`).
- **Prototype-chain smuggling** (`Object.create({seedText:'x'})`) → the inherited value is still a string, still clamped — no capability difference from an own property. Fine.

**Can a malformed state crash Chat?** No. `readChatSeedState` is total over `unknown`, and Chat only ever consumes the narrowed result (`Chat.tsx:190-192`). The malformed-state Chat test (`Chat.test.tsx:481-495`, `seedText: 42`) proves the page renders normally with an empty composer.

**Same sanitize/wrap path as any message?** Yes — this is the key security property and it holds by construction. The seed lands **only** in the `input` state (`Chat.tsx:255`). The sole egress is `send()` (`Chat.tsx:~490`): `input.trim()` → `runStream` → `conversationService.streamMessage` with `{ content, expected_version }` — byte-identical to the typed-message path. Server-side, that content hits `z.string().min(1).max(4_000)` (`server/src/routes/conversation.ts:97`) and `sanitizeUserInput` (`server/src/services/claude/prompts/sanitize.ts:88`, per the route's B4 threat-model comment at `conversation.ts:13`). A forged seed therefore has **exactly** the injection power of pasting the same text into the textarea — i.e., none beyond a normal message. The `Chat.test.tsx:461-476` test additionally proves the outbound `body.content` is the seed text through the normal stream call, not a side channel.

**XSS surface?** None. The seed is a controlled `<textarea value={input}>` (`Chat.tsx:~645`), and after sending it renders as `{msg.kr}` — a React text node in `Bubble` (`Chat.tsx:728`). `grep` confirms zero `dangerouslySetInnerHTML`/`innerHTML` in the file (there is even a standing comment at `Chat.tsx:64` forbidding it). React escapes both paths.

## 2. No-clobber guarantee — verdict: STRUCTURALLY TRUE

`Chat.tsx:190-192` — `const [chatSeed] = useState(() => readChatSeedState(location.state))`. The initializer runs exactly once per component instance, during the first render. For a late-arriving state to clobber anything, Chat would have to *stay mounted* across a navigation to `/chat` carrying state. I traced the routing topology: `AskAboutThisButton` is rendered only on Mistakes, TopikResults, Topik study reveal, and Diagnostic — all **different routes**, so reaching the button requires unmounting Chat, and tapping it freshly mounts Chat, whose initializer reads the *new* entry's state. There is no `/chat`→`/chat` navigation anywhere.

- **Typed text**: pre-fill happens in the render-phase initializer, before the user can type; afterwards `input` is owned solely by `onChange`/hints/`send`. Nothing ever writes the seed into `input` again — there is literally no `setInput(seed…)` call.
- **Mid-stream + second "Ask about this"**: to tap a second button the user must leave `/chat`; the unmount cleanup aborts the in-flight stream via the per-send `AbortController` (pre-existing, covered by the abort-on-unmount test at `Chat.test.tsx:398`). The remount then starts clean. No clobber; no orphaned stream.
- **Mode**: `ensureConversationId` (`Chat.tsx:334-343`) applies `chatSeed?.mode` only on the lazy-start branch — `if (conversationId !== null) return conversationId;` guarantees an in-progress conversation's mode is never touched.

## 3. No auto-send — verdict: TRUE

The seed's only sink is `useState<string>(chatSeed?.seedText ?? '')` (`Chat.tsx:255`). `send()` is invoked from exactly two places: the Send button's `onClick` and the Enter-key handler. Neither the seed-capture initializer nor the clear effect references `send`/`runStream`. The test at `Chat.test.tsx:421-433` is non-vacuous: it asserts `streamCalls.length === 0` after a seeded mount **and** that Send is enabled (so the zero isn't an artifact of a broken composer). No wasted Claude call is possible on navigation.

## 4. State clearing — verdict: CORRECT (one latent trap, see SF-1)

`Chat.tsx:270-276`. Sequencing is right: the pre-fill happens during render (initializer), the clearing `navigate(location.pathname, { replace: true, state: null })` runs in a post-mount effect — the clear can never race ahead of the pre-fill. The test (`Chat.test.tsx:435-448`) proves both the state goes `empty` *and* the pre-filled text survives the clearing re-render.

- **Fires exactly once?** Yes. The ref guard is genuinely load-bearing, not decorative: in react-router v6 the `navigate` identity and `location` change on the replace, so the effect *does* re-run — without `seedClearedRef` this would replace-navigate in a loop. With it, the second run short-circuits. `chatSeed` itself is immutable for the component's lifetime, so the dep array is stable in the ways that matter.
- **Reload re-seed?** No. The replace writes `state: null` into the history entry (react-router syncs to `history.replaceState`), so a reload mounts with `location.state === null` → `readChatSeedState` returns null → empty composer. StrictMode double-invocation is also safe: refs survive the simulated remount, and even a double initializer run is idempotent.

## 5. ESLint `set-state-in-effect` / `refs` — verdict: CLEAN

No `setState` call inside any effect in the new code — the pre-fill is a state *initializer*, and the clear effect performs only a navigation side effect plus a ref write. Refs are never read or written during render (`seedClearedRef` is touched only inside the effect body), which is exactly what `react-hooks/refs` demands. The lazy-init + ref-guard pattern here is the textbook-correct shape for "consume navigation state once," not a smell being masked — the alternative (effect + `setInput`) would be both a lint error and a real clobber risk.

## 6. `buildAskSeed` — verdict: CORRECT

`askSeed.ts:80-104`. Sections are built as an array of blocks joined with `\n\n`, answer lines joined with `\n`; absent/blank fields are trimmed then skipped, so no dangling `지문:`/`Why:` labels or blank lines are possible (test asserts `not.toMatch(/\n{3,}/)`). Cap ordering is right: passage clamped to 1200 *inside* the block, whole message clamped to 3200 *after* joining, and 3200 < 4000 leaves the user ~800 chars of edit headroom before the server cap. Degenerate input (all-blank fields) still yields the header + follow-up question — non-empty, and unreachable in practice because `prompt`/`correctText` are required props on every wired surface.

## 7. Test adequacy — verdict: ADEQUATE, NON-VACUOUS

All four demanded properties are directly proven: no-auto-send (`streamCalls.length === 0` + Send enabled), edit-preservation across the clearing re-render, state-cleared via a real `useLocation` probe (`LocationStateProbe`) rather than a mock assertion, malformed-state rejection at both the unit level (7 hostile shapes) and the integration level (`seedText: 42` in a real MemoryRouter entry). The button test uses a real `MemoryRouter` + `/chat` probe route running the actual `readChatSeedState`, so it exercises the true handoff contract, not a mocked `useNavigate`. All 8 pre-existing Chat tests were re-wrapped in `renderChat()` and pass — 28/28 in this slice.

---

## Findings

### SHOULD-FIX

**SF-1 — Clearing navigation silently drops `location.search` and `location.hash`.**
`client/src/pages/Chat.tsx:274` — `navigate(location.pathname, { replace: true, state: null })` rebuilds the URL from the pathname alone. `/chat` takes no query params today (verified: no `useSearchParams`/`location.search` in the file), so this is currently harmless — but the moment anyone adds a query param to Chat (deep link to a conversation id, `?mode=`, analytics), a seeded arrival will silently strip it, and nothing will fail loudly. One-line fix:
```ts
navigate(
  { pathname: location.pathname, search: location.search, hash: location.hash },
  { replace: true, state: null },
);
```

### NIT

**N-1 — `truncate` can split a surrogate pair at the boundary.**
`client/src/lib/askSeed.ts:70-73` — `text.slice(0, max - 1)` operates on UTF-16 code units; an astral character (emoji in an explanation — Hangul itself is BMP-safe) landing exactly on the cut produces a lone surrogate, which serializes as an ill-formed `\uD8xx` in the JSON body. Some servers/encoders reject these. `[...text].slice(0, …)` or `text.slice()` + `String.prototype.isWellFormed()`-era `toWellFormed()` fixes it.

**N-2 — Rejected (malformed) router state is never cleared.**
`client/src/pages/Chat.tsx:271` — when `chatSeed === null` the effect returns before navigating, so a *forged malformed* state stays on the history entry across reloads. It is re-rejected every time, so this is a purity issue, not a security one — but clearing unconditionally when `location.state != null` would leave no attacker-controlled residue in history.

**N-3 — `CONVERSATION_MODES` can silently drift behind the union.**
`client/src/lib/askSeed.ts:107-113` — `ReadonlyArray<ConversationMode>` catches a *wrong* member but not a *missing* one; if `ConversationMode` gains a sixth mode, seeds carrying it get dropped with no compile error. A `satisfies` exhaustiveness helper (e.g. a `Record<ConversationMode, true>` keyed object) makes the drift a type error.

**N-4 — No Chat test pins "existing conversation keeps its own mode."**
The seed-mode test uses an empty conversation list (lazy-start path). The complementary guarantee — a seeded arrival with an *active* conversation never calls `startConversation` — rests on the early return at `Chat.tsx:335` and is only incidentally covered by pre-existing send tests that don't assert `startCalls.length === 0`. One assertion would pin it.

**N-5 — `seedClearedRef` vs. pre-existing `seededRef`.**
`client/src/pages/Chat.tsx:270` vs. `:279` — two adjacent refs whose names differ by four characters and mean entirely different things (F-020 state-clear guard vs. mock-thread seeding). Rename one (`askSeedClearedRef`) before someone edits the wrong guard.

### PRAISE

**P-1 — The threat model is written down where the code is.** `askSeed.ts:16-24` states exactly why history state is untrusted and what the narrowing defends against; the route-level comment (`conversation.ts:13`) closes the loop server-side. This is how security intent survives maintenance.

**P-2 — The mount-only capture is the right mechanism, not just a working one.** Choosing a lazy initializer over an effect makes the no-clobber property *structural* — it cannot regress without someone deliberately adding a new `setInput` — and simultaneously satisfies the strict `set-state-in-effect` rule instead of fighting it.

**P-3 — The button test exercises the real contract.** Rendering a real `MemoryRouter` with a `/chat` probe that runs the production `readChatSeedState` (instead of mocking `useNavigate`) means the test would catch a payload-shape drift between the button and Chat — the exact failure mode a mocked test would miss.
