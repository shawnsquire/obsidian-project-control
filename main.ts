import {
    App,
    Plugin,
    PluginSettingTab,
    Modal,
    FuzzySuggestModal,
    Setting,
    TFile,
    TFolder,
    Notice,
    parseFrontMatterTags,
    TextComponent,
    Menu,
    ItemView,
    WorkspaceLeaf
} from 'obsidian';

const DASHBOARD_VIEW_TYPE = 'project-dashboard';

interface ProjectControlSettings {
    projectFolder: string;
    archiveFolder: string;
    prioritiesFile: string;
    staleDays: number;
    collapsedSections: string[];
}

const DEFAULT_SETTINGS: ProjectControlSettings = {
    projectFolder: '10 - Project',
    archiveFolder: '80 - Archive',
    prioritiesFile: '10 - Project/💫 Project Priorities.md',
    staleDays: 30,
    collapsedSections: []
};

// Path utility functions
function normalizePath(path: string): string {
    if (!path) return '';
    // Remove trailing slashes, normalize separators
    return path.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/+/g, '/');
}

function getProjectNameFromPath(fullPath: string, projectFolder: string): string | null {
    const normalizedPath = normalizePath(fullPath);
    const normalizedProjectFolder = normalizePath(projectFolder);

    if (!normalizedProjectFolder || !normalizedPath.startsWith(normalizedProjectFolder + '/')) {
        return null;
    }

    const relativePath = normalizedPath.substring(normalizedProjectFolder.length + 1);
    const projectName = relativePath.split('/')[0];
    return projectName || null;
}

interface ProjectInfo {
    folder: TFolder;
    mainFile: TFile | null;
    name: string;
    path: string;
}

interface PriorityEntry {
    projectName: string;
    emoji: string;
    alias: string | null;
    project: ProjectInfo | null;
    frontmatter: Record<string, any> | null;
}

type SectionItem =
    | { type: 'subsection'; subsection: { name: string; entries: PriorityEntry[] } }
    | { type: 'entry'; entry: PriorityEntry };

interface PrioritySection {
    name: string;
    orderedItems: SectionItem[];
}

interface DashboardData {
    sections: PrioritySection[];
    unlisted: ProjectInfo[];
}

export default class ProjectControlPlugin extends Plugin {
    settings: ProjectControlSettings;

    async onload() {
        await this.loadSettings();

        this.registerView(
            DASHBOARD_VIEW_TYPE,
            (leaf) => new ProjectDashboardView(leaf, this)
        );

        // Open a project page
        this.addCommand({
            id: 'open-project-page',
            name: 'Open Project Page',
            callback: () => this.openProjectPageModal()
        });

        // Go to project root
        this.addCommand({
            id: 'go-to-project-root',
            name: 'Go to Project Root',
            callback: () => this.goToProjectRoot()
        });

        // Project actions
        this.addCommand({
            id: 'project-actions',
            name: 'Project Actions',
            callback: () => this.showProjectActions()
        });

        // Create project
        this.addCommand({
            id: 'create-project',
            name: 'Create Project',
            callback: () => new CreateProjectModal(this.app, this).open()
        });

        // Archive project
        this.addCommand({
            id: 'archive-project',
            name: 'Archive Project',
            callback: () => this.showArchiveProjectModal()
        });

        // Find stale projects
        this.addCommand({
            id: 'find-stale-projects',
            name: 'Find Stale Projects',
            callback: () => this.findStaleProjects()
        });

        // Restore project from archive
        this.addCommand({
            id: 'restore-project',
            name: 'Restore Project from Archive',
            callback: () => this.showRestoreProjectModal()
        });

        // Rename project
        this.addCommand({
            id: 'rename-project',
            name: 'Rename Project',
            callback: () => this.showRenameProjectModal()
        });

        // Duplicate project
        this.addCommand({
            id: 'duplicate-project',
            name: 'Duplicate Project',
            callback: () => this.showDuplicateProjectModal()
        });

        // Open project priorities file
        this.addCommand({
            id: 'open-project-priorities',
            name: 'Open Project Priorities',
            callback: () => this.openPrioritiesFile()
        });

        // Edit project metadata
        this.addCommand({
            id: 'edit-project-metadata',
            name: 'Edit Project Metadata',
            callback: () => this.showEditMetadataModal()
        });

        // Sync all projects to priorities file
        this.addCommand({
            id: 'sync-all-to-priorities',
            name: 'Sync All Projects to Priorities',
            callback: () => this.syncAllProjectsToPriorities()
        });

        // Open project dashboard
        this.addCommand({
            id: 'open-project-dashboard',
            name: 'Open Project Dashboard',
            callback: () => this.activateDashboardView()
        });

        this.addSettingTab(new ProjectControlSettingTab(this.app, this));
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(DASHBOARD_VIEW_TYPE);
    }

    async activateDashboardView() {
        const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
        if (existing.length > 0) {
            this.app.workspace.revealLeaf(existing[0]);
            return;
        }
        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        await this.validateSettings();
    }

