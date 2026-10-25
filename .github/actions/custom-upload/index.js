const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const name = process.env['INPUT_NAME'];
const file = process.env['INPUT_FILE'];
const ct = process.env['INPUT_CONTENT-TYPE'];
const resultsUrl = process.env.ACTIONS_RESULTS_URL;
const token = process.env.ACTIONS_RUNTIME_TOKEN;

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
  console.log('Results URL: ' + (resultsUrl ? 'SET' : 'NOT SET'));
  console.log('Token: ' + (token ? 'SET' : 'NOT SET'));
  if (!resultsUrl || !token) fail('Missing env vars');

  const jwt = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const scope = (jwt.scp || '').split(' ').find(s => s.startsWith('Actions.Results:'));
  const ids = scope ? scope.split(':')[1] : '';
  const [wfRunId, wfJobRunId] = ids.split('/');
  console.log('Backend IDs: ' + wfRunId + ' / ' + wfJobRunId);

  const payload = fs.readFileSync(file);
  console.log('File: ' + file + ' size: ' + payload.length);
  console.log('CT input: ' + JSON.stringify(ct) + ' hex: ' + Buffer.from(ct).toString('hex'));

  console.log('Creating artifact: ' + name);
  const createResp = await post('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', {
    workflowRunBackendId: wfRunId, workflowJobRunBackendId: wfJobRunId, name: name, version: 4,
  });
  console.log('Create resp: ' + JSON.stringify(createResp).substring(0, 300));

  const uploadUrl = createResp.signed_upload_url || createResp.signedUploadUrl;
  if (!uploadUrl) fail('No upload URL');

  console.log('Uploading blob...');
  const uploadResp = await putBlob(uploadUrl, payload, ct);
  console.log('Upload status: ' + uploadResp.status);
  if (uploadResp.status >= 400) console.log('Error: ' + uploadResp.body.substring(0, 300));

  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  console.log('Finalizing, hash: ' + hash);
  const finalResp = await post('/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact', {
    workflowRunBackendId: wfRunId, workflowJobRunBackendId: wfJobRunId, name: name,
    size: String(payload.length), hash: 'sha256:' + hash,
  });
  console.log('Finalize: ' + JSON.stringify(finalResp));
})().catch(e => fail(e.message));
