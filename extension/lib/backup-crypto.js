const encoder = new TextEncoder();

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return encoder.encode(String(value ?? ""));
}

export function bytesToBase64(value) {
  const input = bytes(value);
  let binary = "";
  for (let offset = 0; offset < input.length; offset += 0x8000) {
    binary += String.fromCharCode(...input.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function derive(password, salt, iterations, usages) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(String(password)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations
  }, material, { name: "AES-GCM", length: 256 }, false, usages);
}

export async function sealBackupPayload(value, password, { iterations = 250000 } = {}) {
  if (!String(password || "")) throw new Error("Backup password is required");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt, iterations, ["encrypt"]);
  const plaintext = bytes(value);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    data: bytesToBase64(new Uint8Array(encrypted)),
    encryption: {
      scheme: "PBKDF2-SHA256/AES-256-GCM",
      iterations,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv)
    }
  };
}

export async function openBackupPayload(data, encryption, password) {
  if (!encryption || encryption.scheme !== "PBKDF2-SHA256/AES-256-GCM") throw new Error("Unsupported backup encryption scheme");
  if (!String(password || "")) throw new Error("Backup password is required");
  const iterations = Number(encryption.iterations);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 2000000) throw new Error("Invalid backup KDF iteration count");
  const salt = base64ToBytes(encryption.salt);
  const iv = base64ToBytes(encryption.iv);
  if (salt.length < 16 || iv.length !== 12) throw new Error("Invalid backup encryption parameters");
  const key = await derive(password, salt, iterations, ["decrypt"]);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, base64ToBytes(data));
    return new Uint8Array(plaintext);
  } catch {
    throw new Error("Unable to decrypt backup: password is wrong or the file was modified");
  }
}
