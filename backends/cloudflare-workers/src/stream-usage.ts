/**
 * Usage-Erfassung für gestreamte Antworten (SSE).
 *
 * Budget, Auto-Revocation und die gelernten Session-Budgets hängen daran, dass die
 * Token-Zahlen einer Antwort korrekt ankommen. Bei Streams standen dem bisher zwei
 * Dinge im Weg:
 *
 * 1. Die Usage wurde je Netzwerk-Chunk geparst. Ein Chunk ist aber keine SSE-Nachricht:
 *    Die Zeile "data: {...}" kann mitten im JSON auf zwei Chunks aufgeteilt werden.
 *    Dann scheiterte JSON.parse und die Usage des gesamten Streams ging verloren
 *    (Kosten 0 -> Budget wird nie belastet).
 * 2. Anthropic liefert die Input-Tokens in "message_start" (message.usage.input_tokens)
 *    und die Output-Tokens in "message_delta" (usage.output_tokens). Wer nur eines der
 *    beiden Events auswertet, bucht die andere Hälfte mit 0.
 *
 * Der Akkumulator puffert daher zeilenweise über Chunk-Grenzen hinweg und sammelt die
 * Werte aus allen Events ein. Laufzeit-neutral (kein Node-/Workers-spezifisches API)
 * und in den streamenden Backends identisch.
 *
 * Wie im Nicht-Stream-Pfad zählen bei Anthropic nur die regulären Input-Tokens;
 * Cache-Tokens (cache_read/cache_creation) werden nicht separat bepreist.
 */

export interface StreamUsage {
  input_tokens: number;
  output_tokens: number;
  /** true, sobald mindestens ein Usage-Wert aus dem Stream gelesen wurde. */
  found: boolean;
}

export interface StreamUsageAccumulator {
  /** Nimmt ein dekodiertes Chunk-Stück entgegen (Reihenfolge muss erhalten bleiben). */
  push(text: string): void;
  /** Wertet einen evtl. verbliebenen Rest ohne abschließendes Newline aus. */
  flush(): void;
  /** Aktueller Stand der eingesammelten Usage. */
  result(): StreamUsage;
}

/** Liest eine Zahl, wenn sie eine ist — sonst undefined. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Erzeugt einen Akkumulator für den angegebenen Provider. Unbekannte Provider
 * liefern am Ende found = false, der Aufrufer schätzt dann wie bisher.
 */
export function createStreamUsageAccumulator(providerName: string): StreamUsageAccumulator {
  const usage: StreamUsage = { input_tokens: 0, output_tokens: 0, found: false };
  let buffer = "";

  function setInput(value: number | undefined): void {
    if (value === undefined) return;
    usage.input_tokens = value;
    usage.found = true;
  }

  function setOutput(value: number | undefined): void {
    if (value === undefined) return;
    usage.output_tokens = value;
    usage.found = true;
  }

  function handleEvent(data: any): void {
    if (!data || typeof data !== "object") return;

    if (providerName === "anthropic") {
      // message_start: {"type":"message_start","message":{...,"usage":{"input_tokens":N,...}}}
      if (data.type === "message_start") {
        setInput(num(data.message?.usage?.input_tokens));
        setOutput(num(data.message?.usage?.output_tokens));
        return;
      }
      // message_delta: {"type":"message_delta","delta":{...},"usage":{"output_tokens":N}}
      if (data.type === "message_delta" && data.usage) {
        setInput(num(data.usage.input_tokens));
        setOutput(num(data.usage.output_tokens));
      }
      return;
    }

    if (providerName === "openai") {
      // Letzter Chunk bei stream_options.include_usage: {"usage":{"prompt_tokens":N,...}}
      if (data.usage) {
        setInput(num(data.usage.prompt_tokens));
        setOutput(num(data.usage.completion_tokens));
      }
      return;
    }

    if (providerName === "google") {
      // streamGenerateContent liefert usageMetadata im letzten Chunk mit.
      if (data.usageMetadata) {
        setInput(num(data.usageMetadata.promptTokenCount));
        setOutput(num(data.usageMetadata.candidatesTokenCount));
      }
    }
  }

  function handleLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;

    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") return;

    try {
      handleEvent(JSON.parse(payload));
    } catch {
      // Kein gültiges JSON — anderer Event-Typ oder Provider-Eigenheit, wird ignoriert.
    }
  }

  return {
    push(text: string): void {
      if (!text) return;
      buffer += text;

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },

    flush(): void {
      if (buffer) {
        handleLine(buffer);
        buffer = "";
      }
    },

    result(): StreamUsage {
      return { ...usage };
    },
  };
}