    async validateSettings(): Promise<void> {
        let needsSave = false;
        const corrections: string[] = [];

        // Validate projectFolder
        if (!this.settings.projectFolder || this.settings.projectFolder.trim() === '') {
            this.settings.projectFolder = DEFAULT_SETTINGS.projectFolder;
            corrections.push(`Project folder reset to "${DEFAULT_SETTINGS.projectFolder}"`);
            needsSave = true;
        }

        // Validate archiveFolder
        if (!this.settings.archiveFolder || this.settings.archiveFolder.trim() === '') {
            this.settings.archiveFolder = DEFAULT_SETTINGS.archiveFolder;
            corrections.push(`Archive folder reset to "${DEFAULT_SETTINGS.archiveFolder}"`);
            needsSave = true;
        }

        // Validate prioritiesFile
        if (!this.settings.prioritiesFile || this.settings.prioritiesFile.trim() === '') {
            this.settings.prioritiesFile = DEFAULT_SETTINGS.prioritiesFile;
            corrections.push(`Priorities file reset to "${DEFAULT_SETTINGS.prioritiesFile}"`);
            needsSave = true;
        }

        // Validate staleDays
        if (!this.settings.staleDays || this.settings.staleDays < 1) {
            this.settings.staleDays = DEFAULT_SETTINGS.staleDays;
            corrections.push(`Stale days reset to ${DEFAULT_SETTINGS.staleDays}`);
            needsSave = true;
        }

        // Normalize paths
        const normalizedProjectFolder = normalizePath(this.settings.projectFolder);
        if (normalizedProjectFolder !== this.settings.projectFolder) {
            this.settings.projectFolder = normalizedProjectFolder;
            needsSave = true;
        }

        const normalizedArchiveFolder = normalizePath(this.settings.archiveFolder);
        if (normalizedArchiveFolder !== this.settings.archiveFolder) {
            this.settings.archiveFolder = normalizedArchiveFolder;
            needsSave = true;
        }

        const normalizedPrioritiesFile = normalizePath(this.settings.prioritiesFile);
        if (normalizedPrioritiesFile !== this.settings.prioritiesFile) {
            this.settings.prioritiesFile = normalizedPrioritiesFile;
            needsSave = true;
        }

        if (needsSave) {
            await this.saveSettings();
            if (corrections.length > 0) {
                new Notice(`Project Control: Settings corrected\n${corrections.join('\n')}`);
            }
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    getCurrentProject(): ProjectInfo | null {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return null;

        const projectFolderPath = normalizePath(this.settings.projectFolder);
        if (!projectFolderPath) return null;

        const projectName = getProjectNameFromPath(activeFile.path, projectFolderPath);
        if (!projectName) return null;

        const projectPath = `${projectFolderPath}/${projectName}`;
        const projectFolder = this.app.vault.getAbstractFileByPath(projectPath);
        if (!(projectFolder instanceof TFolder)) return null;

        // Find main file (filename matches folder name)
        const mainFilePath = `${projectPath}/${projectName}.md`;
        const mainFile = this.app.vault.getAbstractFileByPath(mainFilePath);

        return {
            folder: projectFolder,
            mainFile: mainFile instanceof TFile ? mainFile : null,
            name: projectName,
            path: projectPath
        };
    }

    getAllProjects(): ProjectInfo[] {
        const projects: ProjectInfo[] = [];
        const projectFolder = this.app.vault.getAbstractFileByPath(this.settings.projectFolder);

        if (!(projectFolder instanceof TFolder)) return projects;

        for (const child of projectFolder.children) {
            if (child instanceof TFolder) {
                const mainFilePath = `${child.path}/${child.name}.md`;
                const mainFile = this.app.vault.getAbstractFileByPath(mainFilePath);

                projects.push({
                    folder: child,
                    mainFile: mainFile instanceof TFile ? mainFile : null,
                    name: child.name,
                    path: child.path
                });
            }
        }

        return projects;
    }

    getProjectsWithTag(): ProjectInfo[] {
        return this.getAllProjects().filter(p => {
            if (!p.mainFile) return false;
            const cache = this.app.metadataCache.getFileCache(p.mainFile);
            const tags = parseFrontMatterTags(cache?.frontmatter) || [];
            return tags.some(tag => tag === '#project-page' || tag === 'project-page');
        });
    }

    async goToProjectRoot(): Promise<void> {
        const currentProject = this.getCurrentProject();
        if (currentProject) {
            if (currentProject.mainFile) {
                await this.app.workspace.getLeaf().openFile(currentProject.mainFile);
            } else {
                new Notice(`Project "${currentProject.name}" has no main file`);
            }
            return;
        }

        // Not in a project, show picker
        const projects = this.getAllProjects().filter(p => p.mainFile);
        if (projects.length === 0) {
            new Notice('No projects found');
            return;
        }

        new ProjectPickerModal(this.app, projects, 'Select project to open', async (project) => {
            if (project.mainFile) {
                await this.app.workspace.getLeaf().openFile(project.mainFile);
            }
        }).open();
    }

    async showProjectActions(): Promise<void> {
        const currentProject = this.getCurrentProject();
        if (currentProject) {
            new ProjectActionsModal(this.app, this, currentProject).open();
            return;
        }

        // Not in a project, show picker first
        const projects = this.getAllProjects();
        if (projects.length === 0) {
            new Notice('No projects found');
            return;
        }

        new ProjectPickerModal(this.app, projects, 'Select project for actions', (project) => {
            new ProjectActionsModal(this.app, this, project).open();
        }).open();
    }

    async openProjectPageModal() {
        const projects = this.getProjectsWithTag();

        if (projects.length === 0) {
            new Notice('No project pages found');
            return;
        }

        const choices = projects.map(p => ({
            project: p,
            display: p.name
        }));

        new OpenProjectModal(this.app, choices).open();
    }

    async showArchiveProjectModal() {
        const projects = this.getAllProjects();

        if (projects.length === 0) {
            new Notice('No projects found');
            return;
        }

        new ArchiveProjectModal(this.app, this, projects).open();
    }

    async archiveProject(project: ProjectInfo): Promise<void> {
        try {
            const archivePath = `${this.settings.archiveFolder}/${project.name}`;

            // Check if archive folder exists
            const archiveFolder = this.app.vault.getAbstractFileByPath(this.settings.archiveFolder);
            if (!archiveFolder) {
                await this.app.vault.createFolder(this.settings.archiveFolder);
            }

            // Check if destination already exists
            const existing = this.app.vault.getAbstractFileByPath(archivePath);
            if (existing) {
                new Notice(`Cannot archive: "${project.name}" already exists in archive`);
                return;
            }

            // Move project folder
            await this.app.vault.rename(project.folder, archivePath);

            // Remove from priorities file
            await this.removeFromPriorities(project.name);

            new Notice(`Archived project: ${project.name}`);
        } catch (error) {
            console.error('Failed to archive project:', error);
            new Notice(`Failed to archive project: ${error.message}`);
        }
    }

    async removeFromPriorities(projectName: string): Promise<void> {
        const prioritiesFile = this.app.vault.getAbstractFileByPath(this.settings.prioritiesFile);
        if (!(prioritiesFile instanceof TFile)) return;

        let content = await this.app.vault.read(prioritiesFile);

        // Remove lines containing the project link
        const patterns = [
            new RegExp(`^.*\\[\\[${this.escapeRegex(projectName)}\\]\\].*$`, 'gm'),
            new RegExp(`^.*\\[\\[${this.escapeRegex(projectName)}\\|[^\\]]+\\]\\].*$`, 'gm')
        ];

        for (const pattern of patterns) {
            content = content.replace(pattern, '');
        }

        // Clean up empty lines
        content = content.replace(/\n{3,}/g, '\n\n');

        await this.app.vault.modify(prioritiesFile, content);
    }

    getProjectEmoji(project: ProjectInfo): string | undefined {
        if (!project.mainFile) return undefined;
        const cache = this.app.metadataCache.getFileCache(project.mainFile);
        return cache?.frontmatter?.emoji || undefined;
    }

    async addToPriorities(projectName: string, section: string = 'Additional', emoji?: string): Promise<void> {
        const prioritiesFile = this.app.vault.getAbstractFileByPath(this.settings.prioritiesFile);
        if (!(prioritiesFile instanceof TFile)) {
            new Notice('Priorities file not found');
            return;
        }

        let content = await this.app.vault.read(prioritiesFile);
        const emojiPart = emoji ? `${emoji} ` : '';

        // Find the section and add the project
        const sectionPattern = new RegExp(`^## ${section}$`, 'm');
        const match = content.match(sectionPattern);

        if (match && match.index !== undefined) {
            const insertPos = match.index + match[0].length;
            const newEntry = `\n- ${emojiPart}[[${projectName}]]`;
            content = content.slice(0, insertPos) + newEntry + content.slice(insertPos);
        } else {
            // Add to end before the separator
            const separatorIndex = content.lastIndexOf('---');
            if (separatorIndex > 0) {
                content = content.slice(0, separatorIndex) + `## ${section}\n- ${emojiPart}[[${projectName}]]\n\n` + content.slice(separatorIndex);
            }
        }

        await this.app.vault.modify(prioritiesFile, content);
    }

    /**
     * Get the section in the priorities file where a project is currently listed
     */
    async getProjectCurrentSection(projectName: string): Promise<string | null> {
        const prioritiesFile = this.app.vault.getAbstractFileByPath(this.settings.prioritiesFile);
        if (!(prioritiesFile instanceof TFile)) return null;

        const content = await this.app.vault.read(prioritiesFile);
        const escapedName = this.escapeRegex(projectName);

        // Pattern to match project link in any format
        const projectPattern = new RegExp(`\\[\\[${escapedName}(\\|[^\\]]+)?\\]\\]`);

        // Split into sections and find which one contains the project
        const lines = content.split('\n');
        let currentSection: string | null = null;

        for (const line of lines) {
            // Check for section headers (## Section Name)
            const sectionMatch = line.match(/^## (.+)$/);
            if (sectionMatch) {
                currentSection = sectionMatch[1];
            }

            // Check if this line contains the project link
            if (projectPattern.test(line)) {
                return currentSection;
            }
        }

        return null;
    }

    /**
     * Move a project link from its current section to a target section
     */
    async moveProjectInPriorities(projectName: string, targetSection: string): Promise<void> {
        const prioritiesFile = this.app.vault.getAbstractFileByPath(this.settings.prioritiesFile);
        if (!(prioritiesFile instanceof TFile)) {
            new Notice('Priorities file not found');
            return;
        }

        let content = await this.app.vault.read(prioritiesFile);
        const escapedName = this.escapeRegex(projectName);

        // Find and extract the project line
        const projectLinePattern = new RegExp(`^(.*\\[\\[${escapedName}(\\|[^\\]]+)?\\]\\].*)$`, 'gm');
        const match = content.match(projectLinePattern);

        if (!match) {
            // Project not in priorities, just add it
            await this.addToPriorities(projectName, targetSection);
            return;
        }

        const projectLine = match[0];

        // Remove the project from its current location
        content = content.replace(projectLinePattern, '');
        // Clean up any resulting empty lines
        content = content.replace(/\n{3,}/g, '\n\n');

        // Find target section and add project there
        const sectionPattern = new RegExp(`^## ${this.escapeRegex(targetSection)}$`, 'm');
        const sectionMatch = content.match(sectionPattern);

        if (sectionMatch && sectionMatch.index !== undefined) {
            const insertPos = sectionMatch.index + sectionMatch[0].length;
            content = content.slice(0, insertPos) + '\n' + projectLine + content.slice(insertPos);
        } else {
            // Section doesn't exist, create it before the separator
            const separatorIndex = content.lastIndexOf('---');
            if (separatorIndex > 0) {
                content = content.slice(0, separatorIndex) + `## ${targetSection}\n${projectLine}\n\n` + content.slice(separatorIndex);
            } else {
                // No separator, add at end
                content = content + `\n## ${targetSection}\n${projectLine}\n`;
            }
        }

        await this.app.vault.modify(prioritiesFile, content);
    }

    /**
     * Status to section mapping for priorities file
     */
    private getStatusSection(status: string): string | null {
        const statusSectionMap: Record<string, string> = {
            'active': 'Active',
            'coming-soon': 'Coming Soon',
            'deferred': 'Deferred Effort',
            'on-hold': 'On Hold'
        };
        return statusSectionMap[status] || null;
    }

    /**
     * Sync project status to priorities file
     * - active: Move to Active section
     * - coming-soon: Move to Coming Soon section
     * - deferred: Move to Deferred Effort section
     * - on-hold: Move to On Hold section
     * - complete: Remove from priorities
     */
    async syncProjectStatusToPriorities(project: ProjectInfo, newStatus: string): Promise<void> {
        if (newStatus === 'complete') {
            await this.removeFromPriorities(project.name);
            return;
        }

        const targetSection = this.getStatusSection(newStatus);
        if (targetSection) {
            await this.moveProjectInPriorities(project.name, targetSection);
        }
    }

    async moveProjectToSubsection(projectName: string, targetGroup: string | null): Promise<void> {
        const data = await this.parsePrioritiesFile();
        if (!data) return;

        let foundEntry: PriorityEntry | null = null;
        let foundSectionIdx = -1;

        for (let si = 0; si < data.sections.length; si++) {
            const section = data.sections[si];
            for (let ii = 0; ii < section.orderedItems.length; ii++) {
                const item = section.orderedItems[ii];
                if (item.type === 'entry' && item.entry.projectName === projectName) {
                    foundEntry = item.entry;
                    foundSectionIdx = si;
                    section.orderedItems.splice(ii, 1);
                    break;
                }
                if (item.type === 'subsection') {
                    const idx = item.subsection.entries.findIndex(e => e.projectName === projectName);
                    if (idx >= 0) {
                        foundEntry = item.subsection.entries[idx];
                        foundSectionIdx = si;
                        item.subsection.entries.splice(idx, 1);
                        break;
                    }
                }
            }
            if (foundEntry) break;
        }

        if (!foundEntry || foundSectionIdx < 0) return;

        const section = data.sections[foundSectionIdx];

        if (targetGroup) {
            const subItem = section.orderedItems.find(
                item => item.type === 'subsection' && item.subsection.name === targetGroup
            );
            if (subItem && subItem.type === 'subsection') {
                subItem.subsection.entries.push(foundEntry);
            } else {
                // Subsection doesn't exist in this section, add as top-level
                section.orderedItems.push({ type: 'entry', entry: foundEntry });
            }
        } else {
            // No group - insert before first subsection
            let insertIdx = section.orderedItems.findIndex(item => item.type === 'subsection');
            if (insertIdx < 0) insertIdx = section.orderedItems.length;
            section.orderedItems.splice(insertIdx, 0, { type: 'entry', entry: foundEntry });
        }

        await this.writePrioritiesFile(data);
    }

    /**
     * Change project status: updates frontmatter and syncs to priorities file
     */
    async changeProjectStatus(project: ProjectInfo, newStatus: string, subsection?: string): Promise<void> {
        if (!project.mainFile) {
            new Notice('No main file found for this project');
            return;
        }

        // Update frontmatter
        await this.updateFrontmatter(project.mainFile, { status: newStatus });

        // Sync to priorities file
        await this.syncProjectStatusToPriorities(project, newStatus);

        // If a subsection is specified (e.g., Foundation, Growth, Recharge),
        // we could handle sub-section placement here in the future

        new Notice(`Project status changed to: ${newStatus}`);
    }

    /**
     * Open the priorities file in the workspace
     */
    async openPrioritiesFile(): Promise<void> {
        const prioritiesFile = this.app.vault.getAbstractFileByPath(this.settings.prioritiesFile);
        if (!(prioritiesFile instanceof TFile)) {
            new Notice('Priorities file not found');
            return;
        }

        await this.app.workspace.getLeaf().openFile(prioritiesFile);
    }

    /**
     * Sync all projects to priorities file based on their frontmatter status.
     * This rebuilds the priorities file sections from frontmatter.
     */
    async syncAllProjectsToPriorities(): Promise<void> {
        const projects = this.getAllProjects();
        let synced = 0;
        let skipped = 0;

        for (const project of projects) {
            if (!project.mainFile) {
                skipped++;
                continue;
            }

            const cache = this.app.metadataCache.getFileCache(project.mainFile);
            const status = cache?.frontmatter?.status;

            if (!status) {
                // No status set, skip
                skipped++;
                continue;
            }

            await this.syncProjectStatusToPriorities(project, status);
            synced++;
        }

        new Notice(`Synced ${synced} projects to priorities (${skipped} skipped - no status)`);
    }

    async findStaleProjects(): Promise<void> {
        const projects = this.getAllProjects();
        const now = Date.now();
        const staleThreshold = this.settings.staleDays * 24 * 60 * 60 * 1000;

        // Statuses that are intentionally paused - don't flag as stale
        const exemptStatuses = ['coming-soon', 'deferred', 'on-hold'];

        const staleProjects: { project: ProjectInfo; lastModified: number; reason: string }[] = [];

        for (const project of projects) {
            if (project.mainFile) {
                const cache = this.app.metadataCache.getFileCache(project.mainFile);
                const status = cache?.frontmatter?.status;

                // Check if status is complete - flag as needing archival
                if (status === 'complete') {
                    staleProjects.push({
                        project,
                        lastModified: project.mainFile.stat.mtime,
                        reason: 'Status: complete'
                    });
                    continue;
                }

                // Skip projects with exempt statuses (intentionally paused)
                if (status && exemptStatuses.includes(status)) {
                    continue;
                }
            }

            // Only check inactivity for active projects (status: active or undefined)
            const lastModified = await this.getProjectLastModified(project);
            if (now - lastModified > staleThreshold) {
                const daysAgo = Math.floor((now - lastModified) / (24 * 60 * 60 * 1000));
                staleProjects.push({
                    project,
                    lastModified,
                    reason: `No activity for ${daysAgo} days`
                });
            }
        }

        if (staleProjects.length === 0) {
            new Notice('No stale projects found');
            return;
        }

        new StaleProjectsModal(this.app, this, staleProjects).open();
    }

    async getProjectLastModified(project: ProjectInfo): Promise<number> {
        let lastModified = 0;
        const files = this.app.vault.getMarkdownFiles().filter(f =>
            f.path.startsWith(project.path + '/')
        );

        for (const file of files) {
            if (file.stat.mtime > lastModified) {
                lastModified = file.stat.mtime;
            }
        }

        return lastModified;
    }

    async createProject(name: string, emoji?: string): Promise<void> {
        try {
            const projectPath = `${this.settings.projectFolder}/${name}`;
            const mainFilePath = `${projectPath}/${name}.md`;

            // Check if project already exists
            const existing = this.app.vault.getAbstractFileByPath(projectPath);
            if (existing) {
                new Notice(`Project "${name}" already exists`);
                return;
            }

            // Ensure project folder exists
            const projectFolder = this.app.vault.getAbstractFileByPath(this.settings.projectFolder);
            if (!projectFolder) {
                await this.app.vault.createFolder(this.settings.projectFolder);
            }

            // Create folder
            await this.app.vault.createFolder(projectPath);

            // Create main file with frontmatter
            const emojiLine = emoji ? `emoji: "${emoji}"\n` : '';
            const content = `---
title: "${name}"
created: ${new Date().toISOString().split('T')[0]}
tags:
  - project-page
${emojiLine}status: active
category:
priority:
---

# ${name}

`;

            await this.app.vault.create(mainFilePath, content);

            // Add to priorities
            await this.addToPriorities(name, 'Additional', emoji);

            // Open the new file
            const file = this.app.vault.getAbstractFileByPath(mainFilePath);
            if (file instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(file);
            }

            new Notice(`Created project: ${name}`);
        } catch (error) {
            console.error('Failed to create project:', error);
            new Notice(`Failed to create project: ${error.message}`);
        }
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    getArchivedProjects(): ProjectInfo[] {
        const projects: ProjectInfo[] = [];
        const archiveFolder = this.app.vault.getAbstractFileByPath(this.settings.archiveFolder);

        if (!(archiveFolder instanceof TFolder)) return projects;

        for (const child of archiveFolder.children) {
            if (child instanceof TFolder) {
                const mainFilePath = `${child.path}/${child.name}.md`;
                const mainFile = this.app.vault.getAbstractFileByPath(mainFilePath);

                projects.push({
                    folder: child,
                    mainFile: mainFile instanceof TFile ? mainFile : null,
                    name: child.name,
                    path: child.path
                });
            }
        }

        return projects;
    }

    async restoreProject(project: ProjectInfo): Promise<void> {
        try {
            const restorePath = `${this.settings.projectFolder}/${project.name}`;

            // Check if project folder exists
            const projectFolder = this.app.vault.getAbstractFileByPath(this.settings.projectFolder);
            if (!projectFolder) {
                await this.app.vault.createFolder(this.settings.projectFolder);
            }

            // Check if destination already exists
            const existing = this.app.vault.getAbstractFileByPath(restorePath);
            if (existing) {
                new Notice(`Cannot restore: "${project.name}" already exists in projects`);
                return;
            }

            // Move project folder back
            await this.app.vault.rename(project.folder, restorePath);

            // Add back to priorities (with emoji from frontmatter if available)
            const emoji = this.getProjectEmoji(project);
            await this.addToPriorities(project.name, 'Additional', emoji);

            new Notice(`Restored project: ${project.name}`);
        } catch (error) {
            console.error('Failed to restore project:', error);
            new Notice(`Failed to restore project: ${error.message}`);
        }
    }

    async showRestoreProjectModal(): Promise<void> {
        const archivedProjects = this.getArchivedProjects();

        if (archivedProjects.length === 0) {
            new Notice('No archived projects found');
            return;
        }

        new RestoreProjectModal(this.app, this, archivedProjects).open();
    }

    async renameProject(project: ProjectInfo, newName: string, newEmoji?: string, updateLinks: boolean = true): Promise<void> {
        try {
            const oldPath = project.path;
            const newPath = `${this.settings.projectFolder}/${newName}`;

            // Check if destination already exists
            if (oldPath !== newPath) {
                const existing = this.app.vault.getAbstractFileByPath(newPath);
                if (existing) {
                    new Notice(`Cannot rename: "${newName}" already exists`);
                    return;
                }
            }

            const oldName = project.name;

            // Update links throughout the vault before renaming
            if (updateLinks && oldName !== newName) {
                await this.updateLinksInVault(oldName, newName);
            }

            // Rename the folder
            if (oldPath !== newPath) {
                await this.app.vault.rename(project.folder, newPath);
            }

            // Rename main file if it exists
            const oldMainFilePath = `${newPath}/${oldName}.md`;
            const newMainFilePath = `${newPath}/${newName}.md`;
            const mainFile = this.app.vault.getAbstractFileByPath(oldMainFilePath);
            if (mainFile instanceof TFile && oldMainFilePath !== newMainFilePath) {
                await this.app.vault.rename(mainFile, newMainFilePath);
            }

            // Update frontmatter title and emoji
            const renamedMainFile = this.app.vault.getAbstractFileByPath(newMainFilePath);
            if (renamedMainFile instanceof TFile) {
                await this.updateFrontmatter(renamedMainFile, {
                    title: newName,
                    emoji: newEmoji || null
                });
            }

            new Notice(`Renamed project to: ${newName}`);
        } catch (error) {
            console.error('Failed to rename project:', error);
            new Notice(`Failed to rename project: ${error.message}`);
        }
    }

    async updateLinksInVault(oldName: string, newName: string): Promise<void> {
        const files = this.app.vault.getMarkdownFiles();
        const escapedOldName = this.escapeRegex(oldName);

        // Patterns to match various link formats
        const patterns = [
            // [[OldName]]
            new RegExp(`\\[\\[${escapedOldName}\\]\\]`, 'g'),
            // [[OldName|alias]]
            new RegExp(`\\[\\[${escapedOldName}\\|([^\\]]+)\\]\\]`, 'g'),
            // [[OldName/subpath]]
            new RegExp(`\\[\\[${escapedOldName}/([^\\]|]+)\\]\\]`, 'g'),
            // [[OldName/subpath|alias]]
            new RegExp(`\\[\\[${escapedOldName}/([^\\]|]+)\\|([^\\]]+)\\]\\]`, 'g')
        ];

        for (const file of files) {
            let content = await this.app.vault.read(file);
            let modified = false;

            // Replace simple links
            const newContent1 = content.replace(patterns[0], `[[${newName}]]`);
            if (newContent1 !== content) {
                content = newContent1;
                modified = true;
            }

            // Replace aliased links
            const newContent2 = content.replace(patterns[1], `[[${newName}|$1]]`);
            if (newContent2 !== content) {
                content = newContent2;
                modified = true;
            }

            // Replace subpath links
            const newContent3 = content.replace(patterns[2], `[[${newName}/$1]]`);
            if (newContent3 !== content) {
                content = newContent3;
                modified = true;
            }

            // Replace subpath aliased links
            const newContent4 = content.replace(patterns[3], `[[${newName}/$1|$2]]`);
            if (newContent4 !== content) {
                content = newContent4;
                modified = true;
            }

            if (modified) {
                await this.app.vault.modify(file, content);
            }
        }
    }

    async updateFrontmatter(file: TFile, updates: Record<string, any>): Promise<void> {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            for (const [key, value] of Object.entries(updates)) {
                if (value === null || value === undefined) {
                    delete frontmatter[key];
                } else {
                    frontmatter[key] = value;
                }
            }
        });
    }

    async showRenameProjectModal(): Promise<void> {
        const currentProject = this.getCurrentProject();
        if (currentProject) {
            new RenameProjectModal(this.app, this, currentProject).open();
            return;
        }

        // Not in a project, show picker first
        const projects = this.getAllProjects();
        if (projects.length === 0) {
            new Notice('No projects found');
            return;
        }

        new ProjectPickerModal(this.app, projects, 'Select project to rename', (project) => {
            new RenameProjectModal(this.app, this, project).open();
        }).open();
    }

    async duplicateProject(project: ProjectInfo, newName: string, newEmoji?: string, clearTasks: boolean = false): Promise<void> {
        try {
            const newPath = `${this.settings.projectFolder}/${newName}`;

            // Check if destination already exists
            const existing = this.app.vault.getAbstractFileByPath(newPath);
            if (existing) {
                new Notice(`Cannot duplicate: "${newName}" already exists`);
                return;
            }

            // Create new folder
            await this.app.vault.createFolder(newPath);

            // Copy all files from source to destination
            await this.copyFolderContents(project.folder, newPath, project.name, newName, clearTasks);

            // Update emoji in frontmatter of the new main file
            const newMainFilePath = `${newPath}/${newName}.md`;
            const newMainFile = this.app.vault.getAbstractFileByPath(newMainFilePath);
            if (newMainFile instanceof TFile) {
                await this.updateFrontmatter(newMainFile, { emoji: newEmoji || null });
            }

            // Add to priorities
            await this.addToPriorities(newName, 'Additional', newEmoji);

            // Open the new main file
            if (newMainFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(newMainFile);
            }

            new Notice(`Duplicated project as: ${newName}`);
        } catch (error) {
            console.error('Failed to duplicate project:', error);
            new Notice(`Failed to duplicate project: ${error.message}`);
        }
    }

    async copyFolderContents(
        sourceFolder: TFolder,
        destPath: string,
        oldName: string,
        newName: string,
        clearTasks: boolean
    ): Promise<void> {
        for (const child of sourceFolder.children) {
            if (child instanceof TFile) {
                // Determine new filename (rename main file to match new project name)
                let newFileName = child.name;
                if (child.name === `${oldName}.md`) {
                    newFileName = `${newName}.md`;
                }

                const newFilePath = `${destPath}/${newFileName}`;
                let content = await this.app.vault.read(child);

                // Update internal references to the old project name
                content = content.replace(
                    new RegExp(this.escapeRegex(oldName), 'g'),
                    newName
                );

                // Clear tasks if requested (replace [ ] and [x] with [ ])
                if (clearTasks) {
                    content = content.replace(/- \[x\]/g, '- [ ]');
                }

                await this.app.vault.create(newFilePath, content);

                // Update frontmatter for main file
                if (newFileName === `${newName}.md`) {
                    const newFile = this.app.vault.getAbstractFileByPath(newFilePath);
                    if (newFile instanceof TFile) {
                        await this.updateFrontmatter(newFile, {
                            title: newName,
                            created: new Date().toISOString().split('T')[0],
                            status: 'active'
                        });
                    }
                }
            } else if (child instanceof TFolder) {
                // Recursively copy subfolders
                const newSubfolderPath = `${destPath}/${child.name}`;
                await this.app.vault.createFolder(newSubfolderPath);
                await this.copyFolderContents(child, newSubfolderPath, oldName, newName, clearTasks);
            }
        }
    }

    async showDuplicateProjectModal(): Promise<void> {
        const currentProject = this.getCurrentProject();
        if (currentProject) {
            new DuplicateProjectModal(this.app, this, currentProject).open();
            return;
        }

        // Not in a project, show picker first
        const projects = this.getAllProjects();
        if (projects.length === 0) {
            new Notice('No projects found');
            return;
        }

        new ProjectPickerModal(this.app, projects, 'Select project to duplicate', (project) => {
            new DuplicateProjectModal(this.app, this, project).open();
        }).open();
    }

    async showEditMetadataModal(): Promise<void> {
        const currentProject = this.getCurrentProject();
        if (currentProject) {
            new EditProjectMetadataModal(this.app, this, currentProject).open();
            return;
        }

        // Not in a project, show picker first
        const projects = this.getAllProjects();
        if (projects.length === 0) {
            new Notice('No projects found');
            return;
        }

        new ProjectPickerModal(this.app, projects, 'Select project to edit', (project) => {
            new EditProjectMetadataModal(this.app, this, project).open();
        }).open();
    }

    async parsePrioritiesFile(): Promise<DashboardData | null> {
        const prioritiesFile = this.app.vault.getAbstractFileByPath(this.settings.prioritiesFile);
        if (!(prioritiesFile instanceof TFile)) return null;

        const content = await this.app.vault.read(prioritiesFile);
        const allProjects = this.getAllProjects();
        const projectsByName = new Map<string, ProjectInfo>();
        for (const p of allProjects) {
            projectsByName.set(p.name, p);
        }

        const sections: PrioritySection[] = [];
        let currentSection: PrioritySection | null = null;
        let currentSubsection: { name: string; entries: PriorityEntry[] } | null = null;
        const foundProjectNames = new Set<string>();

        const linkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/;

        for (const line of content.split('\n')) {
            // Stop at --- separator
            if (line.trim() === '---') break;

            // Section header (## ...)
            const sectionMatch = line.match(/^## (.+)$/);
            if (sectionMatch) {
                // Flush current subsection into current section
                if (currentSection && currentSubsection) {
                    currentSection.orderedItems.push({
                        type: 'subsection',
                        subsection: currentSubsection
                    });
                    currentSubsection = null;
                }
                currentSection = { name: sectionMatch[1], orderedItems: [] };
                sections.push(currentSection);
                continue;
            }

            // Subsection header (### ...)
            const subsectionMatch = line.match(/^### (.+)$/);
            if (subsectionMatch) {
                if (!currentSection) continue;
                // Flush previous subsection
                if (currentSubsection) {
                    currentSection.orderedItems.push({
                        type: 'subsection',
                        subsection: currentSubsection
                    });
                }
                currentSubsection = { name: subsectionMatch[1], entries: [] };
                continue;
            }

            // Entry line (- emoji [[link]])
            const linkMatch = line.match(linkRegex);
            if (linkMatch && currentSection) {
                const projectName = linkMatch[1];
                const alias = linkMatch[2] || null;
                // Extract emoji: text before [[ on the line, strip leading "- "
                const beforeLink = line.substring(0, line.indexOf('[['));
                const emojiPart = beforeLink.replace(/^-\s*/, '').trim();

                const project = projectsByName.get(projectName) || null;
                let frontmatter: Record<string, any> | null = null;
                if (project?.mainFile) {
                    const cache = this.app.metadataCache.getFileCache(project.mainFile);
                    frontmatter = cache?.frontmatter ? { ...cache.frontmatter } : null;
                }

                const entry: PriorityEntry = {
                    projectName,
                    emoji: frontmatter?.emoji || emojiPart,
                    alias,
                    project,
                    frontmatter
                };

                foundProjectNames.add(projectName);

                if (currentSubsection) {
                    currentSubsection.entries.push(entry);
                } else {
                    currentSection.orderedItems.push({ type: 'entry', entry });
                }
            }
        }

        // Flush final subsection
        if (currentSection && currentSubsection) {
            currentSection.orderedItems.push({
                type: 'subsection',
                subsection: currentSubsection
            });
        }

        // Compute unlisted projects (have #project-page but not in priorities)
        const taggedProjects = this.getProjectsWithTag();
        const unlisted = taggedProjects.filter(p => !foundProjectNames.has(p.name));

        return { sections, unlisted };
    }

    async writePrioritiesFile(data: DashboardData): Promise<void> {
        const prioritiesFile = this.app.vault.getAbstractFileByPath(this.settings.prioritiesFile);
        if (!(prioritiesFile instanceof TFile)) {
            new Notice('Priorities file not found');
            return;
        }

        const currentContent = await this.app.vault.read(prioritiesFile);

        // Find first --- separator and preserve everything from there onward
        const separatorIndex = currentContent.indexOf('\n---');
        const suffix = separatorIndex >= 0 ? currentContent.substring(separatorIndex) : '';

        // Rebuild section content
        const lines: string[] = [];

        for (const section of data.sections) {
            lines.push(`## ${section.name}`);

            for (const item of section.orderedItems) {
                if (item.type === 'subsection') {
                    lines.push(`### ${item.subsection.name}`);
                    for (const entry of item.subsection.entries) {
                        lines.push(this.formatPriorityEntry(entry));
                    }
                } else {
                    lines.push(this.formatPriorityEntry(item.entry));
                }
            }

            lines.push('');
        }

        const newContent = lines.join('\n') + suffix;
        await this.app.vault.modify(prioritiesFile, newContent);
    }

    private formatPriorityEntry(entry: PriorityEntry): string {
        const emojiPart = entry.emoji ? `${entry.emoji} ` : '';
        const linkPart = entry.alias
            ? `[[${entry.projectName}|${entry.alias}]]`
            : `[[${entry.projectName}]]`;
        return `- ${emojiPart}${linkPart}`;
    }
}


function formatRelativeTime(timestamp: number): string {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 14) return `${days}d`;
    const weeks = Math.floor(days / 7);
    if (weeks < 8) return `${weeks}w`;
    const months = Math.floor(days / 30);
    return `${months}mo`;
}

function countSectionEntries(section: PrioritySection): number {
    let count = 0;
    for (const item of section.orderedItems) {
        if (item.type === 'entry') count++;
        else count += item.subsection.entries.length;
    }
    return count;
}

const SECTION_STATUS_MAP: Record<string, string> = {
    'Active': 'active',
    'Coming Soon': 'coming-soon',
    'Deferred Effort': 'deferred',
    'On Hold': 'on-hold',
};

class ProjectDashboardView extends ItemView {
    plugin: ProjectControlPlugin;
    data: DashboardData | null = null;
    bodyEl: HTMLElement;
    dragState: {
        sourceSectionIndex: number;
        sourceEntry: PriorityEntry;
    } | null = null;
    private dragActive = false;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(leaf: WorkspaceLeaf, plugin: ProjectControlPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    private toggleCollapsed(key: string, collapsed: boolean): void {
        const arr = this.plugin.settings.collapsedSections;
        const idx = arr.indexOf(key);
        if (collapsed && idx < 0) {
            arr.push(key);
        } else if (!collapsed && idx >= 0) {
            arr.splice(idx, 1);
        }
        this.plugin.saveSettings();
    }

    private enqueueWrite(fn: () => Promise<void>): void {
        this.writeQueue = this.writeQueue.then(fn).catch(err => {
            console.error('Dashboard write failed:', err);
            new Notice('Failed to save changes');
        });
    }

    getViewType() { return DASHBOARD_VIEW_TYPE; }
    getDisplayText() { return 'Project Dashboard'; }
    getIcon() { return 'layout-dashboard'; }

    async onOpen() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('project-dashboard-view');

        // Header
        const header = container.createDiv({ cls: 'pd-header' });
        header.createEl('h2', { text: 'Project Dashboard' });
        const toolbar = header.createDiv({ cls: 'pd-toolbar' });

        const loadBtn = toolbar.createEl('button', { text: 'Reload', cls: 'pd-btn' });
        loadBtn.addEventListener('click', () => this.loadData());

        const newBtn = toolbar.createEl('button', { text: 'New Project', cls: 'pd-btn pd-btn-cta' });
        newBtn.addEventListener('click', () => this.createNewProject());

        // Body
        this.bodyEl = container.createDiv({ cls: 'pd-body' });

        await this.loadData();
    }

    async loadData() {
        if (this.dragActive) return;
        await this.writeQueue;
        this.data = await this.plugin.parsePrioritiesFile();
        if (!this.data) {
            this.bodyEl.empty();
            this.bodyEl.createEl('p', { text: 'Could not load priorities file.' });
            return;
        }
        this.renderSections();
    }

    renderSections() {
        this.bodyEl.empty();
        if (!this.data) return;

        for (let si = 0; si < this.data.sections.length; si++) {
            this.renderSection(this.data.sections[si], si);
        }

        if (this.data.unlisted.length > 0) {
            this.renderUnlistedSection();
        }
    }

    renderSection(section: PrioritySection, sectionIndex: number) {
        const sectionEl = this.bodyEl.createDiv({ cls: 'pd-section' });
        const count = countSectionEntries(section);

        const collapseKey = `section:${section.name}`;
        const isCollapsed = this.plugin.settings.collapsedSections.includes(collapseKey);

        const headerEl = sectionEl.createDiv({ cls: 'pd-section-header' });
        const collapseIcon = headerEl.createSpan({ cls: 'pd-collapse-icon', text: isCollapsed ? '\u25B6' : '\u25BC' });
        headerEl.createSpan({ text: `${section.name} (${count})` });

        const itemsEl = sectionEl.createDiv({ cls: 'pd-section-items' });
        if (isCollapsed) itemsEl.style.display = 'none';

        // Section-level drop zone for cross-section drag
        itemsEl.addEventListener('dragover', (e) => {
            if (!this.dragState) return;
            e.preventDefault();
        });
        itemsEl.addEventListener('drop', (e) => {
            if (!this.dragState || !this.data) return;
            // Only handle if not dropped on a specific entry (let entry handler take it)
            if ((e.target as HTMLElement).closest('.pd-entry')) return;
            e.preventDefault();
            this.bodyEl.querySelectorAll('.pd-drop-indicator').forEach(el => el.remove());

            const draggedEntry = this.dragState.sourceEntry;
            const fromSectionIdx = this.dragState.sourceSectionIndex;

            this.removeEntryFromSection(this.data!.sections[fromSectionIdx], draggedEntry);
            section.orderedItems.push({ type: 'entry', entry: draggedEntry });

            this.renderSections();

            this.enqueueWrite(async () => {
                await this.plugin.writePrioritiesFile(this.data!);
                if (draggedEntry.project?.mainFile) {
                    const updates: Record<string, any> = { 'priority-group': null };
                    if (fromSectionIdx !== sectionIndex) {
                        const newStatus = SECTION_STATUS_MAP[section.name];
                        if (newStatus) updates.status = newStatus;
                    }
                    await this.plugin.updateFrontmatter(draggedEntry.project.mainFile, updates);
                }
            });
        });

        headerEl.addEventListener('click', () => {
            const collapsed = itemsEl.style.display === 'none';
            itemsEl.style.display = collapsed ? '' : 'none';
            collapseIcon.textContent = collapsed ? '\u25BC' : '\u25B6';
            this.toggleCollapsed(collapseKey, !collapsed);
        });

        // Collect consecutive top-level entries for category grouping
        let topLevelBatch: PriorityEntry[] = [];

        for (let ii = 0; ii < section.orderedItems.length; ii++) {
            const item = section.orderedItems[ii];
            if (item.type === 'subsection') {
                if (topLevelBatch.length > 0) {
                    this.renderEntryList(itemsEl, topLevelBatch, section, sectionIndex);
                    topLevelBatch = [];
                }
                const subItem = item;
                const subEl = itemsEl.createDiv({ cls: 'pd-subsection' });
                subEl.createDiv({ cls: 'pd-subsection-label', text: subItem.subsection.name });
                this.renderEntryList(subEl, subItem.subsection.entries, section, sectionIndex);

                // Drop zone for dragging into this subsection
                const dropZone = subEl.createDiv({
                    cls: 'pd-subsection-dropzone',
                    text: subItem.subsection.entries.length === 0 ? 'Drop here' : ''
                });
                dropZone.addEventListener('dragover', (e) => {
                    if (!this.dragState) return;
                    e.preventDefault();
                    e.stopPropagation();
                    dropZone.addClass('pd-dropzone-active');
                    this.bodyEl.querySelectorAll('.pd-drop-indicator').forEach(el => el.remove());
                });
                dropZone.addEventListener('dragleave', (e) => {
                    if (dropZone.contains(e.relatedTarget as Node)) return;
                    dropZone.removeClass('pd-dropzone-active');
                });
                dropZone.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropZone.removeClass('pd-dropzone-active');
                    this.bodyEl.querySelectorAll('.pd-drop-indicator').forEach(el => el.remove());
                    if (!this.dragState || !this.data) return;

                    const draggedEntry = this.dragState.sourceEntry;
                    const fromSectionIdx = this.dragState.sourceSectionIndex;

                    this.removeEntryFromSection(this.data!.sections[fromSectionIdx], draggedEntry);
                    subItem.subsection.entries.push(draggedEntry);

                    this.renderSections();

                    this.enqueueWrite(async () => {
                        await this.plugin.writePrioritiesFile(this.data!);
                        if (draggedEntry.project?.mainFile) {
                            const updates: Record<string, any> = { 'priority-group': subItem.subsection.name };
                            if (fromSectionIdx !== sectionIndex) {
                                const newStatus = SECTION_STATUS_MAP[section.name];
                                if (newStatus) updates.status = newStatus;
                            }
                            await this.plugin.updateFrontmatter(draggedEntry.project.mainFile, updates);
                        }
                    });
                });
            } else {
                topLevelBatch.push(item.entry);
            }
        }

        if (topLevelBatch.length > 0) {
            this.renderEntryList(itemsEl, topLevelBatch, section, sectionIndex);
        }
    }

    renderEntryList(
        container: HTMLElement,
        entries: PriorityEntry[],
        section: PrioritySection,
        sectionIndex: number
    ) {
        // Count entries per category
        const catCounts = new Map<string, number>();
        for (const e of entries) {
            const cat = e.frontmatter?.category || '';
            catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
        }

        const renderedCategories = new Set<string>();

        for (const entry of entries) {
            const cat = entry.frontmatter?.category || '';
            const count = catCounts.get(cat) || 0;

            if (cat && count > 1) {
                if (!renderedCategories.has(cat)) {
                    renderedCategories.add(cat);
                    const groupEntries = entries.filter(e => (e.frontmatter?.category || '') === cat);

                    const catCollapseKey = `category:${section.name}::${cat}`;
                    const catIsCollapsed = this.plugin.settings.collapsedSections.includes(catCollapseKey);

                    const groupEl = container.createDiv({ cls: 'pd-category-group' });
                    const groupHeader = groupEl.createDiv({ cls: 'pd-category-group-header' });
                    const groupCollapseIcon = groupHeader.createSpan({ cls: 'pd-collapse-icon', text: catIsCollapsed ? '\u25B6' : '\u25BC' });
                    groupHeader.createSpan({ text: `${cat} (${groupEntries.length})` });

                    const groupItems = groupEl.createDiv({ cls: 'pd-category-group-items' });
                    if (catIsCollapsed) groupItems.style.display = 'none';
                    groupHeader.addEventListener('click', () => {
                        const collapsed = groupItems.style.display === 'none';
                        groupItems.style.display = collapsed ? '' : 'none';
                        groupCollapseIcon.textContent = collapsed ? '\u25BC' : '\u25B6';
                        this.toggleCollapsed(catCollapseKey, !collapsed);
                    });

                    for (const ge of groupEntries) {
                        this.renderEntry(groupItems, ge, section, sectionIndex, false);
                    }
                }
            } else {
                this.renderEntry(container, entry, section, sectionIndex, true);
            }
        }
    }

    renderEntry(
        container: HTMLElement,
        entry: PriorityEntry,
        section: PrioritySection,
        sectionIndex: number,
        showInlineCategory: boolean
    ) {
        const row = container.createDiv({ cls: 'pd-entry' });
        if (!entry.project) row.addClass('pd-phantom');

        row.setAttribute('draggable', 'true');
        row.dataset.sectionIndex = String(sectionIndex);

        // Drag handle
        row.createSpan({ cls: 'pd-drag-handle', text: '\u2807' });

        // Emoji
        if (entry.emoji) {
            row.createSpan({ cls: 'pd-emoji', text: entry.emoji });
        }

        // Name (clickable)
        const nameEl = row.createSpan({
            cls: 'pd-name',
            text: entry.alias || entry.projectName
        });
        nameEl.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openProject(entry);
        });

