// One fetch, the same in each place that reads a file for a viewer (the frame, the service worker, the page).

import { FetchResult } from './protocol';

export async function fetchText(url: string, credentials: RequestCredentials): Promise<FetchResult> {
  try {
    const response = await fetch(url, { credentials });
    const result: FetchResult = {
      ok: response.ok, status: response.status, url: response.url, contentType: response.headers.get('content-type') ?? '',
    };
    // TextDecoder drops a BOM, as core's decodeBytes does with Node's Buffer.
    if (response.ok) result.text = new TextDecoder('utf-8').decode(await response.arrayBuffer());
    return result;
  } catch (e) {
    return { ok: false, status: 0, error: String((e as Error).message ?? e) };
  }
}
