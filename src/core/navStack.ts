// Back/Forward history of the TwinCAT objects shown in the editors. VS Code's own navigation history drops an
// editor of a twincat: URI when its tab closes, so going from method to method in preview tabs leaves nothing
// to go back to.

const LIMIT = 50;

export class NavStack<T> {
  private back: T[] = [];
  private forward: T[] = [];
  private shown: T | undefined;

  constructor(private readonly keyOf: (entry: T) => string) {}

  get current(): T | undefined {
    return this.shown;
  }

  get canGoBack(): boolean {
    return this.back.length > 0;
  }

  get canGoForward(): boolean {
    return this.forward.length > 0;
  }

  /** An entry became the active one: the one before goes on the back stack, the forward stack is cleared. */
  visit(entry: T): void {
    if (this.shown && this.keyOf(this.shown) === this.keyOf(entry)) {
      this.shown = entry;
      return;
    }
    if (this.shown) {
      this.back.push(this.shown);
      if (this.back.length > LIMIT) this.back.shift();
    }
    this.shown = entry;
    this.forward = [];
  }

  /** Moves to the previous entry that `valid` accepts (the others are dropped) and returns it. */
  goBack(valid: (entry: T) => boolean = () => true): T | undefined {
    return this.move(this.back, this.forward, valid);
  }

  /** Moves to the next entry that `valid` accepts (the others are dropped) and returns it. */
  goForward(valid: (entry: T) => boolean = () => true): T | undefined {
    return this.move(this.forward, this.back, valid);
  }

  private move(from: T[], to: T[], valid: (entry: T) => boolean): T | undefined {
    let target: T | undefined;
    while (from.length) {
      const e = from.pop()!;
      if (valid(e) && (!this.shown || this.keyOf(e) !== this.keyOf(this.shown))) {
        target = e;
        break;
      }
    }
    if (!target) return undefined;
    if (this.shown) to.push(this.shown);
    this.shown = target;
    return target;
  }
}
