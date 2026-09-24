import assert from 'node:assert/strict';
import {build} from 'esbuild';
import * as runtime from 'miniflare';
const {outputFiles}=await build({stdin:{resolveDir:process.cwd(),contents:`
import {serveMedia} from './worker/media.js';
let reads=0;
export default {async fetch(request, env, ctx) {
 const path=new URL(request.url).pathname;
 if(path==='/reads')return Response.json(reads);
 env.MEDIA={get:async key=>{reads++;return {body:new Uint8Array([1,2,3]),size:3,httpEtag:'"test"',httpMetadata:{contentType:key.endsWith('.mp4')?'video/mp4':'image/jpeg'}};}};
 return serveMedia(request,env,path,ctx);
}};`},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const options={modules:true,script:outputFiles[0].text,compatibilityDate:'2026-07-01'};
const mf=new runtime.Miniflare(runtime.convertV4MiniflareOptions?runtime.convertV4MiniflareOptions(options):options);
try {
 for(let n=0;n<2;n++){const r=await mf.dispatchFetch('http://localhost/media/test/photo.jpg');assert.equal(r.status,200);await r.arrayBuffer();}
 assert.equal(await (await mf.dispatchFetch('http://localhost/reads')).json(),1);
 for(let n=0;n<2;n++){const r=await mf.dispatchFetch('http://localhost/media/test/video.mp4');await r.arrayBuffer();}
 assert.equal(await (await mf.dispatchFetch('http://localhost/reads')).json(),3);
 const range=await mf.dispatchFetch('http://localhost/media/test/photo.jpg',{headers:{Range:'bytes=0-1'}});assert.equal(range.status,206);await range.arrayBuffer();
 assert.equal(await (await mf.dispatchFetch('http://localhost/reads')).json(),4);
 console.log('PASS public image edge caching; video and range requests retain storage behavior');
} finally {await mf.dispose();}
