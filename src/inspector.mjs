export class Inspector {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else {
        for (const listener of this.events.get(message.method) ?? []) listener(message.params);
      }
    });
    this.ws.addEventListener('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('App inspector disconnected'));
      }
      this.pending.clear();
    });
  }
  once(method, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const listeners = this.events.get(method) ?? new Set();
      this.events.set(method, listeners);
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      const listener = (params) => {
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(params);
      };
      listeners.add(listener);
    });
  }
  async call(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Inspector timed out: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.ws.close();
  }
}
