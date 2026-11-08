import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const credentialPath = process.env.GDRIVE_CREDENTIALS || 'D:\\jaip\\credentials.json';
if (!fs.existsSync(credentialPath) && !fs.existsSync(path.join(root, 'credentials.json'))) {
  throw new Error(`Place credentials.json at ${credentialPath} or ${path.join(root, 'credentials.json')}`);
}
if (!fs.existsSync(path.join(root, '.env'))) {
  const token = crypto.randomBytes(36).toString('base64url');
  const env = [
    `GDRIVE_CREDENTIALS=${fs.existsSync(credentialPath) ? credentialPath.replaceAll('\\', '/') : path.join(root, 'credentials.json').replaceAll('\\', '/')}`,
    'HOST=127.0.0.1', 'PORT=43821', `MORNYE_API_TOKEN=${token}`, '',
  ].join('\n');
  fs.writeFileSync(path.join(root, '.env'), env, { mode: 0o600, flag: 'wx' });
  console.log('Created .env with a generated API token. Keep it private.');
} else {
  console.log('.env already exists; left unchanged.');
}
console.log('Ready. Run npm start from the backend directory.');
