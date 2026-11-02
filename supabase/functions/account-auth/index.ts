import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const permissionKeys = [
  'dashboard', 'sale', 'products', 'customers', 'suppliers',
  'purchases', 'invoices', 'debts', 'shifts', 'inventory'
] as const;
const allowedOrigins = new Set([
  'https://eltorkeomar718-blip.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
]);

type PermissionKey = typeof permissionKeys[number];
type PermissionSet = Record<PermissionKey, boolean>;

const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

function responseHeaders(origin: string | null) {
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  });
  if (origin && allowedOrigins.has(origin)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function jsonResponse(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin) });
}

function validatePermissions(input: unknown): PermissionSet {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('حدد صلاحيات الحساب بشكل صحيح.');
  }
  const values = input as Record<string, unknown>;
  const permissions = Object.fromEntries(permissionKeys.map(key => [key, values[key] === true])) as PermissionSet;
  if (Object.keys(values).some(key => !permissionKeys.includes(key as PermissionKey))) {
    throw new Error('توجد صلاحية غير معروفة.');
  }
  if (Object.values(values).some(value => typeof value !== 'boolean')) {
    throw new Error('قيم الصلاحيات يجب أن تكون اختيارًا صحيحًا أو خطأ.');
  }
  return permissions;
}

function accessToken(request: Request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error('يجب تسجيل الدخول.');
  return match[1];
}

async function requireOwner(request: Request) {
  const token = accessToken(request);
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) throw new Error('انتهت الجلسة. سجل الدخول مجددًا.');

  const { data: profile, error: profileError } = await serviceClient
    .from('profiles')
    .select('role, active')
    .eq('user_id', authData.user.id)
    .maybeSingle();
  if (profileError) throw new Error('تعذر التحقق من صلاحيات المالك.');
  if (!profile || profile.role !== 'owner' || !profile.active) {
    throw new Error('إدارة الحسابات متاحة لحساب ist فقط.');
  }
  return authData.user;
}

async function handleLogin(username: string, password: string) {
  if (!username || username.length > 80 || !password) {
    throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة.');
  }
  const { data: profile, error: profileError } = await serviceClient
    .from('profiles')
    .select('user_id, active')
    .eq('username', username)
    .maybeSingle();
  if (profileError || !profile || !profile.active) {
    throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة.');
  }

  const { data: authData, error: authError } = await serviceClient.auth.admin.getUserById(profile.user_id);
  const email = authData.user?.email;
  if (authError || !email) throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة.');

  const loginClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: sessionData, error: loginError } = await loginClient.auth.signInWithPassword({ email, password });
  if (loginError || !sessionData.session) {
    throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة.');
  }
  return {
    accessToken: sessionData.session.access_token,
    refreshToken: sessionData.session.refresh_token
  };
}

async function createAccount(body: Record<string, unknown>, request: Request) {
  const owner = await requireOwner(request);
  const username = String(body.username || '').trim();
  const displayName = String(body.displayName || '').trim();
  const password = String(body.password || '');
  if (!/^[\p{L}\p{N}._ -]{3,30}$/u.test(username)) {
    throw new Error('اسم المستخدم يجب أن يتكون من 3 إلى 30 حرفًا أو رقمًا أو . _ -');
  }
  if (!displayName || displayName.length > 80) throw new Error('اكتب اسم عرض من 1 إلى 80 حرفًا.');
  if (password.length < 10) throw new Error('كلمة المرور يجب ألا تقل عن 10 أحرف.');
  const permissions = validatePermissions(body.permissions);

  const { data: ownerProfile, error: ownerError } = await serviceClient
    .from('profiles')
    .select('store_id')
    .eq('user_id', owner.id)
    .single();
  if (ownerError) throw new Error('تعذر تحديد المتجر المرتبط بحساب المالك.');

  const { data: newAuthUser, error: createError } = await serviceClient.auth.admin.createUser({
    email: `cashier-${crypto.randomUUID()}@accounts.cashier.invalid`,
    password,
    email_confirm: true,
    user_metadata: { username }
  });
  if (createError || !newAuthUser.user) {
    throw new Error(createError?.message || 'تعذر إنشاء حساب الدخول.');
  }

  const { data: profile, error: profileError } = await serviceClient
    .from('profiles')
    .insert({
      user_id: newAuthUser.user.id,
      store_id: ownerProfile.store_id,
      role: 'cashier',
      username,
      display_name: displayName,
      permissions,
      active: true
    })
    .select('user_id, username, display_name, role, permissions, active')
    .single();
  if (profileError) {
    const { error: deleteError } = await serviceClient.auth.admin.deleteUser(newAuthUser.user.id);
    if (deleteError) console.error('Failed to remove auth user after profile creation failed:', deleteError.message);
    if (profileError.code === '23505') throw new Error('اسم المستخدم مستخدم بالفعل.');
    throw new Error('تعذر حفظ ملف الحساب.');
  }
  return profile;
}

