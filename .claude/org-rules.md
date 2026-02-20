# OrrisTech Organization Rules

These rules apply to ALL repositories in the OrrisTech GitHub organization.
Claude Code automatically loads this file from `.claude/org-rules.md`.

---

## Pre-Change Verification

Before ANY commit, the following checks MUST pass. Do not commit code that breaks
existing functionality.

1. **Lint** -- Run lint and fix all errors. Warnings are acceptable only if pre-existing.
2. **Type check** -- Run `tsc --noEmit` (or the repo's `typecheck` script). Zero errors.
3. **Tests** -- Run the full test suite. All tests must pass.
4. **Build** -- Run a production build. It must complete without errors.

If any of these steps fail, fix the issue before committing. Never use `--no-verify`
to skip pre-commit hooks.

---

## Testing Requirements

- All new features MUST have unit tests (prefer Vitest; Jest is acceptable).
- All user-facing features MUST have BDD-style tests that describe behavior from the
  user's perspective (Given/When/Then or describe/it patterns).
- All existing tests MUST continue to pass after your changes.
- Coverage: maintain or improve the current coverage percentage. Never merge a PR that
  reduces coverage without explicit approval.
- Place all test files in a `__tests__/` directory co-located with the source, or in a
  top-level `tests/` directory -- follow the convention already established in the repo.

---

## React Best Practices

### Server Components (RSC) -- Next.js App Router
- Default to Server Components. Only add `"use client"` when the component genuinely
  needs interactivity, React hooks, or browser-only APIs.
- Data fetching belongs in Server Components or Server Actions -- not in client-side
  `useEffect`.

### React 19 Patterns
- Use `useActionState` for form state management (replaces `useFormState`).
- Use `useOptimistic` for optimistic UI updates.
- Use Server Actions for mutations (`"use server"` functions).
- Use the `use()` hook for reading promises and context in render.

### Performance
- No premature optimization. Profile first with React DevTools or Lighthouse, then
  optimize the identified bottleneck.
- Use `React.memo`, `useMemo`, and `useCallback` only when profiling shows a real
  performance problem -- not preemptively.
- Use `<Suspense>` boundaries around async data to show meaningful loading states.
- Prefer streaming and partial rendering over blocking the entire page.

---

## Documentation Requirements

- Update `/docs` when changing architecture, adding features, or modifying APIs.
- Keep `README.md` current with accurate setup instructions and prerequisites.
- Delete stale documentation when removing features -- do not leave orphan docs.
- PRD (Product Requirements Document) must be updated for feature changes.
- Inline comments: add them only where the logic is non-obvious. Do not add comments
  that merely restate the code.

---

## UI / Design Standards

### Component Library & Styling
- Use **shadcn/ui** components as the base component library.
- Use **Tailwind CSS v4** for all styling. No inline styles, no CSS modules, no
  styled-components unless the repo already uses them.
- SVG icons only. No icon fonts (Font Awesome, Material Icons CDN), no PNG/JPG icons.

### Design Principles
- Clarity over cleverness. Every UI element should have an obvious purpose.
- Consistent spacing using Tailwind's spacing scale.
- Strong visual hierarchy: size, weight, and color should guide the user's eye.

### Animations
Follow Emil Kowalski's animation principles:
- Every animation must have a **purpose** (feedback, orientation, delight).
- Duration: **< 300ms** for UI transitions. Longer only for page-level choreography.
- Easing: **ease-out** for elements entering, **ease-in** for elements exiting.
- Prefer CSS transitions over JS animation libraries when possible.
- No animation is better than bad animation.

### Responsive & Accessibility
- Mobile-first responsive design. Start with the smallest breakpoint and scale up.
- Dark mode support where applicable (use Tailwind's `dark:` variant).
- Keyboard navigable: all interactive elements must be reachable via Tab.
- Screen reader friendly: use semantic HTML, ARIA labels where needed, alt text on
  images.

---

## SEO Requirements

- Every page MUST have unique metadata: `title`, `description`, and `og:image`.
- Use structured data (JSON-LD) where applicable (articles, products, FAQ, breadcrumbs).
- Proper heading hierarchy: one `<h1>` per page, logical `<h2>` through `<h6>` nesting.
- Internal linking: related pages should link to each other.
- Alt text on ALL images. Decorative images use `alt=""`.
- No orphan pages -- every page must be reachable from at least one other page.
- Use `<link rel="canonical">` to prevent duplicate content issues.

---

## Blog Content Standards

Follow Google's helpful content guidelines:

- **Length**: 1000-2500+ words for substantive posts. Short posts are acceptable for
  changelogs or announcements.
- **Structure**: Include categories, tags, author, publication date, and a table of
  contents for posts over 1500 words.
- **CTA**: Every post needs a clear call-to-action or takeaway for the reader.
- **Quality**: Write for humans first. Provide unique insight, real examples, or
  original research.

### Banned AI Writing Patterns
Never use these words/phrases that signal low-quality AI-generated content:
- "delve", "landscape", "tapestry", "in conclusion", "it's worth noting"
- "navigate the complexities", "in today's fast-paced", "game-changer"
- "dive deep", "unlock the power", "revolutionary"
- Excessive hedging ("it's important to note that...")
- Lists of generic advice with no specific examples

---

## Terminology & Style

- Maintain a `STYLE_GUIDE.md` in each repo for project-specific terminology.
- Use **American English** spelling (color, not colour; optimize, not optimise).
- Technical terms must be consistent across all content within a repo. Pick one term
  and stick with it (e.g., "sign in" vs "log in" -- choose one).
- Brand names: use the official casing (GitHub, TypeScript, Next.js, Tailwind CSS).

---

## Package Manager

- **New projects**: Use **Bun** as the default package manager. Initialize with `bun init` and
  commit a `bun.lock` file.
- **Existing repos**: Respect the package manager already in use. CI auto-detects based on lock
  files:
  - `pnpm-lock.yaml` → **pnpm**
  - `package-lock.json` → **npm**
  - No recognized lock file → **Bun** (default)
- Do NOT mix package managers within a single repo. If migrating, remove the old lock file and
  regenerate with the new package manager in a dedicated PR.
- Use `--frozen-lockfile` (pnpm/bun) or `npm ci` (npm) in CI to ensure reproducible installs.

---

## Environment Variables

- Every repo MUST have a `.env.example` at the root listing ALL required environment
  variables with placeholder values. This file is used by CI to provide dummy env vars
  during builds.
- If a `.env.sample` file exists, **rename it to `.env.example`** and use that instead.
  Do not keep both files.
- When adding, removing, or renaming an env var in code, **update `.env.example`** in
  the same commit. Do not leave `.env.example` out of sync with the actual code.
- Format: one `KEY=placeholder_value` per line. Use comments to group related vars:
  ```
  # Supabase
  SUPABASE_URL=https://your-project.supabase.co
  SUPABASE_ANON_KEY=your-anon-key
  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

  # Stripe
  STRIPE_SECRET_KEY=sk_test_xxx
  ```
- Never put real secret values in `.env.example` — only descriptive placeholders.
- `.env.example` MUST be committed to git. `.env`, `.env.local`, and `.env.production`
  MUST be in `.gitignore` and never committed.

---

## Security Requirements

- **No new vulnerabilities**: `npm audit` / `pnpm audit` must not introduce new
  high or critical severity vulnerabilities.
- **No committed secrets**: Never commit API keys, tokens, passwords, or credentials.
  Use environment variables and `.env.local` (which must be in `.gitignore`).
- **Input validation**: All user-facing forms must validate input on both client and
  server side. Use Zod schemas for type-safe validation.
- **XSS prevention**: Sanitize all user-generated content before rendering. Never
  render unsanitized HTML from user input. Use a sanitizer library like DOMPurify
  when rendering dynamic HTML is unavoidable.
- **CSRF protection**: All mutations (POST, PUT, DELETE) must use CSRF tokens or
  Server Actions (which handle CSRF automatically).
- **Dependencies**: Keep dependencies up to date. Review changelogs before major
  version bumps.

---

## Dead Link Prevention

- Check all internal links before merging PRs that add or modify content.
- When deleting a page, update or remove all links that pointed to it.
- Use relative links for internal navigation (e.g., `/blog/my-post` not
  `https://example.com/blog/my-post`).
- Redirects: when moving a page to a new URL, add a redirect from the old URL.
