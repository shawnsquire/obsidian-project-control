# Project Control

An Obsidian plugin for managing projects in a PARA-style vault. Provides a drag-and-drop dashboard, status tracking, archiving, and a priorities file that keeps everything in sync.

## How it works

Projects are **folders** inside a configurable project directory (default: `10 - Project`). Each project folder has a **main file** with the same name as the folder (e.g. `My Project/My Project.md`). The main file's frontmatter drives the dashboard:

```yaml
---
title: "My Project"
created: 2025-01-15
tags:
  - project-page
emoji: "🎯"
status: active
category: work
priority-group: Foundation
priority: high
---
```

A **priorities file** (a plain markdown file with `## Section` headers) is the source of truth for project ordering. The plugin reads and writes this file to persist the dashboard layout. Sections map to statuses:

| Section | Status |
|---------|--------|
| `## Active` | `active` |
| `## Coming Soon` | `coming-soon` |
| `## Deferred Effort` | `deferred` |
| `## On Hold` | `on-hold` |

Projects with `status: complete` are removed from the priorities file.

## Dashboard

Open via the command palette: **Project Control: Open Project Dashboard**.

- Drag and drop projects to reorder or move between status sections
- Click a project name to open it
- Click the status badge to change status
- Context menu (`...`) for rename, duplicate, archive, edit metadata, and more
- Category groups and sections are collapsible; collapse state persists across reloads
- Projects with a `#project-page` tag but not in the priorities file appear in a "Not in Priorities" section with a `+` button to add them

## Commands

| Command | Description |
|---------|-------------|
| Open Project Dashboard | Open the dashboard view |
| Open Project Page | Fuzzy search projects by name |
| Go to Project Root | Jump to current project's main file |
| Project Actions | Context-aware actions for the current project |
| Create Project | Create a new project folder and main file |
| Archive Project | Move a project to the archive folder |
| Restore Project from Archive | Move a project back from archive |
| Rename Project | Rename folder, file, and update links vault-wide |
| Duplicate Project | Copy a project with optional task reset |
| Edit Project Metadata | Edit frontmatter fields |
| Find Stale Projects | List projects with no recent activity |
| Sync All Projects to Priorities | Rebuild priorities sections from frontmatter |
| Open Project Priorities | Open the priorities file directly |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Project folder | `10 - Project` | Where active projects live |
| Archive folder | `80 - Archive` | Where archived projects go |
| Priorities file | `10 - Project/💫 Project Priorities.md` | Markdown file that tracks project order |
| Stale threshold | 30 days | Inactivity threshold for stale detection |

## Development

```bash
npm install
npm run dev      # watch mode
npm run build    # type-check + production build
```

After building, reload Obsidian or use the "Reload app without saving" command to pick up changes.

## Installation

### Manual

1. Clone this repo into your vault's `.obsidian/plugins/project-control/` directory
2. `npm install && npm run build`
3. Enable "Project Control" in Obsidian settings under Community Plugins

### From releases

Download `main.js`, `manifest.json`, and `styles.css` from a release and place them in `.obsidian/plugins/project-control/`.
