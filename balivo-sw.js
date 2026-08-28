const CACHE='balivo-v3-complete';
const RUNTIME='./balivo-runtime.js';
const CORE=['./','./index.html','./admin.html','./balivo-manifest.webmanifest','./balivo-admin-manifest.webmanifest',RUNTIME,'./balivo-admin-sw.js'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(async c=>{await Promise.all(CORE.map(async u=>{try{const r=await fetch(u,{cache:'no-store'});if(r.ok)await c.put(u,r)}catch(_){}}));return self.skipWaiting()})));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE&&k.startsWith('balivo-')).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET')return;
 const url=new URL(e.request.url);
 if(url.origin!==self.location.origin)return;
 e.respondWith((async()=>{
   const cached=await caches.match(e.request);
   try{
     const fresh=await fetch(e.request,{cache:'no-store'});
     if(!fresh.ok)return cached||fresh;
     if(url.pathname.endsWith('/index.html')||url.pathname.endsWith('/')){
       const text=await fresh.clone().text();
       if(!text.includes('balivo-runtime.js')){
         const injected=text.replace(/<\/body>/i,'<script src="./balivo-runtime.js"></script></body>');
         const response=new Response(injected,{status:fresh.status,statusText:fresh.statusText,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'}});
         const c=await caches.open(CACHE);await c.put(e.request,response.clone());return response;
       }
     }
     const c=await caches.open(CACHE);await c.put(e.request,fresh.clone());return fresh;
   }catch(_){return cached||caches.match('./index.html')}
 })());
});
