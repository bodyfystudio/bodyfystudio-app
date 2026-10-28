import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env.push.local')) {
  throw new Error('.env.push.local already exists. Reuse those keys; do not rotate them for an existing app.');
}

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = publicKey.export({ format: 'jwk' });
const privateJwk = privateKey.export({ format: 'jwk' });
const vapidKeys = {
  publicKey: { ...publicJwk, key_ops: ['verify'], ext: true },
  privateKey: { ...privateJwk, key_ops: ['sign'], ext: true },
};
const publicBytes = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(publicJwk.x, 'base64url'),
  Buffer.from(publicJwk.y, 'base64url'),
]);
const browserPublicKey = publicBytes.toString('base64url');
const secretBundle = Buffer.from(JSON.stringify(vapidKeys)).toString('base64');
writeFileSync('.env.push.local', `VITE_VAPID_PUBLIC_KEY=${browserPublicKey}\nVAPID_KEYS_JSON_B64=${secretBundle}\n`, { mode: 0o600 });
let localEnv = existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '';
if (/^VITE_VAPID_PUBLIC_KEY=/m.test(localEnv)) {
  localEnv = localEnv.replace(/^VITE_VAPID_PUBLIC_KEY=.*$/m, `VITE_VAPID_PUBLIC_KEY=${browserPublicKey}`);
} else {
  localEnv = `${localEnv.trimEnd()}\nVITE_VAPID_PUBLIC_KEY=${browserPublicKey}\n`;
}
writeFileSync('.env.local', localEnv);
console.log('Created .env.push.local. Keep it private; it contains the VAPID private key.');
