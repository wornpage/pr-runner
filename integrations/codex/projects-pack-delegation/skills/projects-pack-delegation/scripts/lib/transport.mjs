import { randomUUID } from 'node:crypto';
import { TOOL_NAME } from './protocol.mjs';

export const MCP_DEADLINE_MS = 30_000;
export const MCP_RESPONSE_BYTES = 512 * 1024;
const CONTENT_TYPES = new Set(['application/json', 'text/event-stream']);

export class TransportError extends Error {
  constructor(code) {
    super('The Projects service request failed.');
    this.name = 'TransportError';
    this.code = code;
  }
}

const fail = code => { throw new TransportError(code); };

export function readTransportConfiguration(env = process.env) {
  const endpointText = env.PROJECTS_MCP_ENDPOINT;
  const token = env.PROJECTS_MCP_TOKEN;
  if (typeof endpointText !== 'string' || !endpointText || endpointText.length > 2048
      || typeof token !== 'string' || !token || token.length > 8192
      || /[\u0000-\u0020\u007f]/u.test(token)) fail('service_configuration_missing');
  let endpoint;
  try { endpoint = new URL(endpointText); } catch { fail('service_endpoint_invalid'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== '/mcp') fail('service_endpoint_invalid');
  return Object.freeze({ endpoint: endpoint.href, token });
}

async function boundedBytes(response) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MCP_RESPONSE_BYTES)) fail('service_response_too_large');
  if (!response.body?.getReader) fail('service_response_invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array) || size + value.byteLength > MCP_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      fail('service_response_too_large');
    }
    size += value.byteLength;
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseSse(text) {
  const events = text.split(/\r?\n\r?\n/gu).filter(Boolean);
  if (events.length < 1 || events.length > 64) fail('service_response_invalid');
  let message = null;
  for (const event of events) {
    const data = event.split(/\r?\n/gu).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /u, '')).join('\n');
    if (!data || data === '[DONE]') continue;
    let candidate;
    try { candidate = JSON.parse(data); } catch { fail('service_response_invalid'); }
    if (candidate && typeof candidate === 'object' && (Object.hasOwn(candidate, 'result') || Object.hasOwn(candidate, 'error'))) {
      if (message) fail('service_response_invalid');
      message = candidate;
    }
  }
  if (!message) fail('service_response_invalid');
  return message;
}

function unwrapToolResult(envelope, rpcId) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || envelope.jsonrpc !== '2.0' || envelope.id !== rpcId
      || Object.keys(envelope).some(key => !['jsonrpc', 'id', 'result', 'error'].includes(key))) fail('service_response_invalid');
  if (Object.hasOwn(envelope, 'error')) fail('service_refused');
  const result = envelope.result;
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.isError === true) fail('service_refused');
  if (result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
    return result.structuredContent;
  }
  if (!Array.isArray(result.content) || result.content.length !== 1
      || result.content[0]?.type !== 'text' || typeof result.content[0].text !== 'string'
      || Buffer.byteLength(result.content[0].text, 'utf8') > MCP_RESPONSE_BYTES) fail('service_response_invalid');
  try { return JSON.parse(result.content[0].text); } catch { fail('service_response_invalid'); }
}

export function createProjectsTransport({ fetchImpl = globalThis.fetch, env = process.env,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof fetchImpl !== 'function') fail('service_transport_unavailable');
  const configuration = readTransportConfiguration(env);
  return async argumentsValue => {
    const rpcId = randomUUID();
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), MCP_DEADLINE_MS);
    try {
      let response;
      try {
        response = await fetchImpl(configuration.endpoint, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: {
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${configuration.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call',
            params: { name: TOOL_NAME, arguments: argumentsValue } })
        });
      } catch (error) {
        fail(error?.name === 'AbortError' ? 'service_timeout' : 'service_unavailable');
      }
      if (response.status >= 300 && response.status < 400) fail('service_redirect_refused');
      if (!response.ok) fail(response.status === 401 || response.status === 403
        ? 'service_authentication_failed' : 'service_unavailable');
      const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (!CONTENT_TYPES.has(type)) fail('service_response_invalid');
      let body;
      try { body = await boundedBytes(response); }
      catch (error) {
        if (error instanceof TransportError) throw error;
        fail(error?.name === 'AbortError' ? 'service_timeout' : 'service_response_invalid');
      }
      let envelope;
      try { envelope = type === 'text/event-stream' ? parseSse(body) : JSON.parse(body); }
      catch (error) { if (error instanceof TransportError) throw error; fail('service_response_invalid'); }
      return unwrapToolResult(envelope, rpcId);
    } finally { clearTimer(timer); }
  };
}
