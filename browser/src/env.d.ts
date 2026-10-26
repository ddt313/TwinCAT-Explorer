// The few extension APIs the extension uses (instead of a dependency on @types/chrome).
declare namespace chrome.runtime {
  const id: string;
  function getURL(path: string): string;
  function sendMessage<T = unknown>(message: unknown): Promise<T>;
  interface MessageSender {
    id?: string;
    url?: string;
  }
  const onMessage: {
    addListener(callback: (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | void): void;
  };
  const onInstalled: { addListener(callback: () => void): void };
  const onStartup: { addListener(callback: () => void): void };
  function getManifest(): { version: string; host_permissions?: string[] };
}

declare namespace chrome.action {
  function setBadgeText(details: { text: string }): Promise<void>;
  function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  function setTitle(details: { title: string }): Promise<void>;
}

declare namespace chrome.alarms {
  function create(name: string, info: { periodInMinutes: number }): Promise<void>;
  const onAlarm: { addListener(callback: (alarm: { name: string }) => void): void };
}

declare namespace chrome.storage {
  const local: {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  const onChanged: {
    addListener(callback: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void): void;
  };
}

declare namespace chrome.permissions {
  interface Permissions {
    origins?: string[];
  }
  function request(permissions: { origins: string[] }): Promise<boolean>;
  function remove(permissions: { origins: string[] }): Promise<boolean>;
  function contains(permissions: { origins: string[] }): Promise<boolean>;
  function getAll(): Promise<Permissions>;
  const onAdded: { addListener(callback: (permissions: Permissions) => void): void };
  const onRemoved: { addListener(callback: (permissions: Permissions) => void): void };
}

declare namespace chrome.scripting {
  interface RegisteredContentScript {
    id: string;
    matches?: string[];
    js?: string[];
    css?: string[];
    runAt?: 'document_start' | 'document_end' | 'document_idle';
  }
  function getRegisteredContentScripts(): Promise<RegisteredContentScript[]>;
  function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
  function updateContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
  function unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
  interface Target {
    tabId: number;
  }
  function executeScript<T>(injection: { target: Target; func: () => T }): Promise<{ result?: T }[]>;
  function executeScript(injection: { target: Target; files: string[] }): Promise<{ result?: unknown }[]>;
  function insertCSS(injection: { target: Target; files: string[] }): Promise<void>;
}

declare namespace chrome.tabs {
  interface Tab {
    id?: number;
    url?: string;
  }
  function query(info: { active: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>;
  function reload(tabId: number): Promise<void>;
}

// src/core/tcfile.ts mentions Node's Buffer in decodeBytes and encodeText, which the extension never calls (it
// decodes with TextDecoder): declared for the type check only, and the build checks that no bundle uses it.
declare const Buffer: any;

// Node's crypto, for the core's textHash, which the extension does not call (build.js stubs it out).
declare module 'crypto' {
  export function createHash(algorithm: string): { update(text: string): { digest(encoding: 'hex'): string } };
}
