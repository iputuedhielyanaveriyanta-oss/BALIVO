-- BALIVO completion migration: customer tracking, payment proof, cancellation, delivery, reporting helpers
create extension if not exists pgcrypto;

alter table public.orders
  add column if not exists customer_access_token uuid default gen_random_uuid(),
  add column if not exists payment_proof_url text,
  add column if not exists payment_verified_at timestamptz,
  add column if not exists payment_rejected_at timestamptz,
  add column if not exists payment_rejection_reason text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text,
  add column if not exists refund_status text not null default 'NOT_REQUIRED',
  add column if not exists shipping_courier text,
  add column if not exists delivered_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists admin_note text;

update public.orders set customer_access_token=gen_random_uuid() where customer_access_token is null;
alter table public.orders alter column customer_access_token set default gen_random_uuid();
alter table public.orders alter column customer_access_token set not null;
create unique index if not exists orders_customer_access_token_idx on public.orders(customer_access_token);
create index if not exists orders_payment_status_idx on public.orders(payment_status);
create index if not exists orders_fulfillment_status_idx on public.orders(fulfillment_status);

create table if not exists public.payment_proofs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  order_number text not null,
  customer_phone text not null,
  proof_url text not null,
  status text not null default 'PENDING',
  admin_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index if not exists payment_proofs_order_idx on public.payment_proofs(order_id,created_at desc);

alter table public.payment_proofs enable row level security;
revoke all on public.payment_proofs from anon, authenticated;
grant select on public.payment_proofs to authenticated;

drop policy if exists "payment_proofs_admin_select" on public.payment_proofs;
create policy "payment_proofs_admin_select" on public.payment_proofs for select to authenticated using (true);

-- Public upload bucket for payment screenshots. Files are unguessable UUIDs; no service key is exposed.
insert into storage.buckets(id,name,public)
values('balivo-payment-proofs','balivo-payment-proofs',true)
on conflict (id) do update set public=true;

drop policy if exists "balivo payment proof upload" on storage.objects;
create policy "balivo payment proof upload" on storage.objects for insert to anon,authenticated
with check (bucket_id='balivo-payment-proofs' and (storage.extension(name) in ('jpg','jpeg','png','webp')));

drop policy if exists "balivo payment proof public read" on storage.objects;
create policy "balivo payment proof public read" on storage.objects for select to anon,authenticated
using (bucket_id='balivo-payment-proofs');

-- Return safe order data for a customer who knows their order number and phone.
create or replace function public.balivo_track_order(p_order_number text,p_phone text)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare v_order jsonb; v_items jsonb;
begin
  select to_jsonb(o) - 'customer_access_token' - 'supplier_cost' - 'markup_profit' - 'supplier_order_note'
  into v_order from public.orders o
  where upper(o.order_number)=upper(trim(p_order_number)) and regexp_replace(o.customer_phone,'\\D','','g')=regexp_replace(trim(p_phone),'\\D','','g');
  if v_order is null then raise exception 'Order tidak ditemukan. Periksa nomor order dan nomor WhatsApp.'; end if;
  select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at),'[]'::jsonb) into v_items
  from public.order_items i join public.orders o on o.id=i.order_id
  where upper(o.order_number)=upper(trim(p_order_number)) and regexp_replace(o.customer_phone,'\\D','','g')=regexp_replace(trim(p_phone),'\\D','','g');
  return jsonb_build_object('order',v_order,'items',v_items);
end;
$$;
grant execute on function public.balivo_track_order(text,text) to anon,authenticated;

create or replace function public.balivo_submit_payment_proof(p_order_number text,p_phone text,p_proof_url text)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare v_order public.orders%rowtype; v_id uuid;
begin
  if coalesce(trim(p_proof_url),'')='' then raise exception 'Bukti pembayaran wajib diisi'; end if;
  select * into v_order from public.orders where upper(order_number)=upper(trim(p_order_number)) and regexp_replace(customer_phone,'\\D','','g')=regexp_replace(trim(p_phone),'\\D','','g') for update;
  if not found then raise exception 'Order tidak ditemukan.'; end if;
  if v_order.payment_status='PAID' then raise exception 'Pembayaran order ini sudah dikonfirmasi.'; end if;
  if v_order.status='CANCELLED' then raise exception 'Order sudah dibatalkan.'; end if;
  insert into public.payment_proofs(order_id,order_number,customer_phone,proof_url) values(v_order.id,v_order.order_number,v_order.customer_phone,p_proof_url) returning id into v_id;
  update public.orders set payment_proof_url=p_proof_url,payment_status='PROOF_SUBMITTED' where id=v_order.id;
  return jsonb_build_object('ok',true,'proof_id',v_id,'order_number',v_order.order_number);
end;
$$;
grant execute on function public.balivo_submit_payment_proof(text,text,text) to anon,authenticated;

create or replace function public.balivo_mark_order_received(p_order_number text,p_phone text)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare v_id uuid;
begin
  select id into v_id from public.orders where upper(order_number)=upper(trim(p_order_number)) and regexp_replace(customer_phone,'\\D','','g')=regexp_replace(trim(p_phone),'\\D','','g');
  if not found then raise exception 'Order tidak ditemukan.'; end if;
  update public.orders set status='COMPLETED',fulfillment_status='COMPLETED',completed_at=coalesce(completed_at,now()) where id=v_id and fulfillment_status in ('SHIPPED','DELIVERED');
  if not found then raise exception 'Order belum berstatus dikirim.'; end if;
  return jsonb_build_object('ok',true);
