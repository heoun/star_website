import assert from 'node:assert/strict';
import {build} from 'esbuild';
import * as runtime from 'miniflare';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {chromium} from 'playwright';
const pages=Object.fromEntries(await Promise.all(['rental','buy','commercial'].map(async name=>[`/${name}/`,await readFile(`dist/${name}/index.html`,'utf8')])));
const listing={id:'test-home',title:'Real Published Home <safe>',category:'residential',transaction_group:'rental',price:'$4,000/mo',location:'100 Example Street',bedrooms:2,bathroom:1,image_url:'/jpg/listing-bkg.jpeg'};
const {outputFiles}=await build({stdin:{resolveDir:process.cwd(),contents:`
import {serveListingPage} from './worker/listing-pages.js';
export default {async fetch(request, env, ctx) {
 const url = new URL(request.url);
 const listing = ${JSON.stringify(listing)};
 const listings = url.searchParams.has('empty') ? [] : [listing, {...listing,id:'sale',title:'Sale Home',transaction_group:'sale'}, {...listing,id:'commercial',title:'Office Space',category:'commercial'}];
 const payload = {source:url.searchParams.has('fail') ? 'fallback' : 'supabase',listings};
 await caches.default.put(new Request(new URL('/data/listings.json',request.url)), Response.json(payload, {headers:{"Cache-Control":"public, max-age=60"}}));
 env.ASSETS = {fetch:async () => new Response(env.PAGES[url.pathname] || '', {headers:{'Content-Type':'text/html','ETag':'static-asset'}})};
 return serveListingPage(request,env,ctx);
}};`},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const options={modules:true,script:outputFiles[0].text,compatibilityDate:'2026-07-01',bindings:{PAGES:pages}};
const mf=new runtime.Miniflare(runtime.convertV4MiniflareOptions?runtime.convertV4MiniflareOptions(options):options);
let browser;
try {
 for (const [path,title] of [['/rental/','Real Published Home &lt;safe&gt;'],['/buy/','Sale Home'],['/commercial/','Office Space']]) {
  const response=await mf.dispatchFetch('http://localhost'+path);
  assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('ETag'),null);
  const html=await response.text();assert(html.includes(title));assert(html.includes('data-rendered="true"'));assert(!html.includes('Placeholder feed pending'));
 }
 assert((await (await mf.dispatchFetch('http://localhost/rental/?q=missing')).text()).includes('No listings match your search'));
 assert((await (await mf.dispatchFetch('http://localhost/rental/?empty')).text()).includes('No active rental listings right now'));
 const failed=await (await mf.dispatchFetch('http://localhost/rental/?fail')).text();assert(failed.includes('Listings are temporarily unavailable'));assert(!failed.includes('Real Published Home &lt;safe&gt;'));
 browser=await chromium.launch({headless:true});
 let feedRequests=0;
 for (const viewport of [{width:1280,height:800},{width:390,height:844}]) {
 const slowContext=await browser.newContext({viewport});
 const slowPage=await slowContext.newPage();
 await slowPage.addInitScript(() => {window.layoutShifts=[];new PerformanceObserver(list => {for(const entry of list.getEntries())if(!entry.hadRecentInput)window.layoutShifts.push(entry.value);}).observe({type:'layout-shift',buffered:true});});
 let releasePhoto;const photoGate=new Promise(resolve=>releasePhoto=resolve);
 const requested=[];
 await slowContext.route('**/*',async route=>{
  const url=new URL(route.request().url());requested.push(url.pathname);
  if(url.hostname!=='localhost')return route.abort();
  if(url.pathname==='/rental/'){const r=await mf.dispatchFetch(url.href);return route.fulfill({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()});}
  if(url.pathname===listing.image_url)await photoGate;
  if(url.pathname.endsWith('.woff2'))await new Promise(resolve=>setTimeout(resolve,800));
  try{return route.fulfill({body:await readFile(resolve('dist','.'+url.pathname)),contentType:({'.js':'text/javascript','.css':'text/css','.jpeg':'image/jpeg','.woff2':'font/woff2'})[extname(url.pathname)]||'application/octet-stream'});}catch{return route.abort();}
 });
 await slowPage.goto('http://localhost/rental/',{waitUntil:'domcontentloaded'});
 await slowPage.waitForTimeout(150);
 const card=slowPage.locator('.listing-card');
 const before=await card.boundingBox();
 assert.equal(await slowPage.locator('.listing-media').evaluate(el=>getComputedStyle(el).backgroundImage),'none');
 assert.equal(await slowPage.locator('.listing-photo').getAttribute('loading'),'eager');
 assert.equal(await slowPage.locator('.listing-photo').getAttribute('fetchpriority'),'high');
 assert.equal(await slowPage.locator('link[rel=preload][as=image][fetchpriority=high]').count(),1);
 await slowPage.screenshot({path:'/tmp/listing-slow-before.png'});
 releasePhoto();
 await slowPage.waitForLoadState('load');
 await slowPage.evaluate(()=>document.fonts.ready);
 assert.deepEqual(await card.boundingBox(),before);
 assert.equal(await slowPage.evaluate(()=>window.layoutShifts.reduce((a,b)=>a+b,0)),0);
 assert(!requested.includes('/jpg/unit-bkg.jpeg'));
 assert(!requested.includes('/data/listings.json'));
 await slowPage.screenshot({path:'/tmp/listing-slow-after.png'});
 console.log(`PASS slow-loading ${viewport.width}px: zero layout shift, no substitute photo, no feed refetch`);
 await slowContext.close();
 }
 for(const javaScriptEnabled of [false,true]) {
  const context=await browser.newContext({javaScriptEnabled});
  const page=await context.newPage();
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/data/listings.json'){feedRequests++;return route.abort();}
   if(url.pathname==='/rental/') {const r=await mf.dispatchFetch(url.href);return route.fulfill({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()});}
   if(url.hostname!=='localhost')return route.abort();
   try {const path=resolve('dist','.'+url.pathname);return route.fulfill({body:await readFile(path),contentType:({'.js':'text/javascript','.css':'text/css','.jpeg':'image/jpeg','.png':'image/png'})[extname(path)]||'application/octet-stream'});}catch{return route.abort();}
  });
  await page.goto('http://localhost/rental/');
  assert.equal(await page.locator('.listing-card h5').textContent(),listing.title);
  assert.equal(await page.locator('.listing-state').count(),0);
  if(javaScriptEnabled)await page.screenshot({path:'/tmp/listing-first-render.png',fullPage:true});
  await context.close();
 }
 assert.equal(feedRequests,0);
 console.log('PASS listing first render: real cards without JavaScript, no browser refetch, search, categories, empty and failure states');
} finally {await browser?.close();await mf.dispose();}
