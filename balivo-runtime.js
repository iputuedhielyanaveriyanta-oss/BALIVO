/* BALIVO customer completion layer
   Adds payment proof upload, order tracking/cancel/receive, verified review UI,
   cache-safe runtime loading. Uses the existing Supabase client and existing UI. */
(function(){
  'use strict';
  const SUPABASE_URL='https://hftgmssnzvrlwlslcaet.supabase.co';
  const SUPABASE_KEY='sb_publishable_xOadp1YRBil2PZ9RHeeWIQ_Z3LqMF-D';
  const sbx=window.sb || (window.supabase?.createClient ? window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY) : null);
  if(!sbx)return;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=n=>new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(Number(n)||0);
  const qs=s=>document.querySelector(s);
  const style=document.createElement('style');
  style.textContent=`
  #balivoUtilityBar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 18px}
  .balivo-util-btn{padding:10px 14px;border:1px solid #ddd;background:#fff;border-radius:999px;font-weight:700;cursor:pointer}
  .balivo-util-btn.dark{background:#111;color:#fff;border-color:#111}
  .balivo-modal{position:fixed;inset:0;background:#0009;z-index:10001;display:none;align-items:flex-end;justify-content:center;padding:0}
  .balivo-modal.open{display:flex}.balivo-sheet{width:min(680px,100%);max-height:92vh;overflow:auto;background:#fff;border-radius:22px 22px 0 0;padding:20px}
  .balivo-field{display:grid;gap:6px;margin:10px 0}.balivo-field label{font-size:12px;color:#666;font-weight:700}.balivo-field input,.balivo-field textarea,.balivo-field select{padding:12px;border:1px solid #ddd;border-radius:10px;width:100%;font:inherit}
  .balivo-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.balivo-actions button{padding:11px 14px;border-radius:10px;font-weight:800;border:1px solid #ddd;background:#fff}.balivo-actions .primary{background:#111;color:#fff;border-color:#111}
  .balivo-order{border:1px solid #ddd;border-radius:14px;padding:15px;margin-top:14px}.balivo-status{display:inline-block;background:#111;color:#fff;border-radius:999px;padding:5px 9px;font-size:11px;font-weight:800}.balivo-timeline{display:grid;gap:7px;margin-top:12px}.balivo-step{padding:9px 11px;border-left:3px solid #ddd;background:#fafafa;border-radius:0 8px 8px 0;font-size:13px}.balivo-step.done{border-left-color:#111;font-weight:700}.balivo-proof{margin-top:12px;padding:13px;border:1px dashed #bbb;border-radius:12px;background:#fafafa}.balivo-proof img{max-width:100%;max-height:260px;object-fit:contain;border-radius:10px;background:#fff}.balivo-note{font-size:12px;color:#777;line-height:1.5}.balivo-review-card{border-top:1px solid #eee;padding-top:14px;margin-top:14px}
  `;document.head.appendChild(style);

  function modal(id,title,body){
    let m=document.getElementById(id); if(!m){m=document.createElement('div');m.id=id;m.className='balivo-modal';document.body.appendChild(m)}
    m.innerHTML=`<div class="balivo-sheet"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><h2 style="margin:0">${title}</h2><button class="balivo-util-btn" data-close>✕</button></div>${body}</div>`;
    m.classList.add('open');m.onclick=e=>{if(e.target===m||e.target.closest('[data-close]'))m.classList.remove('open')};return m;
  }

  function addUtilityBar(){
    if(document.getElementById('balivoUtilityBar'))return;
    const bar=document.createElement('div');bar.id='balivoUtilityBar';
    bar.innerHTML='<button class="balivo-util-btn dark" id="balivoTrackBtn">📦 Lacak Pesanan</button><button class="balivo-util-btn" id="balivoLastOrderBtn">Pesanan Terakhir</button>';
    const main=document.querySelector('main'); if(main) main.insertBefore(bar,main.firstChild);
    document.getElementById('balivoTrackBtn').onclick=()=>showTrack();
    document.getElementById('balivoLastOrderBtn').onclick=()=>{const x=JSON.parse(localStorage.getItem('balivoLastOrder')||'null');x?showTrack(x.order_number,x.phone):showTrack()};
  }

  async function uploadProof(orderNumber,phone,file){
    if(!file)throw new Error('Pilih bukti pembayaran.');
    if(file.size>5*1024*1024)throw new Error('Foto maksimal 5 MB.');
    if(!/^image\/(jpeg|png|webp)$/.test(file.type))throw new Error('Gunakan JPG, PNG, atau WEBP.');
    const ext=(file.name.split('.').pop()||'jpg').toLowerCase();
    const path=`${crypto.randomUUID()}.${ext}`;
    const {error:uerr}=await sbx.storage.from('balivo-payment-proofs').upload(path,file,{contentType:file.type,upsert:false});
    if(uerr)throw uerr;
    const {data:pub}=sbx.storage.from('balivo-payment-proofs').getPublicUrl(path);
    const {data,error}=await sbx.rpc('balivo_submit_payment_proof',{p_order_number:orderNumber,p_phone:phone,p_proof_url:pub.publicUrl});
    if(error)throw error;return data;
  }

  function showPaymentProof(orderNumber,phone){
    const m=modal('balivoProofModal','Upload Bukti Pembayaran',`<p class="balivo-note">Order <b>${esc(orderNumber)}</b>. Pastikan bukti transfer jelas dan nominal sesuai.</p><div class="balivo-field"><label>Nomor WhatsApp</label><input id="balivoProofPhone" value="${esc(phone||'')}" inputmode="tel"></div><div class="balivo-field"><label>Bukti pembayaran</label><input id="balivoProofFile" type="file" accept="image/jpeg,image/png,image/webp"></div><div id="balivoProofMsg" class="balivo-note"></div><div class="balivo-actions"><button class="primary" id="balivoProofSubmit">KIRIM BUKTI</button></div>`);
    m.querySelector('#balivoProofSubmit').onclick=async()=>{const b=m.querySelector('#balivoProofSubmit'),msg=m.querySelector('#balivoProofMsg');b.disabled=true;msg.textContent='Mengunggah...';try{await uploadProof(orderNumber,m.querySelector('#balivoProofPhone').value.trim(),m.querySelector('#balivoProofFile').files[0]);msg.textContent='✓ Bukti berhasil dikirim. Menunggu verifikasi admin.';localStorage.setItem('balivoLastOrder',JSON.stringify({order_number:orderNumber,phone:m.querySelector('#balivoProofPhone').value.trim()}));}catch(e){msg.textContent='Gagal: '+e.message}finally{b.disabled=false}};
  }

  async function track(orderNumber,phone){
    const {data,error}=await sbx.rpc('balivo_track_order',{p_order_number:orderNumber,p_phone:phone});
    if(error)throw error;return data;
  }
  function statusSteps(o){
    const status=String(o.fulfillment_status||o.status||'NEW').toUpperCase();
    const stages=[['NEW','Pesanan dibuat'],['READY_TO_PROCESS','Pembayaran diterima'],['SUPPLIER_PAYMENT_PENDING','Diproses ke supplier'],['SUPPLIER_PAID','Pesanan supplier dibayar'],['SHIPPED','Dikirim'],['DELIVERED','Terkirim'],['COMPLETED','Selesai']];
    const rank={NEW:0,READY_TO_PROCESS:1,SUPPLIER_PAYMENT_PENDING:2,SUPPLIER_PAID:3,SHIPPED:4,DELIVERED:5,COMPLETED:6};
    const r=rank[status]??0;return stages.map((x,i)=>`<div class="balivo-step ${i<=r?'done':''}">${i<=r?'✓':'○'} ${x[1]}</div>`).join('');
  }
  function renderTracked(data,phone){
    const o=data.order,items=data.items||[];localStorage.setItem('balivoLastOrder',JSON.stringify({order_number:o.order_number,phone}));
    const paid=String(o.payment_status||'').toUpperCase();
    const canCancel=!['SHIPPED','DELIVERED','COMPLETED','CANCELLED'].includes(String(o.status||'').toUpperCase());
    const canReceive=['SHIPPED','DELIVERED'].includes(String(o.fulfillment_status||'').toUpperCase());
    return `<div class="balivo-order"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><b>${esc(o.order_number)}</b><span class="balivo-status">${esc(o.fulfillment_status||o.status||'NEW')}</span></div><p>${esc(o.customer_name||'')} · ${esc(o.customer_phone||'')}</p><p>${esc(o.customer_address||'')}</p><div class="balivo-timeline">${statusSteps(o)}</div><div style="margin-top:14px"><b>Produk</b>${items.map(i=>`<div style="display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid #eee"><span>${esc(i.product_name)} ${i.size?'· '+esc(i.size):''} × ${i.quantity}</span><b>${money(i.subtotal)}</b></div>`).join('')}</div><div style="display:flex;justify-content:space-between;margin-top:12px;font-size:18px"><b>Total</b><b>${money(o.total)}</b></div>${o.shipping_courier||o.supplier_tracking_number?`<div class="balivo-proof"><b>Pengiriman</b><br>${esc(o.shipping_courier||'')} ${esc(o.supplier_tracking_number||'')}</div>`:''}${paid!=='PAID'&&o.status!=='CANCELLED'?`<div class="balivo-proof"><b>Pembayaran</b><p class="balivo-note">Status: ${esc(paid||'PENDING')}</p><button class="balivo-util-btn dark" id="balivoUploadProof">UPLOAD BUKTI PEMBAYARAN</button></div>`:''}<div class="balivo-actions">${canCancel?'<button id="balivoCancelOrder">BATALKAN PESANAN</button>':''}${canReceive?'<button class="primary" id="balivoReceiveOrder">PESANAN DITERIMA</button>':''}</div>${o.status==='COMPLETED'?`<div class="balivo-review-card"><b>Sudah menerima pesanan?</b><p class="balivo-note">Berikan ulasan terverifikasi untuk produk yang dibeli.</p>${items.map(i=>`<button class="balivo-util-btn" data-review-product="${esc(i.product_id||'')}" data-review-name="${esc(i.product_name)}">⭐ Ulasan ${esc(i.product_name)}</button>`).join(' ')}</div>`:''}</div>`;
  }
  async function showTrack(orderNumber='',phone=''){
    const m=modal('balivoTrackModal','Lacak Pesanan',`<div class="balivo-field"><label>Nomor Order</label><input id="balivoTrackOrder" placeholder="BAL-XXXXXXXXXX" value="${esc(orderNumber)}"></div><div class="balivo-field"><label>Nomor WhatsApp</label><input id="balivoTrackPhone" inputmode="tel" value="${esc(phone)}"></div><div id="balivoTrackMsg" class="balivo-note"></div><div class="balivo-actions"><button class="primary" id="balivoTrackSubmit">LACAK</button></div><div id="balivoTrackResult"></div>`);
    const submit=async()=>{const n=m.querySelector('#balivoTrackOrder').value.trim(),p=m.querySelector('#balivoTrackPhone').value.trim(),msg=m.querySelector('#balivoTrackMsg'),out=m.querySelector('#balivoTrackResult');if(!n||!p){msg.textContent='Nomor order dan WhatsApp wajib diisi.';return}msg.textContent='Memuat...';try{const d=await track(n,p);out.innerHTML=renderTracked(d,p);msg.textContent='';const up=out.querySelector('#balivoUploadProof');if(up)up.onclick=()=>showPaymentProof(n,p);const can=out.querySelector('#balivoCancelOrder');if(can)can.onclick=async()=>{if(!confirm('Batalkan order ini?'))return;try{await sbx.rpc('balivo_cancel_order',{p_order_number:n,p_phone:p,p_reason:'Dibatalkan customer'});await submit()}catch(e){alert(e.message)}};const rec=out.querySelector('#balivoReceiveOrder');if(rec)rec.onclick=async()=>{try{await sbx.rpc('balivo_mark_order_received',{p_order_number:n,p_phone:p});await submit()}catch(e){alert(e.message)}};out.querySelectorAll('[data-review-product]').forEach(b=>b.onclick=()=>reviewForm(n,p,b.dataset.reviewProduct,b.dataset.reviewName));}catch(e){msg.textContent=e.message}}
    m.querySelector('#balivoTrackSubmit').onclick=submit;if(orderNumber&&phone)submit();
  }
  function reviewForm(orderNumber,phone,productId,name){
    const m=modal('balivoReviewModal','Ulasan Produk',`<p><b>${esc(name)}</b></p><div class="balivo-field"><label>Rating</label><select id="balivoReviewRating"><option value="5">★★★★★</option><option value="4">★★★★</option><option value="3">★★★</option><option value="2">★★</option><option value="1">★</option></select></div><div class="balivo-field"><label>Komentar</label><textarea id="balivoReviewComment" rows="4" placeholder="Bagaimana produk yang kamu terima?"></textarea></div><div id="balivoReviewMsg" class="balivo-note"></div><div class="balivo-actions"><button class="primary" id="balivoReviewSubmit">KIRIM ULASAN</button></div>`);
    m.querySelector('#balivoReviewSubmit').onclick=async()=>{const b=m.querySelector('#balivoReviewSubmit'),msg=m.querySelector('#balivoReviewMsg');b.disabled=true;try{const {error}=await sbx.rpc('balivo_submit_verified_review',{p_order_number:orderNumber,p_phone:phone,p_product_id:productId,p_rating:Number(m.querySelector('#balivoReviewRating').value),p_comment:m.querySelector('#balivoReviewComment').value.trim()});if(error)throw error;msg.textContent='✓ Ulasan terverifikasi berhasil dikirim.'}catch(e){msg.textContent='Gagal: '+e.message}finally{b.disabled=false}};
  }

  function wrapPayment(){
    if(window.__balivoPaymentWrapped)return;
    if(typeof window.openRealPayment!=='function'){setTimeout(wrapPayment,300);return}
    const original=window.openRealPayment;
    window.openRealPayment=async function(orderId,orderNumber,total,payment,phone){
      await original.apply(this,arguments);
      const sheet=document.querySelector('#orderSuccess .sheet'); if(!sheet)return;
      if(sheet.querySelector('#balivoInlineProof'))return;
      const box=document.createElement('div');box.id='balivoInlineProof';box.className='balivo-proof';box.innerHTML=`<b>Sudah melakukan pembayaran?</b><p class="balivo-note">Upload screenshot bukti transfer agar admin bisa memverifikasi pesanan.</p><button class="balivo-util-btn dark" id="balivoInlineProofBtn">UPLOAD BUKTI PEMBAYARAN</button><button class="balivo-util-btn" id="balivoInlineTrackBtn">LACAK ORDER</button>`;sheet.appendChild(box);box.querySelector('#balivoInlineProofBtn').onclick=()=>showPaymentProof(orderNumber,phone);box.querySelector('#balivoInlineTrackBtn').onclick=()=>{document.querySelector('#orderSuccess')?.classList.remove('open');showTrack(orderNumber,phone)};
    };window.__balivoPaymentWrapped=true;
  }
  addUtilityBar();wrapPayment();
  window.balivoTrackOrder=showTrack;
})();
