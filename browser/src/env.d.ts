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
}

declare namespace chrome.storage {
  const local: {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
}

declare namespace chrome.permissions {
  function request(permissions: { origins: string[] }): Promise<boolean>;
  function remove(permissions: { origins: string[] }): Promise<boolean>;
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
  function unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
}

declare namespace chrome.tabs {
  interface Tab {
    id?: number;
    url?: string;
  }
  function query(info: { active: boolean; currentWindow: boolean }): Promise<Tab[]>;
  function reload(tabId: number): Promise<void>;
}

// src/core/tcfile.ts mentions Node's Buffer in decodeBytes and encodeText, which the extension never calls (it
// decodes with TextDecoder): declared for the type check only, and the build checks that no bundle uses it.
declare const Buffer: any;
