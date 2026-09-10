import assert from "node:assert/strict";
import { storageBucket } from "../worker/storage.js";
import { serveMedia, deleteObjectsByPrefix } from "../worker/media.js";
import { serveDocumentFile, deleteDocumentsByPrefix } from "../worker/portal.js";
const env={STORAGE_BACKEND:"supabase",SUPABASE_URL:"https://storage.example.test",SUPABASE_SERVICE_ROLE_KEY:"server-only-test-key"};
const objects=new Map(), calls=[];
let checks=0, fail=false, ignoreRange=false;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const original=globalThis.fetch;
globalThis.fetch=async(input,init={})=>{
  const path=new URL(input).pathname.replace("/storage/v1/", ""),headers=new Headers(init.headers);calls.push({path,method:init.method});
  eq(headers.get("apikey"),env.SUPABASE_SERVICE_ROLE_KEY);
  if(fail)return Response.json({message:"Storage unavailable"},{status:500});
  if(path.startsWith("object/list/")){
    const bucket=path.slice("object/list/".length),body=JSON.parse(init.body),prefix=`${bucket}/${body.prefix}/`, entries=new Map();
    for(const key of [...objects.keys()].sort())if(key.startsWith(prefix)){
      const rest=key.slice(prefix.length),name=rest.split("/")[0];entries.set(name,{name,id:rest.includes("/")?null:name});
    }
    return Response.json([...entries.values()].slice(body.offset,body.offset+body.limit));
  }
  if(init.method==="DELETE"){
    const bucket=path.slice("object/".length);for(const key of JSON.parse(init.body).prefixes)objects.delete(`${bucket}/${key}`);
    return Response.json([]);
  }
  const key=decodeURIComponent(path.replace(/^object\/(authenticated\/)?/,""));
  if(init.method==="POST"){
    if(objects.has(key))return Response.json({message:"Duplicate"},{status:409});
    objects.set(key,{bytes:new Uint8Array(await new Response(init.body).arrayBuffer()),type:headers.get("Content-Type")});return Response.json({Key:key});
  }
  const object=objects.get(key);if(!object)return new Response(null,{status:404});
  const replyHeaders={"Content-Type":object.type,"Content-Length":String(object.bytes.length),ETag:'"test-etag"'};
  if(init.method==="HEAD")return new Response(null,{headers:replyHeaders});
  const range=headers.get("Range");
  if(range && !ignoreRange){
    const [,a,b]=/^bytes=(\d*)-(\d*)$/.exec(range),offset=a?Number(a):Math.max(0,object.bytes.length-Number(b));
    if(offset>=object.bytes.length)return new Response(null,{status:416});
    const end=a&&b?Math.min(Number(b)+1,object.bytes.length):object.bytes.length,bytes=object.bytes.slice(offset,end);
    return new Response(bytes,{status:206,headers:{...replyHeaders,"Content-Length":String(bytes.length),"Content-Range":`bytes ${offset}-${end-1}/${object.bytes.length}`}});
  }
  return new Response(object.bytes,{headers:replyHeaders});
};
try{
  const media=storageBucket(env,"listing-media"),docs=storageBucket(env,"applicant-docs");
  await media.put("listing/photo.jpg",new Uint8Array([1,2,3,4,5]),{httpMetadata:{contentType:"image/jpeg"}});
  await docs.put("application/private.pdf",new Uint8Array([7,8,9]),{httpMetadata:{contentType:"application/pdf"}});
  const image=await serveMedia(new Request("https://website.test/media/listing/photo.jpg"),env,"/media/listing/photo.jpg");eq(image.status,200);eq([...new Uint8Array(await image.arrayBuffer())],[1,2,3,4,5]);
  const range=await serveMedia(new Request("https://website.test/media/listing/photo.jpg",{headers:{Range:"bytes=1-3"}}),env,"/media/listing/photo.jpg");eq(range.status,206);eq(range.headers.get("Content-Range"),"bytes 1-3/5");eq([...new Uint8Array(await range.arrayBuffer())],[2,3,4]);
  const suffix=await serveMedia(new Request("https://website.test/media/listing/photo.jpg",{headers:{Range:"bytes=-2"}}),env,"/media/listing/photo.jpg");eq([...new Uint8Array(await suffix.arrayBuffer())],[4,5]);
  const head=await serveMedia(new Request("https://website.test/media/listing/photo.jpg",{method:"HEAD"}),env,"/media/listing/photo.jpg");eq(head.headers.get("Content-Length"),"5");eq(await head.text(),"");
  const invalid=await serveMedia(new Request("https://website.test/media/listing/photo.jpg",{headers:{Range:"bytes=50-"}}),env,"/media/listing/photo.jpg");eq(invalid.status,416);
  ignoreRange=true;
  const full=await serveMedia(new Request("https://website.test/media/listing/photo.jpg",{headers:{Range:"bytes=1-3"}}),env,"/media/listing/photo.jpg");eq(full.status,200);eq(full.headers.get("Content-Length"),"5");eq([...new Uint8Array(await full.arrayBuffer())],[1,2,3,4,5]);ignoreRange=false;
  eq((await serveMedia(new Request("https://website.test/media/application/private.pdf"),env,"/media/application/private.pdf")).status,404);
  const document=await serveDocumentFile(env,{path:"application/private.pdf",file_name:"private.pdf",content_type:"application/pdf"});eq(document.status,200);eq(document.headers.get("Cache-Control"),"private, no-store");eq([...new Uint8Array(await document.arrayBuffer())],[7,8,9]);
  const stream=new Blob(["streamed upload"]).stream();await media.put("listing/video.mp4",stream,{httpMetadata:{contentType:"video/mp4"}});eq(await (await media.get("listing/video.mp4")).arrayBuffer().then(b=>new TextDecoder().decode(b)),"streamed upload");
  for(let i=0;i<205;i++)objects.set(`listing-media/listing/${i}.jpg`,{bytes:new Uint8Array([1]),type:"image/jpeg"});
  objects.set("listing-media/listing/nested/plan.jpg",{bytes:new Uint8Array([2]),type:"image/jpeg"});
  objects.set("listing-media/other/keep.jpg",{bytes:new Uint8Array([3]),type:"image/jpeg"});
  await deleteObjectsByPrefix(env,"listing/");eq([...objects.keys()].filter(k=>k.startsWith("listing-media/listing/")).length,0);eq(objects.has("listing-media/other/keep.jpg"),true);
  await deleteDocumentsByPrefix(env,"application/");eq(objects.has("applicant-docs/application/private.pdf"),false);
  await assert.rejects(()=>media.get("../applicant-docs/private.pdf"));checks++;
  fail=true;await assert.rejects(()=>docs.put("application/new.pdf",new Uint8Array([1])));checks++;
  eq((await serveMedia(new Request("https://website.test/media/other/keep.jpg"),env,"/media/other/keep.jpg")).status,503);
  console.log(`PASS ${checks} Supabase Storage checks: private documents, streamed media, ranges, HEAD, errors and multi-page cleanup`);
}finally{globalThis.fetch=original;}
