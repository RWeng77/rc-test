const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const name = process.env['INPUT_NAME'];
const fileInput = process.env['INPUT_FILE'];
const resultsUrl = process.env.ACTIONS_RESULTS_URL;
const token = process.env.ACTIONS_RUNTIME_TOKEN;
const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

// Phase 1: use clean mimeType for CreateArtifact, NEL only for blob CT
const CLEAN_CT = 'application/json';
const NEL_CT = 'application/json' + String.fromCharCode(0x85);

function fail(msg) { console.log('::error::' + msg); process.exit(1); }

function twirpPost(endpoint, body) {
  const url = new URL(endpoint, resultsUrl);
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Content-Length': Buffer.byteLength(data)
      },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => buf += d);
      res.on('end', () => {
        console.log('Twirp response status:', res.statusCode);
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function azurePut(signedUrl, data, contentType) {
  const url = new URL(signedUrl);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length,
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': contentType,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log('Results URL:', resultsUrl ? 'SET' : 'NOT SET');
  console.log('Token:', token ? 'SET' : 'NOT SET');
  if (!resultsUrl || !token) fail('Missing env vars');

  const filePath = path.resolve(workspace, fileInput);
  console.log('File:', filePath);
  if (!fs.existsSync(filePath)) fail('File not found: ' + filePath);

  const jwt = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const scope = (jwt.scp || '').split(' ').find(s => s.startsWith('Actions.Results:'));
  const scopeParts = scope ? scope.split(':') : [];
  const wfRunId = scopeParts[1] || '';
  const wfJobRunId = scopeParts[2] || '';
  console.log('Backend IDs:', wfRunId, '/', wfJobRunId);

  const payload = fs.readFileSync(filePath);
  console.log('Payload size:', payload.length);

  const artifactFileName = path.basename(filePath);
  console.log('Artifact filename:', artifactFileName);
  console.log('NEL CT hex:', Buffer.from(NEL_CT).toString('hex'));

  console.log('--- CreateArtifact (version 7 + mimeType) ---');
  const createResp = await twirpPost(
    '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact',
    {
      workflowRunBackendId: wfRunId,
      workflowJobRunBackendId: wfJobRunId,
      name: name,
      version: 7,
      mimeType: CLEAN_CT,
    }
  );
  console.log('Create:', JSON.stringify(createResp).substring(0, 400));

  const uploadUrl = createResp.signed_upload_url || createResp.signedUploadUrl;
  if (!uploadUrl) fail('No upload URL: ' + JSON.stringify(createResp));

  console.log('--- Upload blob with x-ms-blob-content-type ---');
  const uploadResp = await azurePut(uploadUrl, payload, NEL_CT);
  console.log('Upload status:', uploadResp.status);
  if (uploadResp.status >= 400) {
    console.log('Upload error:', uploadResp.body.substring(0, 500));
  }

  console.log('--- FinalizeArtifact ---');
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const finalResp = await twirpPost(
    '/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact',
    {
      workflowRunBackendId: wfRunId,
      workflowJobRunBackendId: wfJobRunId,
      name: name,
      size: String(payload.length),
      hash: 'sha256:' + hash,
    }
  );
  console.log('Finalize:', JSON.stringify(finalResp));
  if (finalResp.artifactId) {
    console.log('Artifact ID:', finalResp.artifactId);
  }
})().catch(e => { console.error(e); fail(e.message); });