        // Right-aligned group for consistent alignment
        const rightGroup = row.createDiv({ cls: 'pd-right-group' });

        // Category (inline only if single-entry category)
        const category = entry.frontmatter?.category;
        if (showInlineCategory && category) {
            rightGroup.createSpan({ cls: 'pd-category', text: category });
        } else {
            rightGroup.createSpan({ cls: 'pd-category' });
        }

        // Status badge from frontmatter
        const status = entry.frontmatter?.status || 'active';
        const badge = rightGroup.createSpan({ cls: `pd-status pd-status-${status}`, text: status });
        badge.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showStatusMenu(badge, entry, sectionIndex);
        });

        // Last modified (always present for alignment)
        const mtime = entry.project?.mainFile ? entry.project.mainFile.stat.mtime : 0;
        rightGroup.createSpan({ cls: 'pd-mtime', text: formatRelativeTime(mtime) });

        // Context menu button
        const menuBtn = rightGroup.createSpan({ cls: 'pd-menu-btn', text: '\u2026' });
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showContextMenu(menuBtn, entry, sectionIndex);
        });

        this.setupDragEvents(row, entry, sectionIndex);
    }

    private setupDragEvents(row: HTMLElement, entry: PriorityEntry, sectionIndex: number) {
        row.addEventListener('dragstart', (e) => {
            row.addClass('pd-dragging');
            e.dataTransfer?.setData('text/plain', '');
            this.dragActive = true;
            this.dragState = {
                sourceSectionIndex: sectionIndex,
                sourceEntry: entry
            };
        });

        row.addEventListener('dragend', () => {
            row.removeClass('pd-dragging');
            this.bodyEl.querySelectorAll('.pd-drop-indicator').forEach(el => el.remove());
            this.dragActive = false;
            this.dragState = null;
        });

        row.addEventListener('dragover', (e) => {
            if (!this.dragState) return;
            e.preventDefault();
            e.stopPropagation();
            this.bodyEl.querySelectorAll('.pd-drop-indicator').forEach(el => el.remove());
            const rect = row.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const indicator = document.createElement('div');
            indicator.className = 'pd-drop-indicator';
            if (e.clientY < midY) {
                row.insertAdjacentElement('beforebegin', indicator);
            } else {
                row.insertAdjacentElement('afterend', indicator);
            }
        });

        row.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.bodyEl.querySelectorAll('.pd-drop-indicator').forEach(el => el.remove());
            if (!this.dragState || !this.data) return;

            const draggedEntry = this.dragState.sourceEntry;
            const fromSectionIdx = this.dragState.sourceSectionIndex;
            const fromSection = this.data.sections[fromSectionIdx];
            const toSection = this.data.sections[sectionIndex];

            const rect = row.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const insertBefore = e.clientY < midY;

            this.removeEntryFromSection(fromSection, draggedEntry);
            this.insertEntryNearTarget(toSection, draggedEntry, entry, insertBefore);

            this.renderSections();

            this.enqueueWrite(async () => {
                await this.plugin.writePrioritiesFile(this.data!);
                if (draggedEntry.project?.mainFile) {
                    const updates: Record<string, any> = {};
                    let targetGroup: string | null = null;
                    for (const item of toSection.orderedItems) {
                        if (item.type === 'subsection' && item.subsection.entries.includes(draggedEntry)) {
                            targetGroup = item.subsection.name;
                            break;
                        }
                    }
                    updates['priority-group'] = targetGroup;
                    if (fromSectionIdx !== sectionIndex) {
                        const newStatus = SECTION_STATUS_MAP[toSection.name];
                        if (newStatus) updates.status = newStatus;
                    }
                    await this.plugin.updateFrontmatter(draggedEntry.project.mainFile, updates);
                }
            });
        });
    }

    private removeEntryFromSection(section: PrioritySection, entry: PriorityEntry) {
        for (let i = 0; i < section.orderedItems.length; i++) {
            const item = section.orderedItems[i];
            if (item.type === 'entry' && item.entry === entry) {
                section.orderedItems.splice(i, 1);
                return;
            }
            if (item.type === 'subsection') {
                const idx = item.subsection.entries.indexOf(entry);
                if (idx >= 0) {
                    item.subsection.entries.splice(idx, 1);
                    return;
                }
            }
        }
    }

    private insertEntryNearTarget(
        section: PrioritySection,
        newEntry: PriorityEntry,
        targetEntry: PriorityEntry,
        insertBefore: boolean
    ) {
        for (let i = 0; i < section.orderedItems.length; i++) {
            const item = section.orderedItems[i];
            if (item.type === 'entry' && item.entry === targetEntry) {
                const idx = insertBefore ? i : i + 1;
                section.orderedItems.splice(idx, 0, { type: 'entry', entry: newEntry });
                return;
            }
            if (item.type === 'subsection') {
                const subIdx = item.subsection.entries.indexOf(targetEntry);
                if (subIdx >= 0) {
                    const idx = insertBefore ? subIdx : subIdx + 1;
                    item.subsection.entries.splice(idx, 0, newEntry);
                    return;
                }
            }
        }
        section.orderedItems.push({ type: 'entry', entry: newEntry });
    }

    renderUnlistedSection() {
        if (!this.data) return;
        const collapseKey = 'section:Not in Priorities';
        const isCollapsed = this.plugin.settings.collapsedSections.includes(collapseKey);

        const sectionEl = this.bodyEl.createDiv({ cls: 'pd-section' });

        const headerEl = sectionEl.createDiv({ cls: 'pd-section-header' });
        const collapseIcon = headerEl.createSpan({ cls: 'pd-collapse-icon', text: isCollapsed ? '\u25B6' : '\u25BC' });
        headerEl.createSpan({ text: `Not in Priorities (${this.data.unlisted.length})` });

        const itemsEl = sectionEl.createDiv({ cls: 'pd-section-items' });
        if (isCollapsed) itemsEl.style.display = 'none';

        headerEl.addEventListener('click', () => {
            const collapsed = itemsEl.style.display === 'none';
            itemsEl.style.display = collapsed ? '' : 'none';
            collapseIcon.textContent = collapsed ? '\u25BC' : '\u25B6';
            this.toggleCollapsed(collapseKey, !collapsed);
        });

        for (const project of this.data.unlisted) {
            const row = itemsEl.createDiv({ cls: 'pd-entry pd-unlisted' });

            row.createSpan({ cls: 'pd-name', text: project.name })
                .addEventListener('click', () => {
                    if (project.mainFile) {
                        this.app.workspace.getLeaf('tab').openFile(project.mainFile);
                    }
                });

            const rightGroup = row.createDiv({ cls: 'pd-right-group' });
            rightGroup.createSpan({ cls: 'pd-category' });

            if (project.mainFile) {
                const cache = this.app.metadataCache.getFileCache(project.mainFile);
                const status = cache?.frontmatter?.status || 'active';
                rightGroup.createSpan({ cls: `pd-status pd-status-${status}`, text: status });
                rightGroup.createSpan({ cls: 'pd-mtime', text: formatRelativeTime(project.mainFile.stat.mtime) });
            } else {
                rightGroup.createSpan({ cls: 'pd-status' });
                rightGroup.createSpan({ cls: 'pd-mtime' });
            }

            const addBtn = rightGroup.createSpan({ cls: 'pd-menu-btn', text: '+' });
            addBtn.style.opacity = '1';
            addBtn.addEventListener('click', async () => {
                const emoji = this.plugin.getProjectEmoji(project);
                await this.plugin.addToPriorities(project.name, 'Additional', emoji);
                await this.loadData();
            });
        }
    }

    async openProject(entry: PriorityEntry) {
        if (entry.project?.mainFile) {
            this.app.workspace.getLeaf('tab').openFile(entry.project.mainFile);
        } else {
            // Phantom entry: create project folder and file
            const name = entry.projectName;
            const emoji = entry.emoji;
            const projectPath = `${this.plugin.settings.projectFolder}/${name}`;
            const mainFilePath = `${projectPath}/${name}.md`;

            try {
                const existing = this.app.vault.getAbstractFileByPath(projectPath);
                if (existing) {
                    new Notice(`Folder already exists: ${name}`);
                    return;
                }

                await this.app.vault.createFolder(projectPath);

                const emojiLine = emoji ? `emoji: "${emoji}"\n` : '';
                const content = `---\ntitle: "${name}"\ncreated: ${new Date().toISOString().split('T')[0]}\ntags:\n  - project-page\n${emojiLine}status: active\ncategory:\npriority:\n---\n\n# ${name}\n\n`;
                await this.app.vault.create(mainFilePath, content);

                const file = this.app.vault.getAbstractFileByPath(mainFilePath);
                if (file instanceof TFile) {
                    this.app.workspace.getLeaf('tab').openFile(file);
                }

                new Notice(`Created project: ${name}`);
                setTimeout(() => {
                    if (!this.dragActive) this.loadData();
                }, 500);
            } catch (error: any) {
                console.error('Failed to create project:', error);
                new Notice(`Failed to create project: ${error.message}`);
            }
        }
    }

    showStatusMenu(targetEl: HTMLElement, entry: PriorityEntry, sectionIndex: number) {
        if (!entry.project) return;
        const menu = new Menu();
        const statuses: { value: string; label: string; targetSection: string }[] = [
            { value: 'active', label: 'Active', targetSection: 'Active' },
            { value: 'coming-soon', label: 'Coming Soon', targetSection: 'Coming Soon' },
            { value: 'deferred', label: 'Deferred', targetSection: 'Deferred Effort' },
            { value: 'on-hold', label: 'On Hold', targetSection: 'On Hold' },
        ];

        for (const s of statuses) {
            menu.addItem(item => {
                item.setTitle(s.label);
                item.onClick(() => {
                    if (!this.data) return;

                    // Move entry between sections in memory if needed
                    if (s.targetSection) {
                        const toIdx = this.data.sections.findIndex(sec => sec.name === s.targetSection);
                        if (toIdx >= 0 && toIdx !== sectionIndex) {
                            this.removeEntryFromSection(this.data.sections[sectionIndex], entry);
                            this.data.sections[toIdx].orderedItems.push({ type: 'entry', entry });
                        }
                    }

                    // Update cached frontmatter for immediate UI feedback
                    if (entry.frontmatter) {
                        entry.frontmatter.status = s.value;
                    }

                    this.renderSections();

                    this.enqueueWrite(async () => {
                        await this.plugin.writePrioritiesFile(this.data!);
                        if (entry.project?.mainFile) {
                            await this.plugin.updateFrontmatter(entry.project.mainFile, { status: s.value });
                        }
                    });
                });
            });
        }

        menu.addSeparator();

        menu.addItem(item => {
            item.setTitle('Archive (Complete)');
            item.onClick(async () => {
                if (!entry.project) return;
                await this.plugin.archiveProject(entry.project);
                await this.loadData();
            });
        });

        const rect = targetEl.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom });
    }

    showContextMenu(
        targetEl: HTMLElement,
        entry: PriorityEntry,
        sectionIndex: number
    ) {
        const menu = new Menu();

        if (entry.project) {
            menu.addItem(item => {
                item.setTitle('Edit Metadata');
                item.onClick(() => {
                    const modal = new EditProjectMetadataModal(this.app, this.plugin, entry.project!);
                    const origOnClose = modal.onClose.bind(modal);
                    modal.onClose = () => {
                        origOnClose();
                        setTimeout(() => {
                            if (!this.dragActive) this.loadData();
                        }, 500);
                    };
                    modal.open();
                });
            });

            menu.addItem(item => {
                item.setTitle('Rename');
                item.onClick(() => {
                    const modal = new RenameProjectModal(this.app, this.plugin, entry.project!);
                    const origOnClose = modal.onClose.bind(modal);
                    modal.onClose = () => {
                        origOnClose();
                        setTimeout(() => {
                            if (!this.dragActive) this.loadData();
                        }, 500);
                    };
                    modal.open();
                });
            });

            menu.addItem(item => {
                item.setTitle('Duplicate');
                item.onClick(() => {
                    const modal = new DuplicateProjectModal(this.app, this.plugin, entry.project!);
                    const origOnClose = modal.onClose.bind(modal);
                    modal.onClose = () => {
                        origOnClose();
                        setTimeout(() => {
                            if (!this.dragActive) this.loadData();
                        }, 500);
                    };
                    modal.open();
                });
            });

            menu.addItem(item => {
                item.setTitle('Archive');
                item.onClick(async () => {
                    await this.plugin.archiveProject(entry.project!);
                    await this.loadData();
                });
            });
        }

        menu.addItem(item => {
            item.setTitle('Remove from Priorities');
            item.onClick(() => {
                if (!this.data) return;
                this.removeEntryFromSection(this.data.sections[sectionIndex], entry);
                this.renderSections();
                this.enqueueWrite(async () => {
                    await this.plugin.writePrioritiesFile(this.data!);
                });
            });
        });

        const rect = targetEl.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom });
    }

    createNewProject() {
        const createModal = new CreateProjectModal(this.app, this.plugin);
        createModal.open();
        const origClose = createModal.onClose.bind(createModal);
        createModal.onClose = () => {
            origClose();
            setTimeout(() => {
                if (!this.dragActive) this.loadData();
            }, 500);
        };
    }

    async onClose() {
        await this.writeQueue;
    }
}

