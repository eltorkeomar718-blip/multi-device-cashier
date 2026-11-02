alter table public.profiles
  add column if not exists username text,
  add column if not exists display_name text,
  add column if not exists permissions jsonb not null default '{}'::jsonb,
  add column if not exists active boolean not null default true;

update public.profiles
set username = 'ist',
    display_name = coalesce(nullif(display_name, ''), 'ist'),
    permissions = '{}'::jsonb,
    active = true
where role = 'owner'
  and (username is null or username = '');

create unique index if not exists profiles_username_ci_unique
  on public.profiles (lower(username))
  where username is not null;

create or replace function public.list_cashier_accounts()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('username', username, 'displayName', display_name)
      order by display_name, username
    ),
    '[]'::jsonb
  )
  from public.profiles
  where active = true and username is not null
$$;

create or replace function public.load_cashier_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_state public.cashier_state%rowtype;
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول';
  end if;

  select * into v_profile
  from public.profiles
  where user_id = auth.uid() and active = true;

  if not found then
    raise exception 'الحساب غير نشط أو غير مهيأ';
  end if;

  select * into v_state
  from public.cashier_state
  where id = 1;

  if not found then
    raise exception 'بيانات المتجر غير مهيأة';
  end if;

  return jsonb_build_object(
    'revision', v_state.revision,
    'data', v_state.payload,
    'user', jsonb_build_object(
      'id', v_profile.user_id,
      'username', v_profile.username,
      'displayName', v_profile.display_name,
      'role', v_profile.role,
      'permissions', v_profile.permissions
    )
  );
end;
$$;

