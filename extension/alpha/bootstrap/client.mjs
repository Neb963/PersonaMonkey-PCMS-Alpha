/** UI-only transport. It never imports/constructs Core or accesses persistence. */
export function createAlphaClient({ runtime = globalThis.browser?.runtime, randomId = () => crypto.randomUUID() } = {}) {
  return Object.freeze({ async request(command, params = {}, expectedRevision) {
    const requestId = randomId();
    const response = await runtime.sendMessage({ type: 'PCMS_UI_REQUEST', request: { v: 1, requestId, command, params,
      ...(expectedRevision === undefined ? {} : { expectedRevision }) } });
    if (!response || response.requestId !== requestId || typeof response.ok !== 'boolean' || !Number.isSafeInteger(response.revision)) {
      throw new Error('Alpha response is unavailable');
    }
    return response;
  } });
}
