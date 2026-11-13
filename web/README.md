# SMP Web Panel

Svelte 5 + Vite panel for the SMP Minecraft server manager.

## Scripts

```bash
bun install
bun run dev      # Vite dev server on :5173 (API proxied to :3001)
bun run build    # Builds into ../server/src/public (served by the Bun API)
bun run check    # svelte-check (types + a11y)
```

`vite.config.js` sets `outDir: ../server/src/public`, so a successful build is served
directly by `http://localhost:3001` — no separate static server is needed.

## Layout

```
src/
├── App.svelte            Hash router (router.js), global appState, create-server flow, EULA dialog
├── app.css               Design tokens (colors, radii, shadows) + base element/component styles
├── main.js               mount()
└── lib/
    ├── api.js            HTTP client: JSON, timeouts, bounded retries, ApiError
    ├── stores.js         One exported function per API endpoint
    ├── router.js         Minimal hash router store
    ├── toast.js          Toast store + helpers (success/error/warning/info)
    ├── ansi.js           ANSI → HTML for the console
    └── components/
        ├── ui/           Reusable primitives (see below)
        ├── Sidebar.svelte
        ├── Dashboard.svelte
        ├── ServerDetail.svelte
        ├── ModsBrowser.svelte
        ├── Settings.svelte
        ├── CreateServer.svelte
        ├── CodeEditor.svelte
        ├── MemoryJvmInput.svelte
        └── dashboard/{ConsolePanel,FileManager}.svelte
```

## UI primitives (`components/ui`)

| Component | Purpose |
|---|---|
| `Button` | Variants (primary/secondary/outline/danger/ghost/subtle), sizes, loading spinner, renders `<a>` when `href` |
| `IconButton` | Compact icon-only button with `aria-label` |
| `TextField` | Labelled input (text/number/password/search/file) + hint/error |
| `TextArea` | Multiline input, optional char counter, monospace mode |
| `Select` | Native select wrapper with options or slotted `<option>` |
| `Switch` | Accessible toggle |
| `Slider` | Discrete (`steps`) or continuous range with value read-out and tick shortcuts |
| `Segmented` | Pill group for channels/loaders |
| `SearchInput` | TextField + magnifier + clear button |
| `Tabs` | Tab bar with badges |
| `Modal` | Backdrop/Escape close, focus trap, scroll lock, footer snippet |
| `ConfirmDialog` | Destructive confirmation, optional "type the name to confirm" |
| `Alert` | Info/success/warning/danger banner |
| `Badge` | Small uppercase status chip (with optional dot) |
| `Panel` | Titled card with header actions and body |
| `KeyValueList` | Definition list of key/value rows |
| `EmptyState` | Empty-list placeholder with optional action |
| `Spinner` | Inline spinner or skeleton block |
| `FormRow` | Label + control + hint/error group |
| `ToastStack` | Global toasts rendered from the toast store |
| `Tab` | Label span used inside Tabs |

All primitives accept a `class` prop and forward unknown attributes to the underlying element.
Styling comes from `app.css` (`.btn`, `.input`, `.panel`, `.badge`, …) plus component-scoped styles.

## Conventions

- Svelte 5 runes only (`$state`, `$derived`, `$effect`, `$props`, `$bindable`).
- No `export let` / stores for component state.
- Keep server-specific logic in `stores.js`; components call those helpers.
- New shared visual behaviour belongs in `components/ui`, not duplicated per page.