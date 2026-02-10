# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Project Control is an Obsidian plugin that provides project management functionality for a PARA-style vault organization. It manages project folders, archiving, priorities tracking, and stale project detection.

## Build Commands

```bash
npm run dev      # Start esbuild in watch mode for development
npm run build    # Type-check and build for production (outputs main.js)
```

After building, reload Obsidian or the plugin to see changes.

## Architecture

The plugin is a single-file TypeScript application (`main.ts`) using the standard Obsidian plugin structure:

- **ProjectControlPlugin**: Main plugin class with settings, commands, and core logic
- **Modal classes**: UI components for user interactions (OpenProjectModal, ArchiveProjectModal, CreateProjectModal, StaleProjectsModal, ProjectActionsModal)
- **ProjectInfo interface**: Represents a project with folder, main file, name, and path

## Key Concepts

**Project Structure**: Projects are folders within the configured project folder (default: `10 - Project`). Each project has a main file with the same name as the folder (e.g., `My Project/My Project.md`).

**Project Detection**: Projects with a `#project-page` frontmatter tag are recognized as "proper" projects. The plugin uses `parseFrontMatterTags()` to check for this tag.

**Priorities File**: A central markdown file (default: `10 - Project/💫 Project Priorities.md`) tracks active project links. The plugin adds/removes project wiki-links to sections within this file.

**Stale Detection**: Projects are flagged as stale if they have `status: complete` in frontmatter or haven't been modified within the configured threshold (default: 30 days).

## Plugin Commands

- `open-project-page`: Fuzzy search projects with `#project-page` tag
- `go-to-project-root`: Navigate to current project's main file (context-aware)
- `project-actions`: Show actions modal for current project (context-aware)
- `create-project`: Create new project with optional emoji prefix
- `archive-project`: Move project to archive folder
- `find-stale-projects`: List projects needing attention

## Settings

Configured paths stored in `data.json`:
- `projectFolder`: Active projects location
- `archiveFolder`: Archived projects location
- `prioritiesFile`: Path to priorities markdown file
- `staleDays`: Inactivity threshold for stale detection
