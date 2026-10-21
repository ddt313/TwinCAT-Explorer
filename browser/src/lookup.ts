// A value looked for once and kept, for all who ask while it is looked for and after, nothing found included: the
// commits a review page compares, which an attempt may take a good part of a second of a big page's main thread to
// find, or two requests to the host. Looked for again only when asked to (a user's action), after an attempt that
// found nothing, and some seconds after it at the soonest. Platform-free, so the unit tests cover it.

export class Lookup<T> {
  private attempt: Promise<T | undefined> | undefined;
  private found: T | undefined;
  /** When the last attempt ended (ms); undefined while one is going on. */
  private ended: number | undefined;

  /**
   * @param find An attempt: what it finds, else undefined. One that fails has found nothing.
   * @param interval How long after an attempt that found nothing another may start (ms).
   * @param now The clock (ms).
   */
  constructor(
    private readonly find: () => Promise<T | undefined>,
    private readonly interval: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** What the last attempt found, once it has ended. */
  get value(): T | undefined {
    return this.found;
  }

  /** The attempt going on, else what the last one found; the first attempt starts on the first call. */
  get(): Promise<T | undefined> {
    return this.attempt ?? this.start();
  }

  /**
   * A new attempt, when the last one found nothing and ended `interval` ms ago or more: what it finds, which `get`
   * gives from now on. Else undefined (an attempt is going on, the value was found, or the last attempt is too recent).
   */
  retry(): Promise<T | undefined> | undefined {
    if (this.attempt && (this.ended === undefined || this.found !== undefined || this.now() - this.ended < this.interval)) return undefined;
    return this.start();
  }

  private start(): Promise<T | undefined> {
    this.ended = undefined;
    const attempt = (async () => this.find())().catch(() => undefined).then(found => {
      this.found = found;
      this.ended = this.now();
      return found;
    });
    this.attempt = attempt;
    return attempt;
  }
}
