import { readFile } from 'node:fs/promises';

const args = parseArgs(process.argv.slice(2));
const baseUrl = new URL(args.get('base-url') ?? 'http://127.0.0.1:3583');
const payloadFile = args.get('payload-file');
const showText = args.has('show-text');

if (!payloadFile) throw new Error('--payload-file is required');

const payload = JSON.parse(await readFile(payloadFile, 'utf8'));
const admissionResponse = await fetch(new URL('/workflows/generate-replies', baseUrl), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
if (!admissionResponse.ok) throw new Error(`workflow admission failed: ${admissionResponse.status}`);

const admission = await admissionResponse.json();
if (typeof admission.runId !== 'string') throw new Error('workflow admission did not return runId');

const streamUrl = new URL(
  typeof admission.streamUrl === 'string'
    ? admission.streamUrl
    : `/runs/${encodeURIComponent(admission.runId)}`,
  baseUrl,
);
streamUrl.searchParams.set('offset', typeof admission.offset === 'string' ? admission.offset : '-1');
streamUrl.searchParams.set('live', 'sse');

const streamResponse = await fetch(streamUrl, { headers: { accept: 'text/event-stream' } });
if (!streamResponse.ok || !streamResponse.body) {
  throw new Error(`run stream failed: ${streamResponse.status}`);
}

const summary = {
  runId: admission.runId,
  events: 0,
  textDeltaEvents: 0,
  textChars: 0,
  thinkingDeltaEvents: 0,
  thinkingChars: 0,
  nextOffset: '-1',
  terminalType: null,
  terminalError: false,
};

const reader = streamResponse.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
  buffer = buffer.replaceAll('\r\n', '\n');

  while (true) {
    const boundary = buffer.indexOf('\n\n');
    if (boundary < 0) break;
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    consumeFrame(frame, summary, showText);
  }
  if (done) break;
}

if (buffer.trim()) consumeFrame(buffer, summary, showText);
if (showText) process.stdout.write('\n');
console.log(JSON.stringify(summary, null, 2));

if (summary.terminalType !== 'run_end' || summary.terminalError || summary.textDeltaEvents === 0) {
  process.exitCode = 1;
}

function consumeFrame(frame, state, printText) {
  if (!frame || frame.startsWith(':')) return;
  const lines = frame.split('\n');
  let eventName = 'message';
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;

  let data;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }

  if (eventName === 'control') {
    if (typeof data?.streamNextOffset === 'string') state.nextOffset = data.streamNextOffset;
    return;
  }
  if (eventName !== 'data' || !Array.isArray(data)) return;

  for (const event of data) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue;
    state.events += 1;

    if (event.type === 'text_delta' && typeof event.text === 'string') {
      state.textDeltaEvents += 1;
      state.textChars += event.text.length;
      if (printText) process.stdout.write(event.text);
      continue;
    }
    if (event.type === 'thinking_delta' && typeof event.delta === 'string') {
      state.thinkingDeltaEvents += 1;
      state.thinkingChars += event.delta.length;
      continue;
    }

    console.error(`[event] ${event.type}`);
    if (event.type === 'run_end') {
      state.terminalType = event.type;
      state.terminalError = event.isError === true;
    }
  }
}

function parseArgs(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];
    if (!current.startsWith('--')) continue;
    const name = current.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith('--')) {
      result.set(name, next);
      index += 1;
    } else {
      result.set(name, true);
    }
  }
  return result;
}
