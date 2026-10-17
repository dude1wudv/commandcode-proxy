// A fallback for received semantic output, not a model tokenizer. Accumulate
// UTF-8 bytes first and round only the total; transport chunking must not bill
// one token per delta. Never count SSE framing, IDs, tool names or signatures.
const tokenCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function createMessagesUsage(onUpdate = () => {}) {
  let inputTokens;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let capturedCacheWrite = 0;
  let noCacheTokens;
  let reportedOutput = 0;
  let reportedBytes = 0;
  let finalOutput;
  let outputBytes = 0;
  const tails = new Map();
  const tools = new Map();
  let anonymousTool = 0;

  function appendBytes(key, text) {
    if (typeof text !== 'string' || !text) return 0;
    const tail = tails.get(key) || '';
    // A provider may split a UTF-16 surrogate pair across JSON deltas.
    const bytes = Buffer.byteLength(tail + text, 'utf8') - Buffer.byteLength(tail, 'utf8');
    const last = text.charCodeAt(text.length - 1);
    tails.set(key, last >= 0xd800 && last <= 0xdbff ? text.at(-1) : '');
    return bytes;
  }

  function snapshot() {
    // An upstream cumulative count covers the prefix received at that point.
    // Estimate only later bytes; re-estimating the prefix can overcharge, while
    // max(reported, whole-stream estimate) can silently drop a short tail.
    const estimatedTail = Math.ceil(Math.max(0, outputBytes - reportedBytes) / 4);
    const output = finalOutput ?? (reportedOutput + estimatedTail);
    const writeTokens = cacheWriteTokens || capturedCacheWrite;
    return {
      input_tokens: noCacheTokens ?? Math.max(0, (inputTokens ?? 0) - cachedInputTokens - writeTokens),
      output_tokens: output,
      cache_read_input_tokens: cachedInputTokens,
      cache_creation_input_tokens: writeTokens,
      output_tokens_estimated: finalOutput === undefined && estimatedTail > 0,
    };
  }

  function sync() {
    const usage = snapshot();
    onUpdate(usage, inputTokens ?? (usage.input_tokens + cachedInputTokens + usage.cache_creation_input_tokens));
    return usage;
  }

  return {
    snapshot,
    observe(event) {
      if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
        outputBytes += appendBytes(event.type, event.text ?? event.delta ?? '');
      } else if (event.type === 'tool-input-delta' || event.type === 'tool-call') {
        const id = event.toolCallId ?? event.id ?? `anonymous-${anonymousTool}`;
        const tool = tools.get(id) || { streamed: 0, complete: 0 };
        const before = Math.max(tool.streamed, tool.complete);
        const toolInput = event.input ?? event.args;
        if (event.type === 'tool-input-delta') {
          tool.streamed += appendBytes(`tool:${id}`, event.delta ?? event.inputTextDelta ?? '');
        } else if (toolInput !== undefined) {
          const input = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
          tool.complete = Buffer.byteLength(input, 'utf8');
          if (event.toolCallId === undefined && event.id === undefined) anonymousTool++;
        }
        tools.set(id, tool);
        outputBytes += Math.max(tool.streamed, tool.complete) - before;
      }
      return sync();
    },
    apply(usage, final = false) {
      if (!usage || typeof usage !== 'object') return sync();
      const input = tokenCount(usage.inputTokens);
      const cached = tokenCount(usage.cachedInputTokens ?? usage.inputTokenDetails?.cacheReadTokens);
      const write = tokenCount(usage.inputTokenDetails?.cacheWriteTokens);
      const uncached = tokenCount(usage.inputTokenDetails?.noCacheTokens);
      const output = tokenCount(usage.outputTokens);
      if (input !== undefined) inputTokens = input;
      if (cached !== undefined) cachedInputTokens = cached;
      if (write !== undefined) cacheWriteTokens = write;
      if (uncached !== undefined) noCacheTokens = uncached;
      else if (input !== undefined || cached !== undefined || write !== undefined) noCacheTokens = undefined;
      if (output !== undefined && output > 0) {
        reportedOutput = output;
        reportedBytes = outputBytes;
        if (final && output > 0) finalOutput = output;
      }
      return sync();
    },
    cacheWrite(value) {
      if (tokenCount(value) !== undefined) capturedCacheWrite = value;
      return sync();
    },
  };
}
