import { hash, verify } from '@node-rs/argon2';

// argon2id with OWASP-recommended parameters (19 MiB, t=2, p=1).
const OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTS);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

/** A valid hash to verify against when the user does not exist (keeps timing flat). */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('dummy-password-for-timing');
  return dummy;
}