class OpenProjectModal extends FuzzySuggestModal<{ project: ProjectInfo; display: string }> {
    choices: { project: ProjectInfo; display: string }[];

    constructor(app: App, choices: { project: ProjectInfo; display: string }[]) {
        super(app);
        this.choices = choices;
    }

    getItems() {
        return this.choices;
    }

    getItemText(item: { project: ProjectInfo; display: string }) {
        return item.display;
    }

    onChooseItem(item: { project: ProjectInfo; display: string }) {
        if (item.project.mainFile) {
            this.app.workspace.getLeaf().openFile(item.project.mainFile);
        }
    }
}

class ProjectPickerModal extends FuzzySuggestModal<ProjectInfo> {
    projects: ProjectInfo[];
    onSelect: (project: ProjectInfo) => void;

    constructor(app: App, projects: ProjectInfo[], placeholder: string, onSelect: (project: ProjectInfo) => void) {
        super(app);
        this.projects = projects;
        this.onSelect = onSelect;
        this.setPlaceholder(placeholder);
    }

    getItems() {
        return this.projects;
    }

    getItemText(item: ProjectInfo) {
        return item.name;
    }

    onChooseItem(item: ProjectInfo) {
        this.onSelect(item);
    }
}

class ArchiveProjectModal extends FuzzySuggestModal<ProjectInfo> {
    plugin: ProjectControlPlugin;
    projects: ProjectInfo[];

