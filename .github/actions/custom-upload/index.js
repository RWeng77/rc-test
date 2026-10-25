const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const name = process.env['INPUT_NAME'];
const fileInput = process.env['INPUT_FILE'];
const resultsUrl = process.env.ACTIONS_RESULTS_URL;
const token = process.env.ACTIONS_RUNTIME_TOKEN;
const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

const NEL_CT = 'application/json' + String.fromCharCode(0x85);

function fail(msg) { console.log('::error::' + msg); process.exit(1); }

async function post(endpoint, body) {
  const url = new URL(endpoint, resultsUrl);
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function putBlob(signedUrl, data, contentType) {
  const url = new URL(signedUrl);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': data.length, 'x-ms-blob-type': 'BlockBlob' },
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
  console.log('Workspace:', workspace);
  console.log('File input:', JSON.stringify(fileInput));
  if (!resultsUrl || !token) fail('Missing env vars');

  const filePath = fileInput ? path.resolve(workspace, fileInput) : '';
  console.log('Resolved file:', filePath);
  if (!filePath || !fs.existsSync(filePath)) fail('File not found: ' + filePath);

  const jwt = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  console.log('JWT scp:', jwt.scp);
  const scope = (jwt.scp || '').split(' ').find(s => s.startsWith('Actions.Results:'));
  const idPart = scope ? scope.split(':')[1] : '';
  const parts = idPart.split('/');
  const wfRunId = parts[0] || '';
  const wfJobRunId = parts[1] || '';
  console.log('Backend IDs:', wfRunId, '/', wfJobRunId);

  if (!wfRunId || !wfJobRunId) {
    console.log('Trying alternative ID extraction...');
    console.log('All scopes:', jwt.scp);
    const ac = jwt.ac;
    console.log('ac claim:', JSON.stringify(ac));
  }

  const payload = fs.readFileSync(filePath);
  console.log('Payload size:', payload.length);
  console.log('CT hex:', Buffer.from(NEL_CT).toString('hex'));

  console.log('Creating artifact:', name);
  const createResp = await post('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', {
    workflowRunBackendId: wfRunId, workflowJobRunBackendId: wfJobRunId, name: name, version: 4,
  });
  console.log('Create:', JSON.stringify(createResp).substring(0, 500));

  const uploadUrl = createResp.signed_upload_url || createResp.signedUploadUrl;
  if (!uploadUrl) fail('No upload URL');

  console.log('Uploading with NEL CT...');
  const uploadResp = await putBlob(uploadUrl, payload, NEL_CT);
  console.log('Upload status:', uploadResp.status);
  if (uploadResp.status >= 400) console.log('Upload error:', uploadResp.body.substring(0, 500));

  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  console.log('Finalizing, hash:', hash);
  const finalResp = await post('/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact', {
    workflowRunBackendId: wfRunId, workflowJobRunBackendId: wfJobRunId, name: name,
    size: String(payload.length), hash: 'sha256:' + hash,
  });
  console.log('Finalize:', JSON.stringify(finalResp));

  if (finalResp.artifactId) {
    console.log('::set-output name=artifact-id::' + finalResp.artifactId);
  }
})().catch(e => { console.error(e); fail(e.message); });
