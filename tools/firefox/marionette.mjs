import net from 'node:net';

// Marionette protocol v3: byte-length-prefixed UTF-8 JSON, command/response arrays.
// No geckodriver download or third-party client is needed.
export class Marionette {
  constructor(socket, timeout = 30_000) {
    this.socket = socket;
    this.timeout = timeout;
    this.buffer = Buffer.alloc(0);
    this.sequence = 0;
    this.pending = new Map();
    this.greeting = new Promise((resolve, reject) => { this.ready = resolve; this.notReady = reject; });
    socket.on('data', chunk => this.receive(chunk));
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('Marionette connection closed')));
  }
  fail(error) {
    this.notReady(error);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const colon = this.buffer.indexOf(58);
      if (colon < 0) return;
      const lengthText = this.buffer.subarray(0, colon).toString('ascii');
      if (!/^\d+$/.test(lengthText) || Number(lengthText) > 8 * 1024 * 1024) {
        this.socket.destroy(new Error('Invalid Marionette frame length')); return;
      }
      const length = Number(lengthText);
      if (this.buffer.length < colon + 1 + length) return;
      let message;
      try { message = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + length).toString('utf8')); }
      catch (error) { this.socket.destroy(error); return; }
      this.buffer = this.buffer.subarray(colon + 1 + length);
      if (!Array.isArray(message)) { this.ready(message); continue; }
      const [type, id, error, result] = message;
      if (type !== 1) continue;
      const item = this.pending.get(id);
      if (!item) continue;
      clearTimeout(item.timer); this.pending.delete(id);
      if (error) item.reject(new Error(`${error.error}: ${error.message}`));
      else item.resolve(result);
    }
  }
  command(name, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Marionette timeout: ${name}`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      const bytes = Buffer.from(JSON.stringify([0, id, name, params]));
      this.socket.write(Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]));
    });
  }
  async script(script, args = [], { context = 'chrome', async = false } = {}) {
    await this.command('Marionette:SetContext', { value: context });
    const result = await this.command(async ? 'WebDriver:ExecuteAsyncScript' : 'WebDriver:ExecuteScript', {
      script, args, newSandbox: true, sandbox: 'default', scriptTimeout: this.timeout - 1000,
    });
    return result.value;
  }
  close() { this.socket.destroy(); }
}

export async function connectMarionette(port, { timeout = 30_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      const client = new Marionette(socket, timeout);
      let hello;
      const timer = setTimeout(() => socket.destroy(new Error('Marionette greeting timed out')), timeout);
      try { hello = await client.greeting; } finally { clearTimeout(timer); }
      if (hello.marionetteProtocol !== 3) { client.close(); throw new Error('Unsupported Marionette protocol'); }
      await client.command('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
      return client;
    } catch (error) {
      if (error.code !== 'ECONNREFUSED') throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('Firefox did not start Marionette within deadline');
}
