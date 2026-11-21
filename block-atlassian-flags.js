// Test-only: block Atlassian feature-flag traffic so the lab makes no requests to Atlassian.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (/atlassian\.com/.test(url) && /\/flags\/api\/v2\//.test(url)) {
    return Promise.reject(new Error('blocked by CI lab harness'));
  }
  return realFetch(input, init);
};