end;
$$;
grant execute on function public.balivo_mark_order_received(text,text) to anon,authenticated;

-- Safe cancellation restores the stock reserved by order_items exactly once.
create or replace function public.balivo_cancel_order(p_order_number text,p_phone text,p_reason text default 'Customer membatalkan pesanan')
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare v_order public.orders%rowtype; r record;
begin
  select * into v_order from public.orders where upper(order_number)=upper(trim(p_order_number)) and regexp_replace(customer_phone,'\\D','','g')=regexp_replace(trim(p_phone),'\\D','','g') for update;
  if not found then raise exception 'Order tidak ditemukan.'; end if;
  if v_order.status in ('SHIPPED','DELIVERED','COMPLETED','CANCELLED') then raise exception 'Order sudah tidak bisa dibatalkan pada status %',v_order.status; end if;
  for r in select product_id,size,quantity from public.order_items where order_id=v_order.id and product_id is not null loop
    if r.size is not null and r.size<>'' then
      update public.products set sizes=jsonb_set(coalesce(sizes,'{}'::jsonb),array[r.size],to_jsonb(coalesce((sizes->>r.size)::int,0)+r.quantity),true),stock=stock+r.quantity where id=r.product_id;
    else
      update public.products set stock=stock+r.quantity where id=r.product_id;
    end if;
  end loop;
  update public.orders set status='CANCELLED',fulfillment_status='CANCELLED',cancelled_at=now(),cancellation_reason=coalesce(nullif(trim(p_reason),''),'Customer membatalkan pesanan'),refund_status=case when payment_status='PAID' then 'PENDING_REFUND' else 'NOT_REQUIRED' end where id=v_order.id;
  return jsonb_build_object('ok',true,'refund_status',case when v_order.payment_status='PAID' then 'PENDING_REFUND' else 'NOT_REQUIRED' end);
end;
$$;
grant execute on function public.balivo_cancel_order(text,text,text) to anon,authenticated;

-- Admin RPCs keep sensitive workflow operations behind authenticated Supabase sessions.
create or replace function public.balivo_admin_review_payment(p_order_id uuid,p_approve boolean,p_reason text default null)
returns jsonb
language plpgsql
security invoker
set search_path=public
as $$
declare v_order public.orders%rowtype;
begin
  if auth.uid() is null then raise exception 'Admin login diperlukan'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order tidak ditemukan'; end if;
  if p_approve then
    update public.orders set payment_status='PAID',payment_verified_at=now(),payment_rejection_reason=null,fulfillment_status='READY_TO_PROCESS',supplier_payment_status=case when fulfillment_type='DROPSHIP' then 'WAITING' else 'NOT_REQUIRED' end where id=p_order_id;
    update public.payment_proofs set status='APPROVED',reviewed_at=now() where order_id=p_order_id and status='PENDING';
  else
    update public.orders set payment_status='REJECTED',payment_rejected_at=now(),payment_rejection_reason=nullif(trim(p_reason),'') where id=p_order_id;
    update public.payment_proofs set status='REJECTED',admin_note=nullif(trim(p_reason),''),reviewed_at=now() where order_id=p_order_id and status='PENDING';
  end if;
  return jsonb_build_object('ok',true,'payment_status',case when p_approve then 'PAID' else 'REJECTED' end);
end;
$$;
grant execute on function public.balivo_admin_review_payment(uuid,boolean,text) to authenticated;

create or replace function public.balivo_admin_mark_delivered(p_order_id uuid,p_courier text default null)
returns jsonb
language plpgsql
security invoker
set search_path=public
as $$
begin
  if auth.uid() is null then raise exception 'Admin login diperlukan'; end if;
  update public.orders set status='DELIVERED',fulfillment_status='DELIVERED',delivered_at=now(),shipping_courier=coalesce(nullif(trim(p_courier),''),shipping_courier) where id=p_order_id and fulfillment_status='SHIPPED';
  if not found then raise exception 'Order belum berstatus SHIPPED'; end if;
  return jsonb_build_object('ok',true);
end;
$$;
grant execute on function public.balivo_admin_mark_delivered(uuid,text) to authenticated;

create or replace function public.balivo_admin_set_tracking(p_order_id uuid,p_courier text,p_tracking text)
returns jsonb
language plpgsql
security invoker
set search_path=public
as $$
begin
  if auth.uid() is null then raise exception 'Admin login diperlukan'; end if;
  update public.orders set shipping_courier=nullif(trim(p_courier),''),supplier_tracking_number=nullif(trim(p_tracking),'') where id=p_order_id;
  if not found then raise exception 'Order tidak ditemukan'; end if;
  return jsonb_build_object('ok',true);
end;
$$;
grant execute on function public.balivo_admin_set_tracking(uuid,text,text) to authenticated;

-- Useful reporting view; security invoker so existing RLS remains effective.
drop view if exists public.balivo_sales_summary;
create view public.balivo_sales_summary with (security_invoker=true) as
select date_trunc('day',created_at) day,count(*) orders,count(*) filter(where payment_status='PAID') paid_orders,
       coalesce(sum(total) filter(where payment_status='PAID'),0) revenue,
       coalesce(sum(markup_profit) filter(where payment_status='PAID'),0) gross_profit
from public.orders group by 1 order by 1 desc;
revoke all on public.balivo_sales_summary from anon,authenticated;
grant select on public.balivo_sales_summary to authenticated;
