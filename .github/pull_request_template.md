## Description
<!-- Brief description of changes -->

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update
- [ ] Performance improvement
- [ ] Refactoring

## Checklist

### Code Quality
- [ ] Lint passes (`pnpm lint` / `npm run lint`)
- [ ] TypeScript compiles (`pnpm typecheck` / `npm run typecheck`)
- [ ] Build succeeds (`pnpm build` / `npm run build`)
- [ ] No debug code (`console.log`, `debugger`, leftover `TODO`)
- [ ] No AI slop (unnecessary abstractions, over-engineering)

### Testing
- [ ] Unit tests added for new functionality
- [ ] BDD tests added for user-facing features
- [ ] All existing tests pass
- [ ] Edge cases covered

### Security
- [ ] No new npm audit vulnerabilities (high/critical)
- [ ] No committed secrets or API keys
- [ ] Input validation on user-facing forms
- [ ] XSS prevention (sanitized user content)

### Documentation
- [ ] `/docs` updated (if architecture changed)
- [ ] README updated (if setup changed)
- [ ] No stale documentation left behind
- [ ] Inline comments for complex logic only

### UI / Design (if applicable)
- [ ] Follows design system (shadcn/ui + Tailwind CSS v4)
- [ ] SVG icons only (no icon fonts, no PNGs)
- [ ] Animations < 300ms, purposeful
- [ ] Mobile responsive
- [ ] Accessible (keyboard nav, screen reader, alt text)

### SEO (if applicable)
- [ ] Metadata set (title, description, og:image)
- [ ] Structured data (JSON-LD) where applicable
- [ ] Heading hierarchy correct (single h1)
- [ ] Alt text on all images
- [ ] No broken internal links

### Blog Content (if applicable)
- [ ] 1000+ words for substantive posts
- [ ] Categories, tags, and author set
- [ ] Table of contents included
- [ ] No banned AI writing patterns
- [ ] Clear takeaway / CTA for the reader
