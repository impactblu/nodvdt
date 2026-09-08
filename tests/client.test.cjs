const test = require('node:test');
const assert = require('node:assert/strict');
global.location = {href: 'https://owner.github.io/pcs-atlas/'};
require('../site/client.js');
const {Client, normalizeBaseUrl} = global.PCSClient;
const response = (data, status = 200) => new Response(JSON.stringify(data), {status});

test('GitHub project paths do not affect the NAS API origin', () => {
  assert.equal(normalizeBaseUrl('https://pcs-api.example.test/'), 'https://pcs-api.example.test');
  for (const bad of ['http://192.168.0.137:8088','https://u:p@example.test','https://example.test/api','https://example.test/?password=p']) {
    assert.throws(() => normalizeBaseUrl(bad));
  }
  assert.equal(normalizeBaseUrl('http://localhost:8088','http://localhost:9000/'), 'http://localhost:8088');
  assert.throws(() => normalizeBaseUrl('http://localhost:8088'));
});

test('JSON calls go directly to NAS with explicit auth and no cookies or redirects', async () => {
  const calls=[];
  global.fetch=async (url,options)=>{calls.push({url,options});return response({ok:true});};
  const client=new Client();
  await client.signIn('https://pcs-api.example.test','admin','private-password');
  await client.json('/products',{method:'POST',body:{model:'PCS'}});
  assert.equal(calls[0].url,'https://pcs-api.example.test/api/bootstrap');
  const {url,options}=calls[1];
  assert.equal(url,'https://pcs-api.example.test/api/products');
  assert.equal(options.credentials,'omit');
  assert.equal(options.redirect,'error');
  assert.equal(options.cache,'no-store');
  assert.equal(options.headers.get('Authorization'),'Basic '+Buffer.from('admin:private-password').toString('base64'));
  assert.equal(options.headers.get('X-PCS-Request'),'1');
  assert.equal(options.body,JSON.stringify({model:'PCS'}));
  assert.ok(!url.includes('private-password'));
  client.signOut();
});

test('multipart uploads keep the browser-generated boundary', async () => {
  let last;
  global.fetch=async (url,options)=>{last=options;return response({ok:true});};
  const client=new Client();await client.signIn('https://pcs-api.example.test','admin','private-password');
  const form=new FormData();form.set('file',new Blob(['private contents']),'notes.txt');
  await client.json('/upload',{method:'POST',body:form});
  assert.equal(last.body,form);
  assert.equal(last.headers.has('Content-Type'),false);
  client.signOut();
});

test('documents and CSV are fetched with authentication and retain file metadata', async () => {
  const client=new Client();global.fetch=async ()=>response({ok:true});
  await client.signIn('https://pcs-api.example.test','admin','private-password');
  global.fetch=async (url,options)=>{
    assert.equal(url,'https://pcs-api.example.test/api/revisions/7/file?download=true');
    assert.ok(options.headers.get('Authorization'));
    return new Response('private file bytes',{headers:{'Content-Disposition':'attachment; filename="notes.txt"','Content-Type':'application/octet-stream'}});
  };
  const result=await client.file('/revisions/7/file?download=true');
  assert.equal(await result.blob.text(),'private file bytes');
  assert.ok(result.disposition.includes('notes.txt'));client.signOut();
});

test('failed login drops the credential and permits a fresh attempt', async () => {
  const client=new Client();global.fetch=async ()=>response({detail:'No access'},401);
  await assert.rejects(client.signIn('https://pcs-api.example.test','admin','wrong'),error=>error.status===401);
  assert.equal(client.signedIn,false);
  await assert.rejects(client.json('/bootstrap'),/Sign in/);
  global.fetch=async ()=>response({ok:true});
  await client.signIn('https://pcs-api.example.test','admin','new-password');
  assert.equal(client.signedIn,true);client.signOut();
});

test('sign-out aborts active requests and discards a late result', async () => {
  const client=new Client();global.fetch=async ()=>response({ok:true});
  await client.signIn('https://pcs-api.example.test','admin','private-password');
  let complete,signal;
  global.fetch=(url,options)=>{signal=options.signal;return new Promise(resolve=>{complete=resolve;});};
  const pending=client.json('/products');client.signOut();
  assert.equal(signal.aborted,true);complete(response([{model:'private'}]));
  await assert.rejects(pending,/signed out/);assert.equal(client.authorization,'');
});

test('network errors explain the deployment connection instead of exposing raw fetch failures', async () => {
  global.fetch=async ()=>{throw new TypeError('Failed to fetch');};
  const client=new Client();
  await assert.rejects(client.signIn('https://pcs-api.example.test','admin','private-password'),/HTTPS address, network or VPN connection/);
  assert.equal(client.signedIn,false);
});