create or replace function public.save_cashier_state(p_revision bigint, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_state public.cashier_state%rowtype;
  v_item jsonb;
  v_line jsonb;
  v_product jsonb;
  v_sales_changed boolean;
  v_expected numeric;
  v_sale_total numeric;
begin
  if v_user_id is null then
    raise exception 'يجب تسجيل الدخول';
  end if;

  select * into v_profile
  from public.profiles
  where user_id = v_user_id and active = true;

  if not found then
    raise exception 'الحساب غير نشط أو غير مهيأ';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'بيانات الحفظ غير صالحة';
  end if;
  if octet_length(p_data::text) > 4000000 then
    raise exception 'حجم بيانات المتجر تجاوز الحد المسموح';
  end if;
  if jsonb_typeof(p_data->'products') is distinct from 'array'
    or jsonb_typeof(p_data->'customers') is distinct from 'array'
    or jsonb_typeof(p_data->'suppliers') is distinct from 'array'
    or jsonb_typeof(p_data->'sales') is distinct from 'array'
    or jsonb_typeof(p_data->'parkedSales') is distinct from 'array'
    or jsonb_typeof(p_data->'purchases') is distinct from 'array'
    or jsonb_typeof(p_data->'payments') is distinct from 'array'
    or jsonb_typeof(p_data->'inventorySessions') is distinct from 'array'
    or jsonb_typeof(p_data->'shifts') is distinct from 'array' then
    raise exception 'بيانات المتجر غير مكتملة';
  end if;
  if p_data ? 'users' then
    raise exception 'لا يمكن تخزين حسابات الدخول ضمن بيانات المتجر';
  end if;

  select * into v_state
  from public.cashier_state
  where id = 1
  for update;

  if not found then
    raise exception 'بيانات المتجر غير مهيأة';
  end if;
  if p_revision is distinct from v_state.revision then
    raise exception 'تعارض في التحديث: أعد تحميل البيانات وحاول مرة أخرى'
      using errcode = '40001';
  end if;

  if v_profile.role <> 'owner' then
    v_sales_changed := (p_data->'sales') is distinct from (v_state.payload->'sales');
    if (p_data->'products') is distinct from (v_state.payload->'products')
      and not (
        coalesce((v_profile.permissions->>'products')::boolean, false)
        or coalesce((v_profile.permissions->>'inventory')::boolean, false)
        or coalesce((v_profile.permissions->>'purchases')::boolean, false)
        or coalesce((v_profile.permissions->>'sale')::boolean, false)
      ) then
      raise exception 'لا تملك صلاحية تعديل بيانات الأصناف';
    end if;
    if (p_data->'customers') is distinct from (v_state.payload->'customers')
      and not (
        coalesce((v_profile.permissions->>'customers')::boolean, false)
        or coalesce((v_profile.permissions->>'debts')::boolean, false)
        or coalesce((v_profile.permissions->>'sale')::boolean, false)
      ) then
      raise exception 'لا تملك صلاحية تعديل بيانات العملاء';
    end if;
    if (p_data->'suppliers') is distinct from (v_state.payload->'suppliers')
      and not (
        coalesce((v_profile.permissions->>'suppliers')::boolean, false)
        or coalesce((v_profile.permissions->>'purchases')::boolean, false)
        or coalesce((v_profile.permissions->>'debts')::boolean, false)
      ) then
      raise exception 'لا تملك صلاحية تعديل بيانات الموردين';
    end if;
    if (p_data->'sales') is distinct from (v_state.payload->'sales')
      and not coalesce((v_profile.permissions->>'sale')::boolean, false) then
      raise exception 'لا تملك صلاحية تسجيل المبيعات';
    end if;
    if (p_data->'parkedSales') is distinct from (v_state.payload->'parkedSales')
      and not coalesce((v_profile.permissions->>'sale')::boolean, false) then
      raise exception 'لا تملك صلاحية إدارة الفواتير المعلقة';
    end if;
    if (p_data->'purchases') is distinct from (v_state.payload->'purchases')
      and not coalesce((v_profile.permissions->>'purchases')::boolean, false) then
      raise exception 'لا تملك صلاحية إدارة المشتريات';
    end if;
    if (p_data->'payments') is distinct from (v_state.payload->'payments')
      and not coalesce((v_profile.permissions->>'debts')::boolean, false) then
      raise exception 'لا تملك صلاحية تسجيل التحصيلات';
    end if;
    if (p_data->'inventorySessions') is distinct from (v_state.payload->'inventorySessions')
      and not (
        coalesce((v_profile.permissions->>'inventory')::boolean, false)
        or coalesce((v_profile.permissions->>'sale')::boolean, false)
      ) then
      raise exception 'لا تملك صلاحية تعديل بيانات الجرد';
    end if;
    if (p_data->'shifts') is distinct from (v_state.payload->'shifts')
      and not coalesce((v_profile.permissions->>'shifts')::boolean, false) then
      raise exception 'لا تملك صلاحية إدارة الورديات';
    end if;

    if (p_data->'receiptSettings') is distinct from (v_state.payload->'receiptSettings') then
      raise exception 'إعدادات البون متاحة لحساب المالك فقط';
    end if;

    if (p_data->'sales') is distinct from (v_state.payload->'sales') then
      for v_item in select value from jsonb_array_elements(v_state.payload->'sales')
      loop
        if not exists (
          select 1 from jsonb_array_elements(p_data->'sales') as new_item(value)
          where new_item.value->>'id' = v_item->>'id'
            and new_item.value = v_item
        ) then
          raise exception 'لا يمكن تعديل أو حذف فاتورة بيع سابقة';
        end if;
      end loop;

      for v_item in select value from jsonb_array_elements(p_data->'sales')
      loop
        if not exists (
          select 1 from jsonb_array_elements(v_state.payload->'sales') as old_item(value)
          where old_item.value->>'id' = v_item->>'id'
        ) and v_item->>'cashierId' is distinct from v_user_id::text then
          raise exception 'يمكن للحساب تسجيل فواتيره فقط';
        elsif not exists (
          select 1 from jsonb_array_elements(v_state.payload->'sales') as old_item(value)
          where old_item.value->>'id' = v_item->>'id'
        ) then
          if jsonb_typeof(v_item->'items') is distinct from 'array'
            or jsonb_array_length(coalesce(v_item->'items', '[]'::jsonb)) = 0 then
            raise exception 'الفاتورة الجديدة لا تحتوي على أصناف';
          end if;
          if not exists (
            select 1
            from jsonb_array_elements(p_data->'shifts') as shift(value)
            where shift.value->>'id' = v_item->>'shiftId'
              and shift.value->>'closedAt' is null
          ) then
            raise exception 'يجب ربط الفاتورة بورديّة مفتوحة';
          end if;
          if not exists (
            select 1
            from jsonb_array_elements(p_data->'inventorySessions') as inventory(value)
            where inventory.value->>'id' = v_item->>'inventoryId'
              and inventory.value->>'closedAt' is null
          ) then
            raise exception 'يجب ربط الفاتورة بجلسة جرد مفتوحة';
          end if;

          v_sale_total := 0;
          for v_line in select value from jsonb_array_elements(v_item->'items')
          loop
            if coalesce((v_line->>'quantity')::integer, 0) <= 0 then
              raise exception 'كمية الصنف في الفاتورة غير صالحة';
            end if;
            select value into v_product
            from jsonb_array_elements(v_state.payload->'products') as product(value)
            where product.value->>'id' = v_line->>'productId';
            if not found
              or v_line->>'price' is null
              or v_line->>'price' is distinct from v_product->>'price' then
              raise exception 'سعر الصنف في الفاتورة غير مطابق للسجل';
            end if;
            v_sale_total := v_sale_total
              + (v_line->>'price')::numeric * (v_line->>'quantity')::integer;
          end loop;
          v_sale_total := v_sale_total + coalesce((v_item->>'deliveryFee')::numeric, 0);
          if (v_item->>'total') is null
            or (v_item->>'total')::numeric is distinct from v_sale_total
            or (v_item->>'paid') is null
            or coalesce((v_item->>'deliveryFee')::numeric, 0) < 0
            or (v_item->>'paid')::numeric < 0
            or (v_item->>'paid')::numeric > v_sale_total then
            raise exception 'إجمالي الفاتورة أو المدفوع غير صحيح';
          end if;
        end if;
      end loop;
    end if;

    if (p_data->'purchases') is distinct from (v_state.payload->'purchases') then
      for v_item in select value from jsonb_array_elements(v_state.payload->'purchases')
      loop
        if not exists (
          select 1 from jsonb_array_elements(p_data->'purchases') as new_item(value)
          where new_item.value->>'id' = v_item->>'id'
            and new_item.value = v_item
        ) then
          raise exception 'لا يمكن تعديل أو حذف مشتريات سابقة';
        end if;
      end loop;
      for v_item in select value from jsonb_array_elements(p_data->'purchases')
      loop
        if not exists (
          select 1 from jsonb_array_elements(v_state.payload->'purchases') as old_item(value)
          where old_item.value->>'id' = v_item->>'id'
        ) and v_item->>'cashierId' is distinct from v_user_id::text then
          raise exception 'يمكن للحساب تسجيل مشترياته فقط';
        end if;
      end loop;
    end if;

    if (p_data->'payments') is distinct from (v_state.payload->'payments') then
      for v_item in select value from jsonb_array_elements(v_state.payload->'payments')
      loop
        if not exists (
          select 1 from jsonb_array_elements(p_data->'payments') as new_item(value)
          where new_item.value->>'id' = v_item->>'id'
            and new_item.value = v_item
        ) then
          raise exception 'لا يمكن تعديل أو حذف تحصيلات سابقة';
        end if;
      end loop;
      for v_item in select value from jsonb_array_elements(p_data->'payments')
      loop
        if not exists (
          select 1 from jsonb_array_elements(v_state.payload->'payments') as old_item(value)
          where old_item.value->>'id' = v_item->>'id'
        ) and v_item->>'cashierId' is distinct from v_user_id::text then
          raise exception 'يمكن للحساب تسجيل تحصيلاته فقط';
        end if;
      end loop;
    end if;

    if (p_data->'products') is distinct from (v_state.payload->'products')
      and not (
        coalesce((v_profile.permissions->>'products')::boolean, false)
        or coalesce((v_profile.permissions->>'inventory')::boolean, false)
        or coalesce((v_profile.permissions->>'purchases')::boolean, false)
      ) then
      if jsonb_array_length(p_data->'products') <> jsonb_array_length(v_state.payload->'products') then
        raise exception 'حساب البيع لا يمكنه إضافة الأصناف أو حذفها';
      end if;
      for v_item in select value from jsonb_array_elements(v_state.payload->'products')
      loop
        select value into v_product
        from jsonb_array_elements(p_data->'products') as new_product(value)
        where new_product.value->>'id' = v_item->>'id';
        if not found
          or (v_product->>'stock') is null
          or (v_product - 'stock') <> (v_item - 'stock')
          or (v_product->>'stock')::numeric > (v_item->>'stock')::numeric then
          raise exception 'حساب البيع لا يمكنه تغيير بيانات الأصناف أو زيادة المخزون';
        end if;
        select coalesce(sum((line.value->>'quantity')::integer), 0)
        into v_expected
        from jsonb_array_elements(p_data->'sales') as sale(value)
        cross join jsonb_array_elements(sale.value->'items') as line(value)
        where sale.value->>'cashierId' = v_user_id::text
          and not exists (
            select 1 from jsonb_array_elements(v_state.payload->'sales') as old_sale(value)
            where old_sale.value->>'id' = sale.value->>'id'
          )
          and line.value->>'productId' = v_item->>'id';
        if (v_product->>'stock')::numeric < 0
          or (v_product->>'stock')::numeric
            <> (v_item->>'stock')::numeric - coalesce(v_expected, 0) then
          raise exception 'تغيير رصيد المخزون يجب أن يطابق الكميات المباعة';
        end if;
      end loop;
    end if;

    if (p_data->'customers') is distinct from (v_state.payload->'customers')
      and not (
        coalesce((v_profile.permissions->>'customers')::boolean, false)
        or coalesce((v_profile.permissions->>'debts')::boolean, false)
      ) then
      if not v_sales_changed
        or jsonb_array_length(p_data->'customers') <> jsonb_array_length(v_state.payload->'customers') then
        raise exception 'حساب البيع لا يمكنه إضافة العملاء أو حذفهم';
      end if;
      for v_item in select value from jsonb_array_elements(v_state.payload->'customers')
      loop
        select value into v_product
        from jsonb_array_elements(p_data->'customers') as new_customer(value)
        where new_customer.value->>'id' = v_item->>'id';
        if not found
          or (v_product->>'balance') is null
          or (v_product - 'balance') <> (v_item - 'balance') then
          raise exception 'حساب البيع لا يمكنه تغيير بيانات العملاء';
        end if;
        select coalesce(sum((sale.value->>'total')::numeric - (sale.value->>'paid')::numeric), 0)
        into v_expected
        from jsonb_array_elements(p_data->'sales') as sale(value)
        where sale.value->>'customerId' = v_item->>'id'
          and not exists (
            select 1 from jsonb_array_elements(v_state.payload->'sales') as old_sale(value)
            where old_sale.value->>'id' = sale.value->>'id'
          );
        if (v_product->>'balance')::numeric
          <> (v_item->>'balance')::numeric + coalesce(v_expected, 0) then
          raise exception 'تغيير رصيد العميل يجب أن يطابق مديونية الفواتير الجديدة';
        end if;
      end loop;
    end if;

    if (p_data->'inventorySessions') is distinct from (v_state.payload->'inventorySessions')
      and not coalesce((v_profile.permissions->>'inventory')::boolean, false) then
      if not v_sales_changed
        or jsonb_array_length(p_data->'inventorySessions')
          <> jsonb_array_length(v_state.payload->'inventorySessions') then
        raise exception 'حساب البيع لا يمكنه بدء جلسة جرد أو حذفها';
      end if;
      for v_item in select value from jsonb_array_elements(v_state.payload->'inventorySessions')
      loop
        select value into v_product
        from jsonb_array_elements(p_data->'inventorySessions') as new_inventory(value)
        where new_inventory.value->>'id' = v_item->>'id';
        if not found or (v_product - 'nextReceiptNumber') <> (v_item - 'nextReceiptNumber') then
          raise exception 'حساب البيع لا يمكنه تغيير بيانات جلسة الجرد';
        end if;
        select count(*) into v_expected
        from jsonb_array_elements(p_data->'sales') as sale(value)
        where sale.value->>'inventoryId' = v_item->>'id'
          and not exists (
            select 1 from jsonb_array_elements(v_state.payload->'sales') as old_sale(value)
            where old_sale.value->>'id' = sale.value->>'id'
          );
        if (v_product->>'nextReceiptNumber')::integer
          <> (v_item->>'nextReceiptNumber')::integer + coalesce(v_expected, 0) then
          raise exception 'تسلسل البونات يجب أن يطابق عدد الفواتير الجديدة';
        end if;
      end loop;
    end if;

    if (p_data->'shifts') is distinct from (v_state.payload->'shifts') then
      for v_item in select value from jsonb_array_elements(v_state.payload->'shifts')
      loop
        select value into v_product
        from jsonb_array_elements(p_data->'shifts') as new_shift(value)
        where new_shift.value->>'id' = v_item->>'id';
        if not found then
          raise exception 'لا يمكن حذف وردية سابقة';
        end if;
        if v_item->>'userId' is distinct from v_user_id::text
          and v_product <> v_item then
          raise exception 'لا يمكن تعديل وردية حساب آخر';
        end if;
        if v_item->>'userId' = v_user_id::text
          and (
            (v_product - 'closedAt' - 'countedCash')
              <> (v_item - 'closedAt' - 'countedCash')
            or (
              v_item->>'closedAt' is not null
              and v_product <> v_item
            )
          ) then
          raise exception 'يمكن إغلاق الوردية الخاصة بالحساب دون تغيير بياناتها';
        end if;
      end loop;
      for v_item in select value from jsonb_array_elements(p_data->'shifts')
      loop
        if not exists (
          select 1 from jsonb_array_elements(v_state.payload->'shifts') as old_item(value)
          where old_item.value = v_item
        ) and v_item->>'userId' is distinct from v_user_id::text then
          raise exception 'يمكن للحساب فتح ورديته فقط';
        end if;
      end loop;
    end if;
  end if;

  update public.cashier_state
  set payload = p_data,
      revision = revision + 1,
      updated_at = now()
  where id = 1
  returning * into v_state;

  return jsonb_build_object('revision', v_state.revision);
end;
$$;

alter table public.profiles enable row level security;
alter table public.cashier_state enable row level security;

revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant usage on schema public to anon, authenticated;

grant execute on function public.list_cashier_accounts() to anon, authenticated;
grant execute on function public.load_cashier_state() to authenticated;
grant execute on function public.save_cashier_state(bigint, jsonb) to authenticated;
