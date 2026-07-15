import type { PiiScrubberPort } from "../core/ports.js";

export class NoopPiiScrubber implements PiiScrubberPort {
  async scrub(content: string): Promise<string> {
    return content;
  }
}
