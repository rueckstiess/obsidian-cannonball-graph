// __mocks__/obsidian.ts
// Mock implementation of key Obsidian interfaces

// Basic position interface
export interface Pos {
  line: number;
  col: number;
  offset: number;
}

// Basic cache interface
export interface CachedMetadata {
  headings?: Array<any>;
  links?: Array<any>;
  embeds?: Array<any>;
  tags?: Array<any>;
  blocks?: Record<string, any>;
  frontmatter?: any;
  listItems?: Array<any>;
  sections?: Array<any>;
}

// Basic abstract file
export interface TAbstractFile {
  path: string;
  name: string;
  vault: Vault;
}

// TFile implementation
export interface TFile extends TAbstractFile {
  extension: string;
  basename: string;
  stat: {
    mtime: number;
    ctime: number;
    size: number;
  };
}

// Metadata cache
export interface MetadataCache {
  getFileCache(file: TFile): CachedMetadata | null;
  getCache(path: string): CachedMetadata | null;
  on(name: string, callback: (file: TFile, data: string, cache: CachedMetadata) => any): any;
  blockCache: {
    getForFile: (cancelContext: any, file: TFile) => Promise<any>;
    cache: Record<string, any>;
  };
  fileCache: Record<string, any>;
  metadataCache: Record<string, any>;
}

// Vault implementation
export interface Vault {
  adapter: any;
  configDir: string;
  getAbstractFileByPath(path: string): TAbstractFile | null;
  getFiles(): TFile[];
  getMarkdownFiles(): TFile[];
  read(file: TFile): Promise<string>;
}

// App implementation
export interface App {
  vault: Vault;
  metadataCache: MetadataCache;
  workspace: {
    getActiveFile(): TFile | null;
  };
}

// Plugin implementation
export abstract class Plugin {
  app: App;
  manifest: any;

  constructor(app: App, manifest: any) {
    this.app = app;
    this.manifest = manifest;
  }

  registerEvent(eventRef: any): void { }
  registerInterval(intervalID: number): void { }
  registerDomEvent(el: any, type: string, callback: (evt: any) => any): void { }
  loadData(): Promise<any> { return Promise.resolve(null); }
  saveData(data: any): Promise<void> { return Promise.resolve(); }
  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement { return document.createElement('div'); }
  addStatusBarItem(): HTMLElement { return document.createElement('div'); }

  abstract onload(): void;
  abstract onunload(): void;
}

// Events
export class Events {
  on(name: string, callback: (...data: any) => any): EventRef { return {} as EventRef; }
  off(name: string, callback: (...data: any) => any): void { }
  offref(ref: EventRef): void { }
  trigger(name: string, ...data: any[]): void { }
  tryTrigger(evt: EventRef, args: any[]): void { }
}

// Common interfaces
export interface EventRef { }

// Block Cache
export interface BlockCache {
  display: string;
  node: any;
}

// List Item Cache
export interface ListItemCache {
  position: Pos;
  parent: number;
  task?: string;
  id?: string;
}

// Notice implementation
export class Notice {
  constructor(message: string, timeout?: number) { }
  setMessage(message: string): void { }
  hide(): void { }
}

// Mocking TFile constructor for testing
export function createTFile(path: string, name: string): TFile {
  return {
    path,
    name,
    extension: path.split('.').pop() || '',
    basename: name.split('.')[0],
    vault: {} as Vault,
    stat: {
      mtime: Date.now(),
      ctime: Date.now(),
      size: 0
    }
  };
}