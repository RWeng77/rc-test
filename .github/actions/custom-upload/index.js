const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const core = require('@actions/core');

const resultsUrl = process.env.ACTIONS_RESULTS_URL;
const token = process.env.ACTIONS_RUNTIME_TOKEN;

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

async function run() {
  const name = core.getInput('name');
  const file = core.getInput('file');
  const ct = core.getInput('content-type');

  console.log('Results URL:', resultsUrl ? 'SET' : 'NOT SET');
  console.log('Token:', token ? 'SET' : 'NOT SET');

  if (!resultsUrl || !token) {
    core.setFailed('Missing ACTIONS_RESULTS_URL or ACTIONS_RUNTIME_TOKEN');
    return;
  }

  // Parse JWT for backend IDs
  const jwt = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const scope = (jwt.scp || '').split(' ').find(s => s.startsWith('Actions.Results:'));
  const ids = scope ? scope.split(':')[1] : '';
  const [wfRunId, wfJobRunId] = ids.split('/');
  console.log('Backend IDs:', wfRunId, wfJobRunId);

  const payload = fs.readFileSync(file);
  console.log('File size:', payload.length);
  console.log('Content-Type:', JSON.stringify(ct), 'hex:', Buffer.from(ct).toString('hex'));

  // Create artifact
  const createResp = await post('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', {
    workflowRunBackendId: wfRunId,
    workflowJobRunBackendId: wfJobRunId,
    name: name,
    version: 4,
  });
  console.log('Create:', JSON.stringify(createResp).substring(0, 300));

  const uploadUrl = createResp.signed_upload_url || createResp.signedUploadUrl;
  if (!uploadUrl) { core.setFailed('No upload URL'); return; }

  // Upload with custom CT
  const uploadResp = await putBlob(uploadUrl, payload, ct);
  console.log('Upload status:', uploadResp.status);
  if (uploadResp.status >= 400) console.log('Upload error:', uploadResp.body.substring(0, 300));

  // Finalize
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const finalResp = await post('/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact', {
    workflowRunBackendId: wfRunId,
    workflowJobRunBackendId: wfJobRunId,
    name: name,
    size: String(payload.length),
    hash: 'sha256:' + hash,
  });
  console.log('Finalize:', JSON.stringify(finalResp));
  core.setOutput('artifact-id', finalResp.artifactId || '');
}

run().catch(e => core.setFailed(e.message));
