/**
 * When should the page go and look for a newer bake?
 *
 * The bundle of baked geometry is a snapshot of what the world contained when it was made.
 * A live world outgrows it: the first block of a kind the bake never saw resolves to an
 * empty model and is drawn as nothing. The renderer counts those ("NOT IN BAKE" in the
 * HUD), and this policy turns that count into a polite poll of `/baked/assets.json` so a
 * re-bake — by hand or by the baker sidecar — is picked up in place, without a reload
 * that would drop the camera and, if a bot is being driven, despawn it.
 *
 * Three rules, each with a test:
 *
 *   ONLY WHEN SOMETHING IS MISSING   a bundle that covers everything on screen is not
 *                                    polled at all — most sessions never make a request;
 *   NEVER IMMEDIATELY, NEVER STACKED the first poll waits one interval (the baker itself
 *                                    runs on a timer, so an instant poll finds nothing),
 *                                    and a poll in flight suppresses the next;
 *   BACK OFF WHILE NOTHING CHANGES   a world with a block no jar can render is missing it
 *                                    forever; the interval doubles to a ceiling rather
 *                                    than hitting the server every few seconds for ever,
 *                                    and resets the moment a new bundle is adopted.
 */
export class BakeRefresh {
  private nextAt = 0;
  private waitMs: number;
  /** Set by the caller around the fetch, so a slow response cannot be doubled up. */
  inFlight = false;

  constructor(
    /** `generated` of the bundle currently on screen. */
    public generated: string,
    readonly minMs = 10_000,
    readonly maxMs = 60_000,
  ) {
    this.waitMs = minMs;
  }

  /** Is a poll due now, given how many states the current bundle is missing? */
  due(now: number, missing: number): boolean {
    if (missing <= 0) {
      this.nextAt = 0;
      this.waitMs = this.minMs;
      return false;
    }
    if (this.inFlight) return false;
    if (this.nextAt === 0) {
      // Just noticed something missing: wait one interval before the first look.
      this.nextAt = now + this.waitMs;
      return false;
    }
    if (now < this.nextAt) return false;
    this.waitMs = Math.min(this.maxMs, this.waitMs * 2);
    this.nextAt = now + this.waitMs;
    return true;
  }

  /** A poll came back: is this a bundle other than the one on screen? */
  isNew(generated: string): boolean {
    return generated !== this.generated;
  }

  /** The new bundle is on screen; start again from the short interval. */
  adopt(generated: string): void {
    this.generated = generated;
    this.nextAt = 0;
    this.waitMs = this.minMs;
  }
}