    constructor(app: App, plugin: ProjectControlPlugin, projects: ProjectInfo[]) {
        super(app);
        this.plugin = plugin;
        this.projects = projects;
        this.setPlaceholder('Select a project to archive');
    }

    getItems() {
        return this.projects;
    }

    getItemText(item: ProjectInfo) {
        return item.name;
    }

    async onChooseItem(item: ProjectInfo) {
        await this.plugin.archiveProject(item);
    }
}

class ProjectActionsModal extends Modal {
    plugin: ProjectControlPlugin;
    project: ProjectInfo;

    constructor(app: App, plugin: ProjectControlPlugin, project: ProjectInfo) {
        super(app);
        this.plugin = plugin;
        this.project = project;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: `Project: ${this.project.name}` });

        // Get current status for display
        let currentStatus = 'active';
        if (this.project.mainFile) {
            const cache = this.app.metadataCache.getFileCache(this.project.mainFile);
            currentStatus = cache?.frontmatter?.status || 'active';
        }

        new Setting(contentEl)
            .setName('Open main file')
            .setDesc('Navigate to the project root file')
            .addButton(btn => btn
                .setButtonText('Open')
                .setCta()
                .onClick(() => {
                    if (this.project.mainFile) {
                        this.app.workspace.getLeaf().openFile(this.project.mainFile);
                    }
                    this.close();
                }));

        new Setting(contentEl)
            .setName('Change status')
            .setDesc(`Current: ${currentStatus}`)
            .addButton(btn => btn
                .setButtonText('Change')
                .setCta()
                .onClick(() => {
                    this.close();
                    new QuickStatusModal(this.app, this.plugin, this.project).open();
                }));

        new Setting(contentEl)
            .setName('Open in file explorer')
            .setDesc('Reveal project folder in file explorer')
            .addButton(btn => btn
                .setButtonText('Reveal')
                .onClick(() => {
                    // @ts-ignore - internal API
                    this.app.internalPlugins.plugins['file-explorer']?.instance?.revealInFolder(this.project.folder);
                    this.close();
                }));

        new Setting(contentEl)
            .setName('Add to priorities')
            .setDesc('Add this project to the priorities file')
            .addButton(btn => btn
                .setButtonText('Add')
                .onClick(async () => {
                    const emoji = this.plugin.getProjectEmoji(this.project);
                    await this.plugin.addToPriorities(this.project.name, 'Additional', emoji);
                    new Notice('Added to priorities');
                    this.close();
                }));

        new Setting(contentEl)
            .setName('Remove from priorities')
            .setDesc('Remove this project from the priorities file')
            .addButton(btn => btn
                .setButtonText('Remove')
                .onClick(async () => {
                    await this.plugin.removeFromPriorities(this.project.name);
                    new Notice('Removed from priorities');
                    this.close();
                }));

        new Setting(contentEl)
            .setName('Edit metadata')
            .setDesc('Edit project title, status, and priority')
            .addButton(btn => btn
                .setButtonText('Edit')
                .onClick(() => {
                    this.close();
                    new EditProjectMetadataModal(this.app, this.plugin, this.project).open();
                }));

        new Setting(contentEl)
            .setName('Rename project')
            .setDesc('Rename this project and optionally update links')
            .addButton(btn => btn
                .setButtonText('Rename')
                .onClick(() => {
                    this.close();
                    new RenameProjectModal(this.app, this.plugin, this.project).open();
                }));

        new Setting(contentEl)
            .setName('Duplicate project')
            .setDesc('Create a copy of this project')
            .addButton(btn => btn
                .setButtonText('Duplicate')
                .onClick(() => {
                    this.close();
                    new DuplicateProjectModal(this.app, this.plugin, this.project).open();
                }));

        new Setting(contentEl)
            .setName('Archive project')
            .setDesc('Move this project to the archive folder')
            .addButton(btn => btn
                .setButtonText('Archive')
                .setWarning()
                .onClick(async () => {
                    await this.plugin.archiveProject(this.project);
                    this.close();
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class CreateProjectModal extends Modal {
    plugin: ProjectControlPlugin;
    nameInput: TextComponent;
    emojiInput: TextComponent;

    constructor(app: App, plugin: ProjectControlPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Create New Project' });

        new Setting(contentEl)
            .setName('Project name')
            .setDesc('Enter the name of your new project')
            .addText(text => {
                this.nameInput = text;
                text.setPlaceholder('My Project');
            });

        new Setting(contentEl)
            .setName('Emoji (optional)')
            .setDesc('Add an emoji icon for the project')
            .addText(text => {
                this.emojiInput = text;
                text.setPlaceholder('🎯');
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Create')
                .setCta()
                .onClick(async () => {
                    const name = this.nameInput.getValue().trim();
                    const emoji = this.emojiInput.getValue().trim();

                    if (!name) {
                        new Notice('Please enter a project name');
                        return;
                    }

                    await this.plugin.createProject(name, emoji || undefined);
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => this.close()));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class StaleProjectsModal extends Modal {
    plugin: ProjectControlPlugin;
    staleProjects: { project: ProjectInfo; lastModified: number; reason: string }[];

    constructor(
        app: App,
        plugin: ProjectControlPlugin,
        staleProjects: { project: ProjectInfo; lastModified: number; reason: string }[]
    ) {
        super(app);
        this.plugin = plugin;
        this.staleProjects = staleProjects;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Stale Projects' });
        contentEl.createEl('p', { text: `Found ${this.staleProjects.length} projects that may need attention:` });

        for (const { project, reason } of this.staleProjects) {
            new Setting(contentEl)
                .setName(project.name)
                .setDesc(reason)
                .addButton(btn => btn
                    .setButtonText('Open')
                    .onClick(() => {
                        if (project.mainFile) {
                            this.app.workspace.getLeaf().openFile(project.mainFile);
                        }
                        this.close();
                    }))
                .addButton(btn => btn
                    .setButtonText('Archive')
                    .setWarning()
                    .onClick(async () => {
                        await this.plugin.archiveProject(project);
                        // Remove from list
                        const idx = this.staleProjects.findIndex(p => p.project === project);
                        if (idx > -1) {
                            this.staleProjects.splice(idx, 1);
                        }
                        this.onOpen(); // Refresh
                    }));
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class RestoreProjectModal extends FuzzySuggestModal<ProjectInfo> {
    plugin: ProjectControlPlugin;
    projects: ProjectInfo[];

    constructor(app: App, plugin: ProjectControlPlugin, projects: ProjectInfo[]) {
        super(app);
        this.plugin = plugin;
        this.projects = projects;
        this.setPlaceholder('Select a project to restore');
    }

    getItems() {
        return this.projects;
    }

    getItemText(item: ProjectInfo) {
        return item.name;
    }

    async onChooseItem(item: ProjectInfo) {
        await this.plugin.restoreProject(item);
    }
}

class RenameProjectModal extends Modal {
    plugin: ProjectControlPlugin;
    project: ProjectInfo;
    nameInput: TextComponent;
    emojiInput: TextComponent;
    updateLinksToggle: boolean = true;

    constructor(app: App, plugin: ProjectControlPlugin, project: ProjectInfo) {
        super(app);
        this.plugin = plugin;
        this.project = project;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: `Rename Project: ${this.project.name}` });

        // Get current emoji from frontmatter
        let currentEmoji = '';
        if (this.project.mainFile) {
            const cache = this.app.metadataCache.getFileCache(this.project.mainFile);
            currentEmoji = cache?.frontmatter?.emoji || '';
        }

        new Setting(contentEl)
            .setName('New name')
            .setDesc('Enter the new name for the project')
            .addText(text => {
                this.nameInput = text;
                text.setValue(this.project.name);
                text.setPlaceholder('Project Name');
            });

        new Setting(contentEl)
            .setName('Emoji (optional)')
            .setDesc('Emoji icon for the project')
            .addText(text => {
                this.emojiInput = text;
                text.setValue(currentEmoji);
                text.setPlaceholder('🎯');
            });

        new Setting(contentEl)
            .setName('Update links')
            .setDesc('Update [[links]] throughout the vault to point to the new name')
            .addToggle(toggle => toggle
                .setValue(this.updateLinksToggle)
                .onChange(value => {
                    this.updateLinksToggle = value;
                }));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Rename')
                .setCta()
                .onClick(async () => {
                    const name = this.nameInput.getValue().trim();
                    const emoji = this.emojiInput.getValue().trim();

                    if (!name) {
                        new Notice('Please enter a project name');
                        return;
                    }

                    await this.plugin.renameProject(this.project, name, emoji || undefined, this.updateLinksToggle);
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => this.close()));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class DuplicateProjectModal extends Modal {
    plugin: ProjectControlPlugin;
    project: ProjectInfo;
    nameInput: TextComponent;
    emojiInput: TextComponent;
    clearTasksToggle: boolean = false;

    constructor(app: App, plugin: ProjectControlPlugin, project: ProjectInfo) {
        super(app);
        this.plugin = plugin;
        this.project = project;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: `Duplicate Project: ${this.project.name}` });

        // Get current emoji from frontmatter
        let currentEmoji = '';
        if (this.project.mainFile) {
            const cache = this.app.metadataCache.getFileCache(this.project.mainFile);
            currentEmoji = cache?.frontmatter?.emoji || '';
        }

        new Setting(contentEl)
            .setName('New name')
            .setDesc('Enter the name for the duplicated project')
            .addText(text => {
                this.nameInput = text;
                text.setValue(`${this.project.name} (Copy)`);
                text.setPlaceholder('Project Name');
            });

        new Setting(contentEl)
            .setName('Emoji (optional)')
            .setDesc('Emoji icon for the project')
            .addText(text => {
                this.emojiInput = text;
                text.setValue(currentEmoji);
                text.setPlaceholder('🎯');
            });

        new Setting(contentEl)
            .setName('Clear completed tasks')
            .setDesc('Reset all [x] checkboxes to [ ] in the duplicated project')
            .addToggle(toggle => toggle
                .setValue(this.clearTasksToggle)
                .onChange(value => {
                    this.clearTasksToggle = value;
                }));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Duplicate')
                .setCta()
                .onClick(async () => {
                    const name = this.nameInput.getValue().trim();
                    const emoji = this.emojiInput.getValue().trim();

                    if (!name) {
                        new Notice('Please enter a project name');
                        return;
                    }

                    await this.plugin.duplicateProject(this.project, name, emoji || undefined, this.clearTasksToggle);
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => this.close()));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class EditProjectMetadataModal extends Modal {
    plugin: ProjectControlPlugin;
    project: ProjectInfo;

    constructor(app: App, plugin: ProjectControlPlugin, project: ProjectInfo) {
        super(app);
        this.plugin = plugin;
        this.project = project;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: `Edit Metadata: ${this.project.name}` });

        if (!this.project.mainFile) {
            contentEl.createEl('p', { text: 'No main file found for this project.' });
            return;
        }

        // Get current frontmatter
        const cache = this.app.metadataCache.getFileCache(this.project.mainFile);
        const frontmatter = cache?.frontmatter || {};

        const currentTitle = frontmatter.title || this.project.name;
        const currentStatus = frontmatter.status || 'active';
        const currentPriority = frontmatter.priority || '';
        const currentCategory = frontmatter.category || '';
        const currentPriorityGroup = frontmatter['priority-group'] || '';
        const currentEmoji = frontmatter.emoji || '';

        let titleValue = currentTitle;
        let statusValue = currentStatus;
        let priorityValue = currentPriority;
        let categoryValue = currentCategory;
        let priorityGroupValue = currentPriorityGroup;
        let emojiValue = currentEmoji;
        const originalStatus = currentStatus;
        const originalPriorityGroup = currentPriorityGroup;

        new Setting(contentEl)
            .setName('Title')
            .setDesc('Project title')
            .addText(text => text
                .setValue(currentTitle)
                .onChange(value => {
                    titleValue = value;
                }));

        new Setting(contentEl)
            .setName('Emoji')
            .setDesc('Emoji icon for the project')
            .addText(text => text
                .setValue(currentEmoji)
                .setPlaceholder('🎯')
                .onChange(value => {
                    emojiValue = value;
                }));

        new Setting(contentEl)
            .setName('Status')
            .setDesc('Project status (syncs to priorities file)')
            .addDropdown(dropdown => dropdown
                .addOption('active', 'Active')
                .addOption('coming-soon', 'Coming Soon')
                .addOption('deferred', 'Deferred')
                .addOption('on-hold', 'On Hold')
                .addOption('complete', 'Complete')
                .setValue(currentStatus)
                .onChange(value => {
                    statusValue = value;
                }));

        new Setting(contentEl)
            .setName('Category')
            .setDesc('Project category (e.g., work/zeroedin, ttrpg/fey-fox)')
            .addText(text => text
                .setValue(currentCategory)
                .setPlaceholder('category/subcategory')
                .onChange(value => {
                    categoryValue = value;
                }));

        new Setting(contentEl)
            .setName('Priority Group')
            .setDesc('Subsection in priorities (Foundation, Growth, Recharge)')
            .addDropdown(dropdown => dropdown
                .addOption('', '(none)')
                .addOption('Foundation', 'Foundation')
                .addOption('Growth', 'Growth')
                .addOption('Recharge', 'Recharge')
                .setValue(currentPriorityGroup)
                .onChange(value => {
                    priorityGroupValue = value;
                }));

        new Setting(contentEl)
            .setName('Priority')
            .setDesc('Project priority (e.g., high, medium, low)')
            .addText(text => text
                .setValue(currentPriority)
                .setPlaceholder('high, medium, low')
                .onChange(value => {
                    priorityValue = value;
                }));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Save')
                .setCta()
                .onClick(async () => {
                    if (this.project.mainFile) {
                        await this.plugin.updateFrontmatter(this.project.mainFile, {
                            title: titleValue,
                            status: statusValue,
                            emoji: emojiValue.trim() || null,
                            category: categoryValue || null,
                            priority: priorityValue || null,
                            'priority-group': priorityGroupValue || null
                        });

                        // Sync status change to priorities file
                        if (statusValue !== originalStatus) {
                            await this.plugin.syncProjectStatusToPriorities(this.project, statusValue);
                        }

                        // Sync priority group change to priorities file
                        if (priorityGroupValue !== originalPriorityGroup) {
                            await this.plugin.moveProjectToSubsection(
                                this.project.name,
                                priorityGroupValue || null
                            );
                        }

                        new Notice('Project metadata updated');
                    }
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => this.close()));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class QuickStatusModal extends Modal {
    plugin: ProjectControlPlugin;
    project: ProjectInfo;

    constructor(app: App, plugin: ProjectControlPlugin, project: ProjectInfo) {
        super(app);
        this.plugin = plugin;
        this.project = project;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Change Project Status' });
        contentEl.createEl('p', { text: this.project.name, cls: 'setting-item-description' });

        // Get current status
        let currentStatus = 'active';
        if (this.project.mainFile) {
            const cache = this.app.metadataCache.getFileCache(this.project.mainFile);
            currentStatus = cache?.frontmatter?.status || 'active';
        }

        contentEl.createEl('p', {
            text: `Current status: ${currentStatus}`,
            cls: 'setting-item-description'
        });

        const statusOptions: { value: string; label: string; desc: string }[] = [
            { value: 'active', label: 'Active', desc: 'Actively working on this project' },
            { value: 'coming-soon', label: 'Coming Soon', desc: 'Planned to start soon' },
            { value: 'deferred', label: 'Deferred', desc: 'Postponed for later' },
            { value: 'on-hold', label: 'On Hold', desc: 'Temporarily paused' },
            { value: 'complete', label: 'Complete', desc: 'Finished (will be removed from priorities)' }
        ];

        for (const option of statusOptions) {
            const setting = new Setting(contentEl)
                .setName(option.label)
                .setDesc(option.desc);

            if (option.value === currentStatus) {
                setting.addButton(btn => btn
                    .setButtonText('Current')
                    .setDisabled(true));
            } else {
                setting.addButton(btn => btn
                    .setButtonText('Set')
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.changeProjectStatus(this.project, option.value);
                        this.close();
                    }));
            }
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class ProjectControlSettingTab extends PluginSettingTab {
    plugin: ProjectControlPlugin;

    constructor(app: App, plugin: ProjectControlPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Project Control Settings' });

        new Setting(containerEl)
            .setName('Project folder')
            .setDesc('The folder containing your projects')
            .addText(text => text
                .setPlaceholder('10 - Project')
                .setValue(this.plugin.settings.projectFolder)
                .onChange(async (value) => {
                    this.plugin.settings.projectFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Archive folder')
            .setDesc('The folder for archived projects')
            .addText(text => text
                .setPlaceholder('80 - Archive')
                .setValue(this.plugin.settings.archiveFolder)
                .onChange(async (value) => {
                    this.plugin.settings.archiveFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Priorities file')
            .setDesc('Path to the project priorities file')
            .addText(text => text
                .setPlaceholder('10 - Project/💫 Project Priorities.md')
                .setValue(this.plugin.settings.prioritiesFile)
                .onChange(async (value) => {
                    this.plugin.settings.prioritiesFile = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Stale threshold (days)')
            .setDesc('Projects with no activity for this many days are considered stale')
            .addText(text => text
                .setPlaceholder('30')
                .setValue(String(this.plugin.settings.staleDays))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.staleDays = num;
                        await this.plugin.saveSettings();
                    }
                }));
    }
}