async function updateAccount(body: Record<string, unknown>, request: Request) {
  await requireOwner(request);
  const userId = String(body.userId || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error('معرّف الحساب غير صالح.');
  }
  const { data: target, error: targetError } = await serviceClient
    .from('profiles')
    .select('role')
    .eq('user_id', userId)
    .maybeSingle();
  if (targetError) throw new Error('تعذر العثور على الحساب.');
  if (!target || target.role !== 'cashier') throw new Error('لا يمكن تغيير حساب ist.');

  const updates = ['active', 'permissions', 'password'].filter(key => body[key] !== undefined);
  if (updates.length !== 1) throw new Error('نفّذ تغييرًا واحدًا في كل مرة.');
  if (body.active !== undefined && typeof body.active !== 'boolean') {
    throw new Error('حالة الحساب غير صالحة.');
  }
  const newPassword = body.password === undefined ? null : String(body.password);
  if (newPassword !== null && newPassword.length < 10) {
    throw new Error('كلمة المرور يجب ألا تقل عن 10 أحرف.');
  }
  const permissions = body.permissions === undefined ? null : validatePermissions(body.permissions);

  const profileUpdates: Record<string, unknown> = {};
  if (typeof body.active === 'boolean') profileUpdates.active = body.active;
  if (permissions) profileUpdates.permissions = permissions;
  if (Object.keys(profileUpdates).length) {
    const { error } = await serviceClient.from('profiles').update(profileUpdates).eq('user_id', userId);
    if (error) throw new Error('تعذر تحديث الحساب.');
  }

  if (newPassword !== null) {
    const { error } = await serviceClient.auth.admin.updateUserById(userId, { password: newPassword });
    if (error) throw new Error('تعذر تغيير كلمة المرور.');
  }
  return { success: true };
}

Deno.serve(async request => {
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') return new Response('ok', { headers: responseHeaders(origin) });
  if (origin && !allowedOrigins.has(origin)) return jsonResponse({ error: 'المصدر غير مسموح.' }, 403, origin);
  if (request.method !== 'POST') return jsonResponse({ error: 'الطريقة غير مدعومة.' }, 405, origin);

  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || '');
    if (action === 'login') {
      const session = await handleLogin(String(body.username || '').trim(), String(body.password || ''));
      return jsonResponse(session, 200, origin);
    }
    if (action === 'list') {
      await requireOwner(request);
      const { data, error } = await serviceClient
        .from('profiles')
        .select('user_id, username, display_name, role, permissions, active')
        .order('created_at', { ascending: true });
      if (error) throw new Error('تعذر تحميل قائمة الحسابات.');
      return jsonResponse({
        accounts: (data || []).map(profile => ({
          id: profile.user_id,
          username: profile.username,
          displayName: profile.display_name,
          role: profile.role,
          permissions: profile.permissions,
          active: profile.active
        }))
      }, 200, origin);
    }
    if (action === 'create') {
      const profile = await createAccount(body, request);
      return jsonResponse({
        account: {
          id: profile.user_id,
          username: profile.username,
          displayName: profile.display_name,
          role: profile.role,
          permissions: profile.permissions,
          active: profile.active
        }
      }, 201, origin);
    }
    if (action === 'update') {
      return jsonResponse(await updateAccount(body, request), 200, origin);
    }
    return jsonResponse({ error: 'الطلب غير معروف.' }, 400, origin);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : 'تعذر تنفيذ الطلب.';
    return jsonResponse({ error: message }, 400, origin);
  }
});
