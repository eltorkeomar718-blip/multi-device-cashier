create table public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  created_at timestamptz not null default now()
);

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete restrict,
  role text not null default 'owner' check (role in ('owner', 'cashier')),
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  price numeric(12, 2) not null check (price > 0),
  stock integer not null default 0 check (stock >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index products_store_active_name_idx on public.products (store_id, active, name);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete restrict,
  cashier_id uuid references auth.users(id) on delete restrict,
  total numeric(12, 2) not null check (total >= 0),
  created_at timestamptz not null default now()
);

create index sales_store_created_idx on public.sales (store_id, created_at desc);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null check (unit_price > 0),
  line_total numeric(12, 2) not null check (line_total > 0)
);

create index sale_items_sale_idx on public.sale_items (sale_id);

alter table public.stores enable row level security;
alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;

create function public.current_store_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select store_id from public.profiles where user_id = auth.uid()),
    (select id from public.stores order by created_at, id limit 1)
  )
$$;

revoke all on function public.current_store_id() from public, anon;
grant execute on function public.current_store_id() to anon, authenticated;

create policy "Users read their own profile"
  on public.profiles for select to authenticated
  using (user_id = auth.uid());

create policy "Users read their store"
  on public.stores for select to anon, authenticated
  using (id = public.current_store_id());

create policy "Users read their store products"
  on public.products for select to anon, authenticated
  using (store_id = public.current_store_id());

create policy "Users add products to their store"
  on public.products for insert to anon, authenticated
  with check (store_id = public.current_store_id());

create policy "Users update products in their store"
  on public.products for update to authenticated
  using (store_id = public.current_store_id())
  with check (store_id = public.current_store_id());

create policy "Users read their store sales"
  on public.sales for select to anon, authenticated
  using (store_id = public.current_store_id());

create policy "Users read items from their store sales"
  on public.sale_items for select to anon, authenticated
  using (
    exists (
      select 1 from public.sales
      where sales.id = sale_items.sale_id
        and sales.store_id = public.current_store_id()
    )
  );

create function public.checkout_sale(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store_id uuid;
  v_sale_id uuid;
  v_total numeric(12, 2) := 0;
  v_item record;
  v_product public.products%rowtype;
begin
  v_store_id := public.current_store_id();
  if v_store_id is null then
    raise exception 'No store is assigned to this account';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Sale items must be a JSON array';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'A sale must contain at least one item';
  end if;

  insert into public.sales (store_id, cashier_id, total)
  values (v_store_id, auth.uid(), 0)
  returning id into v_sale_id;

  for v_item in
    select item.product_id::uuid as product_id, sum(item.quantity)::integer as quantity
    from jsonb_to_recordset(p_items) as item(product_id text, quantity integer)
    group by item.product_id
  loop
    if v_item.quantity is null or v_item.quantity < 1 then
      raise exception 'Item quantity must be a positive integer';
    end if;

    select * into v_product
    from public.products
    where id = v_item.product_id
      and store_id = v_store_id
      and active = true
    for update;

    if not found then
      raise exception 'A product is unavailable in this store';
    end if;
    if v_product.stock < v_item.quantity then
      raise exception 'Insufficient stock for product %', v_product.name;
    end if;

    update public.products
    set stock = stock - v_item.quantity
    where id = v_product.id;

    v_total := v_total + v_product.price * v_item.quantity;
    insert into public.sale_items (sale_id, product_id, quantity, unit_price, line_total)
    values (v_sale_id, v_product.id, v_item.quantity, v_product.price, v_product.price * v_item.quantity);
  end loop;

  update public.sales set total = v_total where id = v_sale_id;
  return jsonb_build_object('id', v_sale_id, 'total', v_total);
end;
$$;

revoke all on function public.checkout_sale(jsonb) from public, anon;
grant execute on function public.checkout_sale(jsonb) to anon, authenticated;

revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.stores, public.products, public.sales, public.sale_items to anon, authenticated;
grant select on public.profiles to authenticated;
grant insert on public.products to anon;
grant insert, update on public.products to authenticated;

create table if not exists public.cashier_state (
  id smallint primary key default 1 check (id = 1),
  revision bigint not null default 0 check (revision >= 0),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.cashier_state enable row level security;
revoke all on public.cashier_state from public, anon, authenticated;

insert into public.cashier_state (id, payload)
values (
  1,
  '{
    "version": 1,
    "initialized": true,
    "products": [],
    "customers": [],
    "suppliers": [],
    "sales": [],
    "parkedSales": [],
    "purchases": [],
    "payments": [],
    "inventorySessions": [],
    "shifts": [],
    "receiptSettings": {
      "shopName": "اسم المحل",
      "phone": "",
      "address": "",
      "header": "",
      "footer": "شكرًا لزيارتكم",
      "paperWidth": "80",
      "fontSize": 13,
      "showPhone": true,
      "showAddress": true,
      "showDate": true,
      "showReceiptNumber": true,
      "showCustomer": true,
      "showCashier": true,
      "showSku": true,
      "showDelivery": true,
      "showPaid": true
    }
  }'::jsonb
)
on conflict (id) do nothing;

create or replace function public.load_cashier_state()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('revision', revision, 'data', payload)
  from public.cashier_state
  where id = 1
$$;

create or replace function public.save_cashier_state(p_revision bigint, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_revision bigint;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'بيانات الحفظ غير صالحة';
  end if;
  if octet_length(p_data::text) > 4000000 then
    raise exception 'حجم بيانات المتجر تجاوز الحد المسموح';
  end if;
  if jsonb_typeof(p_data->'products') <> 'array'
    or jsonb_typeof(p_data->'customers') <> 'array'
    or jsonb_typeof(p_data->'suppliers') <> 'array'
    or jsonb_typeof(p_data->'sales') <> 'array'
    or jsonb_typeof(p_data->'purchases') <> 'array'
    or jsonb_typeof(p_data->'payments') <> 'array'
    or jsonb_typeof(p_data->'inventorySessions') <> 'array'
    or jsonb_typeof(p_data->'shifts') <> 'array' then
    raise exception 'بيانات المتجر غير مكتملة';
  end if;

  select revision into v_revision
  from public.cashier_state
  where id = 1
  for update;

  if v_revision is null then
    raise exception 'بيانات المتجر غير مهيأة';
  end if;
  if p_revision <> v_revision then
    raise exception 'تعارض في التحديث: أعد تحميل البيانات وحاول مرة أخرى'
      using errcode = '40001';
  end if;

  update public.cashier_state
  set payload = p_data - 'users',
      revision = revision + 1,
      updated_at = now()
  where id = 1
  returning revision into v_revision;

  return jsonb_build_object('revision', v_revision);
end;
$$;

revoke all on function public.load_cashier_state() from public, anon, authenticated;
revoke all on function public.save_cashier_state(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.load_cashier_state() to anon, authenticated;
grant execute on function public.save_cashier_state(bigint, jsonb) to anon, authenticated;
