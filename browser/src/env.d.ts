// The few extension APIs the spike uses (instead of a dependency on @types/chrome).
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
}

declare namespace chrome.storage {
  const local: {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
}

// src/core/tcfile.ts mentions Node's Buffer in decodeBytes and encodeText, which the extension never calls (it
// decodes with TextDecoder): declared for the type check only, and the build checks that no bundle uses it.
declare const Buffer: any;
