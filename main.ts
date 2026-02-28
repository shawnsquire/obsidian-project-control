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

import emojiData from './emoji-data.json';

const DASHBOARD_VIEW_TYPE = 'project-dashboard';

interface ProjectControlSettings {
    projectFolder: string;
    archiveFolder: string;
    prioritiesFile: string;
    collapsedSections: string[];
}

const DEFAULT_SETTINGS: ProjectControlSettings = {
    projectFolder: '10 - Project',
    archiveFolder: '80 - Archive',
    prioritiesFile: '10 - Project/💫 Project Priorities.md',
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

        // Go to project page
        this.addCommand({
            id: 'go-to-project-root',
            name: 'Go to Project Page',
            callback: () => this.goToProjectRoot()
        });

        // Create project
        this.addCommand({
            id: 'create-project',
            name: 'Create Project',
            callback: () => new CreateProjectModal(this.app, this).open()
        });

        // Manage project
        this.addCommand({
            id: 'manage-project',
            name: 'Manage Project',
            callback: () => this.showManageProjectModal()
        });

        // Open project priorities file
        this.addCommand({
            id: 'open-project-priorities',
            name: 'Open Project Priorities',
            callback: () => this.openPrioritiesFile()
        });

        // Open project dashboard
        this.addCommand({
            id: 'open-project-dashboard',
            name: 'Open Project Dashboard',
            callback: () => this.activateDashboardView()
        });

        // Move note to project
        this.addCommand({
            id: 'move-note-to-project',
            name: 'Move Note to Project',
            callback: () => this.moveNoteToProject()
        });

        // File menu: Move to Project
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (file instanceof TFile) {
                    menu.addItem((item) => {
                        item.setTitle('Move to Project')
                            .setIcon('folder-input')
                            .onClick(() => this.moveNoteToProject(file));
                    });
                }
            })
        );

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

    isProjectArchived(project: ProjectInfo): boolean {
        const archivePath = normalizePath(this.settings.archiveFolder);
        return project.path.startsWith(archivePath + '/') || project.path === archivePath;
    }

    async showManageProjectModal(): Promise<void> {
        const currentProject = this.getCurrentProject();
        if (currentProject) {
            new ManageProjectModal(this.app, this, currentProject).open();
            return;
        }

        // Check if we're in an archived project
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            const archivePath = normalizePath(this.settings.archiveFolder);
            const projectName = getProjectNameFromPath(activeFile.path, archivePath);
            if (projectName) {
                const projectPath = `${archivePath}/${projectName}`;
                const projectFolder = this.app.vault.getAbstractFileByPath(projectPath);
                if (projectFolder instanceof TFolder) {
                    const mainFilePath = `${projectPath}/${projectName}.md`;
                    const mainFile = this.app.vault.getAbstractFileByPath(mainFilePath);
                    const project: ProjectInfo = {
                        folder: projectFolder,
                        mainFile: mainFile instanceof TFile ? mainFile : null,
                        name: projectName,
                        path: projectPath
                    };
                    new ManageProjectModal(this.app, this, project).open();
                    return;
                }
            }
        }

        // Not in a project, show picker
        const projects = [...this.getAllProjects(), ...this.getArchivedProjects()];
        if (projects.length === 0) {
            new Notice('No projects found');
            return;
        }

        new ProjectPickerModal(this.app, projects, 'Select project to manage', (project) => {
            new ManageProjectModal(this.app, this, project).open();
        }).open();
    }

    async moveNoteToProject(file?: TFile): Promise<void> {
        const targetFile = file || this.app.workspace.getActiveFile();
        if (!targetFile) {
            new Notice('No active file');
            return;
        }

        const projects = this.getProjectsWithTag();
        if (projects.length === 0) {
            new Notice('No projects found');
            return;
        }

        new MoveNoteToProjectModal(this.app, this, projects, targetFile).open();
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
                item.setTitle('Manage Project');
                item.onClick(() => {
                    const modal = new ManageProjectModal(this.app, this.plugin, entry.project!);
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

class CreateProjectModal extends Modal {
    plugin: ProjectControlPlugin;
    nameInput: TextComponent;

    constructor(app: App, plugin: ProjectControlPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Create New Project' });

        let emojiValue = '';

        new Setting(contentEl)
            .setName('Project name')
            .setDesc('Enter the name of your new project')
            .addText(text => {
                this.nameInput = text;
                text.setPlaceholder('My Project');
            });

        const emojiSetting = new Setting(contentEl)
            .setName('Emoji (optional)')
            .setDesc('Add an emoji icon for the project');

        const emojiBtn = emojiSetting.controlEl.createEl('button', {
            cls: 'mp-emoji-btn',
            text: '+'
        });
        emojiBtn.addEventListener('click', () => {
            new EmojiPickerModal(this.app, (emoji) => {
                emojiValue = emoji;
                emojiBtn.textContent = emoji;
            }).open();
        });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Create')
                .setCta()
                .onClick(async () => {
                    const name = this.nameInput.getValue().trim();

                    if (!name) {
                        new Notice('Please enter a project name');
                        return;
                    }

                    await this.plugin.createProject(name, emojiValue || undefined);
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

class EmojiPickerModal extends Modal {
    onSelect: (emoji: string) => void;

    constructor(app: App, onSelect: (emoji: string) => void) {
        super(app);
        this.onSelect = onSelect;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('emoji-picker-modal');

        const searchInput = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Search emoji...',
            cls: 'emoji-picker-search'
        });

        const grid = contentEl.createDiv({ cls: 'emoji-picker-grid' });

        const renderEmojis = (query: string) => {
            grid.empty();
            const q = query.toLowerCase().trim();
            let filtered = emojiData as { emoji: string; keywords: string[] }[];
            if (q) {
                filtered = filtered.filter(e =>
                    e.keywords.some(k => k.includes(q)) || e.emoji === q
                );
            }
            const toShow = filtered.slice(0, 200);
            for (const entry of toShow) {
                const btn = grid.createEl('button', {
                    cls: 'emoji-picker-btn',
                    text: entry.emoji,
                    attr: { title: entry.keywords.join(', ') }
                });
                btn.addEventListener('click', () => {
                    this.onSelect(entry.emoji);
                    this.close();
                });
            }
            if (toShow.length === 0) {
                grid.createEl('div', {
                    cls: 'emoji-picker-empty',
                    text: 'No emoji found'
                });
            }
        };

        searchInput.addEventListener('input', () => {
            renderEmojis(searchInput.value);
        });

        renderEmojis('');
        searchInput.focus();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class ManageProjectModal extends Modal {
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
        contentEl.addClass('manage-project-modal');

        const isArchived = this.plugin.isProjectArchived(this.project);

        // Get current frontmatter
        let frontmatter: Record<string, any> = {};
        if (this.project.mainFile) {
            const cache = this.app.metadataCache.getFileCache(this.project.mainFile);
            frontmatter = cache?.frontmatter ? { ...cache.frontmatter } : {};
        }

        let emojiValue = frontmatter.emoji || '';
        let statusValue = frontmatter.status || 'active';
        let categoryValue = frontmatter.category || '';
        let priorityGroupValue = frontmatter['priority-group'] || '';
        let priorityValue = frontmatter.priority || '';
        const originalStatus = statusValue;
        const originalPriorityGroup = priorityGroupValue;

        // --- Identity section ---
        const identityRow = contentEl.createDiv({ cls: 'mp-identity-row' });

        const emojiBtn = identityRow.createEl('button', {
            cls: 'mp-emoji-btn',
            text: emojiValue || '+'
        });
        emojiBtn.addEventListener('click', () => {
            new EmojiPickerModal(this.app, (emoji) => {
                emojiValue = emoji;
                emojiBtn.textContent = emoji;
            }).open();
        });

        const titleGroup = identityRow.createDiv({ cls: 'mp-title-group' });
        titleGroup.createSpan({ cls: 'mp-title-text', text: this.project.name });
        const editBtn = titleGroup.createEl('button', {
            cls: 'mp-title-edit-btn',
            attr: { 'aria-label': 'Rename project' }
        });
        editBtn.textContent = '\u270E';
        editBtn.addEventListener('click', () => {
            this.close();
            new RenameProjectModal(this.app, this.plugin, this.project).open();
        });

        // --- Status row ---
        const statusRow = contentEl.createDiv({ cls: 'mp-status-row' });
        statusRow.createSpan({ text: 'Status' });
        const statusSelect = statusRow.createEl('select');
        const statusOptions = [
            { value: 'active', label: 'Active' },
            { value: 'coming-soon', label: 'Coming Soon' },
            { value: 'deferred', label: 'Deferred' },
            { value: 'on-hold', label: 'On Hold' },
            { value: 'complete', label: 'Complete' }
        ];
        for (const opt of statusOptions) {
            const optEl = statusSelect.createEl('option', { text: opt.label, value: opt.value });
            if (opt.value === statusValue) optEl.selected = true;
        }
        statusSelect.addEventListener('change', () => {
            statusValue = statusSelect.value;
        });

        // --- Metadata fields ---
        new Setting(contentEl)
            .setName('Category')
            .addText(text => text
                .setValue(categoryValue)
                .setPlaceholder('category/subcategory')
                .onChange(value => { categoryValue = value; }));

        new Setting(contentEl)
            .setName('Priority Group')
            .addDropdown(dropdown => dropdown
                .addOption('', '(none)')
                .addOption('Foundation', 'Foundation')
                .addOption('Growth', 'Growth')
                .addOption('Recharge', 'Recharge')
                .setValue(priorityGroupValue)
                .onChange(value => { priorityGroupValue = value; }));

        new Setting(contentEl)
            .setName('Priority')
            .addText(text => text
                .setValue(priorityValue)
                .setPlaceholder('high, medium, low')
                .onChange(value => { priorityValue = value; }));

        // --- Action buttons ---
        const actions = contentEl.createDiv({ cls: 'mp-actions' });

        const openBtn = actions.createEl('button', { text: 'Open Project Page', cls: 'mod-cta' });
        openBtn.addEventListener('click', () => {
            if (this.project.mainFile) {
                this.app.workspace.getLeaf().openFile(this.project.mainFile);
            }
            this.close();
        });

        const revealBtn = actions.createEl('button', { text: 'Reveal in Explorer' });
        revealBtn.addEventListener('click', () => {
            // @ts-ignore - internal API
            this.app.internalPlugins.plugins['file-explorer']?.instance?.revealInFolder(this.project.folder);
            this.close();
        });

        // --- Advanced section (collapsible) ---
        const advancedHeader = contentEl.createDiv({ cls: 'mp-advanced-header' });
        advancedHeader.createSpan({ cls: 'mp-advanced-icon', text: '\u25B6' });
        advancedHeader.createSpan({ text: 'Advanced' });

        const advancedContent = contentEl.createDiv({ cls: 'mp-advanced-content' });
        advancedContent.style.display = 'none';

        advancedHeader.addEventListener('click', () => {
            const collapsed = advancedContent.style.display === 'none';
            advancedContent.style.display = collapsed ? '' : 'none';
            const icon = advancedHeader.querySelector('.mp-advanced-icon');
            if (icon) icon.textContent = collapsed ? '\u25BC' : '\u25B6';
        });

        new Setting(advancedContent)
            .setName('Duplicate')
            .setDesc('Create a copy of this project')
            .addButton(btn => btn
                .setButtonText('Duplicate')
                .onClick(() => {
                    this.close();
                    new DuplicateProjectModal(this.app, this.plugin, this.project).open();
                }));

        const archiveRestoreSetting = new Setting(advancedContent);
        if (isArchived) {
            archiveRestoreSetting
                .setName('Restore')
                .setDesc('Move this project back to the active folder')
                .addButton(btn => btn
                    .setButtonText('Restore')
                    .onClick(async () => {
                        await this.plugin.restoreProject(this.project);
                        this.close();
                    }));
        } else {
            archiveRestoreSetting
                .setName('Archive')
                .setDesc('Move this project to the archive folder')
                .addButton(btn => btn
                    .setButtonText('Archive')
                    .setWarning()
                    .onClick(async () => {
                        await this.plugin.archiveProject(this.project);
                        this.close();
                    }));
        }

        // --- Footer ---
        const footer = contentEl.createDiv({ cls: 'mp-footer' });

        const saveBtn = footer.createEl('button', { text: 'Save', cls: 'mod-cta' });
        saveBtn.addEventListener('click', async () => {
            if (this.project.mainFile) {
                await this.plugin.updateFrontmatter(this.project.mainFile, {
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

                new Notice('Project updated');
            }
            this.close();
        });

        const cancelBtn = footer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class MoveNoteToProjectModal extends FuzzySuggestModal<ProjectInfo> {
    plugin: ProjectControlPlugin;
    projects: ProjectInfo[];
    file: TFile;

    constructor(app: App, plugin: ProjectControlPlugin, projects: ProjectInfo[], file: TFile) {
        super(app);
        this.plugin = plugin;
        this.projects = projects;
        this.file = file;
        this.setPlaceholder('Select project to move note to');
    }

    getItems() {
        return this.projects;
    }

    getItemText(item: ProjectInfo) {
        return item.name;
    }

    async onChooseItem(item: ProjectInfo) {
        const destPath = `${item.path}/${this.file.name}`;

        // Check for filename collision
        const existing = this.app.vault.getAbstractFileByPath(destPath);
        if (existing) {
            new Notice(`A file named "${this.file.name}" already exists in ${item.name}`);
            return;
        }

        // Move the file (auto-updates links)
        await this.app.fileManager.renameFile(this.file, destPath);

        // Add project frontmatter
        const movedFile = this.app.vault.getAbstractFileByPath(destPath);
        if (movedFile instanceof TFile) {
            await this.plugin.updateFrontmatter(movedFile, {
                project: `[[${item.name}]]`
            });
        }

        new Notice(`Moved "${this.file.name}" to ${item.name}`);
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

    }
}
