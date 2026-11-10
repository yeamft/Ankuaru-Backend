import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Versioned encoding fixes the work factor and prevents stored parameters from
// requesting unbounded work. 128 * N * r is approximately 128 MiB per hash.
const PREFIX = "scrypt-v1";
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${PREFIX}$${salt.toString("hex")}$${key.toString("hex")}`;
}

// Unknown emails take the same expensive verification path as registered ones.
const DUMMY_HASH = `${PREFIX}$${"0".repeat(32)}$${"0".repeat(128)}`;
export async function verifyPassword(password: string, encoded = DUMMY_HASH): Promise<boolean> {
  const [version, salt, digest, extra] = encoded.split("$");
  if (
    version !== PREFIX ||
    !/^[a-f0-9]{32}$/.test(salt ?? "") ||
    !/^[a-f0-9]{128}$/.test(digest ?? "") ||
    extra !== undefined
  )
    return false;
  const actual = await derive(password, Buffer.from(salt, "hex"));
  return timingSafeEqual(actual, Buffer.from(digest, "hex"));
}
