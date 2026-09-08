'use strict';
(function (root) {
  function normalizeBaseUrl(value, pageUrl = root.location.href) {
    let url;
    try { url = new URL(String(value).trim()); }
    catch { throw new Error('Enter the full HTTPS address of your catalog server.'); }
    const page = new URL(pageUrl);
    const local = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
    const localDevelopment = page.protocol === 'http:' && local(page.hostname) && local(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localDevelopment)) {
      throw new Error('Use HTTPS for the catalog server. An HTTPS website cannot connect to a plain HTTP NAS address.');
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Use only the server origin, for example https://pcs-api.example.com, without /api or a password.');
    }
    return url.origin;
  }

  class Client {
    constructor() {
      this.base = '';
      this.authorization = '';
      this.generation = 0;
      this.requests = new Set();
    }
    get signedIn() { return Boolean(this.authorization); }
    signOut() {
      this.authorization = '';
      this.generation += 1;
      for (const controller of this.requests) controller.abort();
      this.requests.clear();
    }
    async signIn(base, user, password) {
      this.signOut();
      this.base = normalizeBaseUrl(base);
      if (!user || user.includes(':') || !password) throw new Error('Enter your catalog username and password.');
      const encoded = new TextEncoder().encode(user + ':' + password);
      this.authorization = 'Basic ' + btoa(Array.from(encoded, b => String.fromCharCode(b)).join(''));
      try { return await this.json('/bootstrap'); }
      catch (error) { this.signOut(); throw error; }
    }
    async request(path, options = {}) {
      if (!this.signedIn) throw new Error('Sign in to your catalog first.');
      if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/.test(path)) {
        throw new Error('Invalid catalog request path.');
      }
      const generation = this.generation;
      const controller = new AbortController();
      this.requests.add(controller);
      const timeout = setTimeout(() => controller.abort(), 210000);
      const headers = new Headers(options.headers || {});
      headers.set('Authorization', this.authorization);
      headers.set('X-PCS-Request', '1');
      let body = options.body;
      if (body && !(body instanceof FormData)) {
        headers.set('Content-Type', 'application/json');
        body = JSON.stringify(body);
      }
      try {
        let response;
        try {
          response = await fetch(this.base + '/api' + path, {
            ...options, body, headers, mode: 'cors', credentials: 'omit',
            cache: 'no-store', redirect: 'error', signal: controller.signal
          });
        } catch (error) {
          if (generation !== this.generation) throw new Error('You have signed out.');
          throw new Error(error.name === 'AbortError'
            ? 'The server took too long to respond. Check the connection and try again.'
            : 'Cannot reach the catalog server. Check its HTTPS address, network or VPN connection, and allowed website origin.');
        }
        if (generation !== this.generation) throw new Error('You have signed out.');
        if (!response.ok) {
          let data = {};
          try { data = await response.json(); } catch {}
          let detail = data.detail || `Request failed (${response.status}).`;
          if (Array.isArray(detail)) detail = detail.map(x => `${x.loc?.slice(1).join('.') || 'Input'}: ${x.msg}`).join('; ');
          const error = new Error(response.status === 401 ? 'The username or password was not accepted. Please sign in again.' : detail);
          error.status = response.status;
          throw error;
        }
        // Consume the response while cancellation and the session guard are active.
        const result = options.responseType === 'blob'
          ? {blob: await response.blob(), disposition: response.headers.get('Content-Disposition') || ''}
          : await response.json();
        if (generation !== this.generation) throw new Error('You have signed out.');
        return result;
      } finally {
        clearTimeout(timeout);
        this.requests.delete(controller);
      }
    }
    json(path, options = {}) { return this.request(path, {...options, responseType: 'json'}); }
    file(path) { return this.request(path, {responseType: 'blob'}); }
  }
  root.PCSClient = Object.freeze({Client, normalizeBaseUrl});
})(globalThis);
