export interface SseEvent {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
  raw: string;
}

const MAX_BUFFER_CHARS = 10_000_000;
const BOUNDARY = /\r\n\r\n|\n\n|\r\r/;

function parseBlock(raw: string): SseEvent | undefined {
  if (raw.length === 0) return undefined;

  const event: SseEvent = { data: '', raw };
  const dataLines: string[] = [];
  const lines = raw.split(/\r\n|\r|\n/);

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        if (value.length > 0) event.event = value;
        break;
      case 'id':
        if (!value.includes('\0')) event.id = value;
        break;
      case 'retry': {
        const retry = Number.parseInt(value, 10);
        if (Number.isFinite(retry) && retry >= 0) event.retry = retry;
        break;
      }
      default:
        break;
    }
  }

  event.data = dataLines.join('\n');
  return event;
}

/**
 * Incremental SSE parser. It never touches the bytes sent to the client; it
 * only produces a best-effort parse of the same bytes for recording.
 */
export class SseParser {
  #buffer = '';
  #decoder = new TextDecoder();
  #overflowed = false;

  feed(chunk: Uint8Array): SseEvent[] {
    if (this.#overflowed) return [];
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#drain(false);
  }

  end(): SseEvent[] {
    if (this.#overflowed) return [];
    this.#buffer += this.#decoder.decode();
    const events = this.#drain(true);
    if (this.#buffer.trim().length > 0) {
      const event = parseBlock(this.#buffer);
      this.#buffer = '';
      if (event) events.push(event);
    }
    return events;
  }

  get overflowed(): boolean {
    return this.#overflowed;
  }

  #drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = [];

    for (;;) {
      const match = BOUNDARY.exec(this.#buffer);
      if (!match || match.index === undefined) break;

      const raw = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      const event = parseBlock(raw);
      if (event) events.push(event);
    }

    if (!final && this.#buffer.length > MAX_BUFFER_CHARS) {
      this.#overflowed = true;
      this.#buffer = '';
    }

    return events;
  }
}
