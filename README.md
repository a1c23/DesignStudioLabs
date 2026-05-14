# NowLabs

A working archive of prototypes, experiments, and early-stage builds. Not a portfolio of finished work — a living document updated as things evolve.

## Structure

```
/
├── index.html              ← main site (home, index, about views)
├── projects.json           ← project manifest (metadata for all entries)
└── projects/
    └── <slug>/
        ├── index.html      ← project viewer (auto-configures from projects.json)
        ├── app.html        ← prototype (if applicable)
        ├── thumb.png       ← gallery thumbnail
        └── assets/         ← project-specific assets
```

## Adding a project

1. Create a folder under `projects/` with a URL-friendly slug
2. Copy any existing `projects/*/index.html` as the viewer (it self-configures)
3. Add an entry to `projects.json`:

```json
{
  "id": "NL-006",
  "slug": "my-project",
  "title": "My Project",
  "desc": "Short description.",
  "category": "tools",
  "date": "2026-05",
  "stack": "HTML/CSS",
  "thumbnail": "/projects/my-project/thumb.png"
}
```

4. Drop in a `thumb.png` for the gallery
5. If the project has a working prototype, save it as `app.html` — the viewer auto-detects it and shows a "Launch Prototype" button
6. Push

## Categories

`tools` · `motion` · `iconography` · `illustrations` · `color`

## Local development

```bash
npx serve
```

Then open `http://localhost:3000`. A local server is required — `fetch()` doesn't work over `file://`.

## Deployment

Static site on Vercel. Deploys automatically on push to `main`.
