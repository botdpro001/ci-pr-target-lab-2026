const http = require('http');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP = path.resolve(process.argv[2] || '');
const OUT = path.resolve(process.argv[3] || path.join(process.cwd(), 'proof'));
const CLI = process.env.FORGE_CLI_PATH || path.join(__dirname, 'node_modules/@forge/cli/out/bin/cli.js');
const NODE_PATH = process.env.FORGE_NODE_PATH || path.join(__dirname, 'node_modules');
const BLOCK = path.join(__dirname, 'block-atlassian-flags.js');
const HOME = process.env.HOME || process.env.USERPROFILE;
const OUTSIDE = path.join(HOME, '.docker', 'config.json');
const SECRET = process.env.FAKE_CI_SECRET || '';
const REQUIRE_SECRET = process.env.REQUIRE_SECRET === '1';

if (!process.argv[2] || !fs.existsSync(APP)) {
  console.error('usage: node ci-harness.js <pr-app-dir> <proof-dir>');
  process.exit(1);
}
if (!fs.existsSync(CLI)) {
  console.error('Forge CLI not found at', CLI);
  process.exit(1);
}
if (!fs.existsSync(OUTSIDE)) {
  console.error('outside JSON missing at', OUTSIDE);
  process.exit(1);
}

const UPLOADS = path.join(OUT, 'uploads');
const SERVED = path.join(OUT, 'served');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(SERVED, { recursive: true });

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const uploads = [];
let uploadIndex = 0;

const server = http.createServer((req, res) => {
  if (req.method === 'PUT' || (req.method === 'POST' && !req.url.endsWith('/graphql'))) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const idx = ++uploadIndex;
      const file = path.join(UPLOADS, `upload-${idx}.bin`);
      fs.writeFileSync(file, body);
      uploads.push({ idx, url: req.url, bytes: body.length, file });
      console.log(`[upload] ${req.method} ${req.url} ${body.length} bytes`);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const port = server.address().port;
    let payload = { data: {} };
    if (body.includes('forge_cli_getUserDetails')) {
      payload = { data: { me: { user: { name: 'CI Lab', accountStatus: 'active', accountId: 'ci-lab-id' } } } };
    } else if (body.includes('forge_cli_createAppManifestUploadUrl')) {
      payload = { data: { createAppManifestUploadUrl: { success: true, preSignedUrl: `http://127.0.0.1:${port}/manifest-upload`, errors: [] } } };
    } else if (body.includes('forge_cli_appPreDeploymentCheck')) {
      payload = { data: { appPreDeploymentCheck: { outcome: [] } } };
    } else if (body.includes('forge_cli_getDeploymentUrl')) {
      payload = { data: { createAppDeploymentUrl: { success: true, deploymentUrl: `http://127.0.0.1:${port}/deployment-upload`, errors: [] } } };
    } else if (body.includes('forge_cli_getHostedResourcesUploadUrls')) {
      payload = {
        data: {
          createHostedResourceUploadUrl: {
            success: true,
            preSignedUrls: [{ uploadUrl: `http://127.0.0.1:${port}/resource-upload`, uploadFormData: {} }],
            uploadId: 'ci-lab-upload-id',
            errors: []
          }
        }
      };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

server.listen(0, '127.0.0.1', () => {
  const gateway = `http://127.0.0.1:${server.address().port}/graphql`;
  console.log('[harness] app:', APP);
  console.log('[harness] outside JSON:', OUTSIDE);
  console.log('[harness] CLI:', CLI);
  console.log('[harness] gateway:', gateway);

  const child = spawn(process.execPath, [CLI, 'build'], {
    cwd: APP,
    env: {
      ...process.env,
      NODE_PATH,
      NODE_OPTIONS: `--require ${BLOCK}`,
      FORGE_GRAPHQL_GATEWAY: gateway,
      FORGE_EMAIL: 'ci-lab@example.invalid',
      FORGE_API_TOKEN: 'ci-lab-dummy-token',
      FORGE_DISABLE_ANALYTICS: '1',
      FORGE_NON_INTERACTIVE: 'on',
      FORGE_CLI_DISABLE_DEV_SPACE: 'true',
      FORGE_DISABLE_SEASONAL_EFFECTS: '1',
      NO_COLOR: '1'
    }
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 240000);

  child.on('close', (code) => {
    clearTimeout(timer);
    console.log('--- CLI stdout ---');
    process.stdout.write(stdout);
    console.log('--- CLI stderr ---');
    process.stdout.write(stderr);

    const resourceUpload = uploads.find((u) => u.url.includes('resource-upload'));
    if (!resourceUpload) {
      console.error('no hosted-resource upload captured');
      server.close(() => process.exit(2));
      return;
    }
    try {
      execFileSync('unzip', ['-o', resourceUpload.file, '-d', SERVED], { stdio: 'ignore' });
    } catch {}
    const packagedLocale = path.join(SERVED, '__LOCALES__', 'en-US.json');
    if (!fs.existsSync(packagedLocale)) {
      console.error('packaged locale missing at', packagedLocale);
      server.close(() => process.exit(2));
      return;
    }

    const packaged = fs.readFileSync(packagedLocale);
    const outside = fs.readFileSync(OUTSIDE);
    const packagedHash = hash(packaged);
    const outsideHash = hash(outside);
    const match = packagedHash === outsideHash;
    const marker = packaged.includes('PR_TARGET_LAB');
    const secretInPackaged = SECRET ? packaged.includes(SECRET) : false;
    const outsideIsOutside = (() => {
      const rel = path.relative(APP, OUTSIDE);
      return rel.startsWith('..') || path.isAbsolute(rel);
    })();

    const proof = [
      `event=${process.env.GITHUB_EVENT_NAME || ''}`,
      `base_repo=${process.env.GITHUB_REPOSITORY || ''}`,
      `pr_head_repo=${process.env.PR_HEAD_REPO || ''}`,
      `pr_author=${process.env.PR_AUTHOR || ''}`,
      `author_association=${process.env.PR_ASSOCIATION || ''}`,
      `secret_env_present=${SECRET ? 'true' : 'false'}`,
      `outside_is_outside_project=${outsideIsOutside}`,
      `build_exit=${code}`,
      `resource_upload_bytes=${resourceUpload.bytes}`,
      `packaged_locale_sha256=${packagedHash}`,
      `outside_file_sha256=${outsideHash}`,
      `packaged_equals_outside=${match}`,
      `packaged_contains_marker=${marker}`,
      `packaged_contains_secret=${secretInPackaged}`
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(OUT, 'proof.txt'), proof);
    console.log('--- proof ---');
    process.stdout.write(proof);

    const ok = match && marker && outsideIsOutside && (!REQUIRE_SECRET || (SECRET && secretInPackaged));
    server.close(() => process.exit(ok ? 0 : 3));
  });
});
