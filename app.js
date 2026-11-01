'use strict';

const LEGACY_STORAGE_KEY = 'cashier-system-local-v1';
const PERMISSIONS = [
  ['dashboard', 'الرئيسية'],
  ['sale', 'نقطة البيع'],
  ['products', 'الأصناف والمخزون'],
  ['customers', 'العملاء'],
  ['suppliers', 'الموردون'],
  ['purchases', 'فواتير المشتريات'],
  ['invoices', 'مراجعة الفواتير'],
  ['debts', 'مراجعة المديونيات'],
  ['shifts', 'الورديات'],
  ['inventory', 'الجرد']
];
const NAV_ITEMS = [
  ['dashboard', 'الرئيسية', '⌂'],
  ['sale', 'بيع', '＋'],
  ['products', 'الأصناف', '▦'],
  ['customers', 'العملاء', '♙'],
  ['suppliers', 'الموردون', '♧'],
  ['purchases', 'المشتريات', '⇩'],
  ['invoices', 'الفواتير', '▤'],
  ['debts', 'المديونيات', '◷'],
  ['shifts', 'الورديات', '◷'],
  ['inventory', 'الجرد', '▧'],
  ['receiptSettings', 'شكل البون', '▧']
];
const DEFAULT_RECEIPT_SETTINGS = {
  shopName: 'اسم المحل',
  phone: '',
  address: '',
  header: '',
  footer: 'شكرًا لزيارتكم',
  paperWidth: '80',
  fontSize: 13,
  showPhone: true,
  showAddress: true,
  showDate: true,
  showReceiptNumber: true,
  showCustomer: true,
  showCashier: true,
  showSku: true,
  showDelivery: true,
  showPaid: true
};
const emptyDb = () => ({
  version: 1,
  initialized: false,
  users: [],
  products: [],
  customers: [],
  suppliers: [],
  sales: [],
  parkedSales: [],
  purchases: [],
  payments: [],
  inventorySessions: [],
  shifts: [],
  receiptSettings: { ...DEFAULT_RECEIPT_SETTINGS }
});

let db = emptyDb();
let currentUser = null;
let currentView = 'dashboard';
let saleCart = [];
let saleFormState = { customerId: '', saleType: 'store', deliveryFee: '0', deliveryAddress: '', paid: '' };
let selectedInvoiceId = null;
let toastTimer;
let dataRevision = 0;
let supabaseClient;
let saveQueue = Promise.resolve();
let pendingSaves = 0;
let syncErrorShown = false;

function applyRemoteSession(session) {
  db = { ...emptyDb(), ...(session.data || {}) };
  db.initialized = true;
  currentUser = { id: 'public-owner', username: 'owner', displayName: 'إدارة المتجر', role: 'owner' };
  dataRevision = session.revision;
}

async function initializeApplication() {
  const config = window.CASHIER_CONFIG;
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) {
    showToast('إعداد الاتصال بقاعدة البيانات غير مكتمل.', true);
    return;
  }
  supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  try {
    const { data, error } = await supabaseClient.rpc('load_cashier_state');
    if (error) throw error;
    applyRemoteSession(data || { revision: 0, data: emptyDb() });
    showApplication();
  } catch (reason) {
    showToast(`تعذر تحميل بيانات المتجر: ${reason.message}`, true);
  }
}

function saveDatabase() {
  const snapshot = JSON.parse(JSON.stringify(db));
  delete snapshot.users;
  const operation = saveQueue.catch(() => {}).then(async () => {
    const { data, error } = await supabaseClient.rpc('save_cashier_state', {
      p_revision: dataRevision,
      p_data: snapshot
    });
    if (error) throw error;
    dataRevision = data.revision;
  });
  pendingSaves += 1;
  saveQueue = operation.finally(() => {
    pendingSaves -= 1;
  });
  return saveQueue;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function refreshRemoteSession() {
  const { data, error } = await supabaseClient.rpc('load_cashier_state');
  if (error) throw error;
  applyRemoteSession(data || { revision: 0, data: emptyDb() });
}

async function pollRemoteChanges() {
  if (!currentUser || pendingSaves || document.visibilityState === 'hidden') return;
  const activeElement = document.activeElement;
  if (activeElement && document.getElementById('page-content').contains(activeElement)) return;
  try {
    const { data, error } = await supabaseClient.rpc('load_cashier_state');
    if (error) throw error;
    syncErrorShown = false;
    if (!data || data.revision <= dataRevision) return;
    const cart = saleCart.map(item => ({ ...item }));
    const formState = { ...saleFormState };
    applyRemoteSession(data);
    saleCart = cart;
    saleFormState = formState;
    render();
    showToast('تمت مزامنة بيانات النظام من الخادم.');
  } catch (reason) {
    if (!syncErrorShown) {
      showToast(reason instanceof Error ? reason.message : 'تعذرت مزامنة البيانات مع الخادم.', true);
      syncErrorShown = true;
    }
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function money(value) {
  return `${Number(value || 0).toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م`;
}

function dateTime(value) {
  return value ? new Date(value).toLocaleString('ar-EG') : '—';
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

function activeInventory() {
  return db.inventorySessions.find(session => !session.closedAt) || null;
}

function openShift() {
  return db.shifts.find(shift => !shift.closedAt) || null;
}

function isOwner() {
  return currentUser?.role === 'owner';
}

function can(permission) {
  return isOwner() || Boolean(currentUser?.permissions?.[permission]);
}

function requireOwner() {
  if (!isOwner()) {
    showToast('هذا الإجراء متاح لحساب المالك فقط.', true);
    return false;
  }
  return true;
}

function setAuthMode() {
  const form = document.getElementById('auth-form');
  const title = document.getElementById('auth-title');
  const description = document.getElementById('auth-description');
  const submit = document.getElementById('auth-submit');
  const ownerName = document.getElementById('owner-name-field');
  const confirm = document.getElementById('confirm-password-field');
  const username = form.elements.username;

  if (!db.initialized) {
    title.textContent = 'إعداد حساب المالك';
    description.textContent = 'أنشئ حساب ist الرئيسي. هذا الحساب يملك جميع الصلاحيات.';
    submit.textContent = 'إنشاء الحساب';
    ownerName.classList.remove('hidden');
    confirm.classList.remove('hidden');
    username.value = 'ist';
    username.readOnly = true;
    form.elements.password.autocomplete = 'new-password';
    form.elements.confirmPassword.required = true;
  } else {
    title.textContent = 'تسجيل الدخول';
    description.textContent = 'أدخل اسم المستخدم وكلمة المرور للمتابعة.';
    submit.textContent = 'دخول';
    ownerName.classList.add('hidden');
    confirm.classList.add('hidden');
    username.readOnly = false;
    username.value = '';
    form.elements.password.value = '';
    form.elements.password.autocomplete = 'current-password';
    form.elements.confirmPassword.required = false;
  }
}

async function handleAuthentication(event) {
  event.preventDefault();
  const submit = document.getElementById('auth-submit');
  if (submit.disabled) return;
  submit.disabled = true;
  const form = event.currentTarget;
  const values = new FormData(form);
  const username = String(values.get('username') || '').trim().toLowerCase();
  const password = String(values.get('password') || '');
  const error = document.getElementById('auth-error');
  error.textContent = '';
  try {
    if (!db.initialized) {
      const ownerName = String(values.get('ownerName') || '').trim();
      const confirmation = String(values.get('confirmPassword') || '');
      if (!ownerName) throw new Error('اكتب اسم المالك.');
      if (username !== 'ist') throw new Error('اسم حساب المالك هو ist.');
      if (password.length < 8) throw new Error('استخدم كلمة مرور من 8 أحرف على الأقل.');
      if (password !== confirmation) throw new Error('كلمتا المرور غير متطابقتين.');
      const result = await apiRequest('setup', {
        method: 'POST',
        csrf: false,
        body: { displayName: ownerName, password }
      });
      applyRemoteSession(result.session);
      showApplication();
      showToast('تم إنشاء حساب المالك. ابدأ بإضافة الأصناف.');
      return;
    }

    const result = await apiRequest('login', {
      method: 'POST',
      csrf: false,
      body: { username, password }
    });
    applyRemoteSession(result.session);
    showApplication();
  } catch (reason) {
    error.textContent = reason instanceof Error ? reason.message : 'تعذّر تسجيل الدخول.';
  } finally {
    submit.disabled = false;
  }
}

function showApplication() {
  document.getElementById('current-user').textContent = `${currentUser.displayName} · ${currentUser.username}`;
  document.getElementById('sidebar-user').textContent = `${currentUser.displayName} · ${currentUser.username}`;
  currentView = 'dashboard';
  render();
}

async function logout() {
  const initialized = db.initialized;
  let logoutError = null;
  if (csrfToken) {
    try {
      await apiRequest('logout', { method: 'POST' });
    } catch (reason) {
      logoutError = reason;
    }
  }
  currentUser = null;
  csrfToken = '';
  dataRevision = 0;
  db = emptyDb();
  db.initialized = initialized;
  saleCart = [];
  saleFormState = { customerId: '', saleType: 'store', deliveryFee: '0', deliveryAddress: '', paid: '' };
  selectedInvoiceId = null;
  document.getElementById('application').classList.add('hidden');
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('auth-error').textContent = '';
  setAuthMode();
  if (logoutError) showToast(logoutError instanceof Error ? logoutError.message : 'تعذر إنهاء جلسة الخادم.', true);
}

function navMarkup() {
  return NAV_ITEMS.filter(([key]) => key === 'receiptSettings' ? isOwner() : can(key)).map(([key, label, icon]) => `
    <button class="nav-item ${currentView === key ? 'active' : ''}" type="button" data-view="${key}">
      <span class="nav-icon">${icon}</span><span>${label}</span>
    </button>`).join('');
}

function render() {
  if (!currentUser) return;
  const nav = document.getElementById('main-nav');
  const content = document.getElementById('page-content');
  const title = NAV_ITEMS.find(([key]) => key === currentView)?.[1] || 'الرئيسية';
  document.getElementById('page-title').textContent = title;
  document.getElementById('active-inventory').textContent = activeInventory()
    ? `الجرد: ${activeInventory().name}`
    : 'لا يوجد جرد مفتوح';
  nav.innerHTML = navMarkup();
  const views = {
    dashboard: renderDashboard,
    sale: renderSale,
    products: renderProducts,
    customers: renderCustomers,
    suppliers: renderSuppliers,
    purchases: renderPurchases,
    invoices: renderInvoices,
    debts: renderDebts,
    shifts: renderShifts,
    inventory: renderInventory,
    receiptSettings: renderReceiptSettings
  };
  content.innerHTML = (currentView === 'receiptSettings' ? isOwner() : can(currentView))
    ? views[currentView]()
    : '<div class="notice">ليس لديك صلاحية لعرض هذه الصفحة.</div>';
}

function statCard(label, value, note = '') {
  return `<article class="stat-card"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`;
}

function renderDashboard() {
  const todaySales = db.sales.filter(sale => sale.createdAt.slice(0, 10) === todayKey());
  const todayRevenue = todaySales.reduce((sum, sale) => sum + sale.total, 0);
  const lowStock = db.products.filter(product => product.stock <= product.lowStock);
  const open = openShift();
  const latest = [...db.sales].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  return `
    <div class="card-grid">
      ${statCard('مبيعات اليوم', money(todayRevenue), `${todaySales.length} فاتورة`)}
      ${statCard('الأصناف', db.products.length, 'صنف مسجل')}
      ${statCard('أصناف قاربت على النفاد', lowStock.length, 'راجع رصيد المخزون')}
      ${statCard('الوردية', open ? 'مفتوحة' : 'مغلقة', open ? `بدأت ${dateTime(open.openedAt)}` : 'ابدأ وردية قبل البيع')}
    </div>
    ${!activeInventory() ? `<div class="notice" style="margin-bottom:16px">للبدء، افتح جلسة جرد من صفحة الجرد. سيبدأ ترقيم البونات من 1 لهذه الجلسة مع بقاء الفواتير القديمة محفوظة.</div>` : ''}
    <div class="content-grid">
      <section class="table-panel">
        <div class="panel-header"><h2>أحدث الفواتير</h2><button class="button secondary small-button" data-view="invoices">مراجعة الفواتير</button></div>
        ${renderSalesTable(latest)}
      </section>
      <section class="panel">
        <h2>تنبيهات المخزون</h2>
        ${lowStock.length ? `<div class="table-wrap"><table><thead><tr><th>الصنف</th><th>المتاح</th><th>حد التنبيه</th></tr></thead><tbody>${lowStock.slice(0, 7).map(product => `<tr><td>${escapeHtml(product.name)}</td><td><span class="tag ${product.stock === 0 ? 'danger' : 'warning'}">${product.stock}</span></td><td>${product.lowStock}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">لا توجد تنبيهات مخزون حاليًا.</div>'}
      </section>
    </div>`;
}

function renderSalesTable(sales) {
  if (!sales.length) return '<div class="empty-state">لا توجد فواتير مسجلة حتى الآن.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>البون</th><th>الجرد</th><th>النوع</th><th>التاريخ</th><th>العميل</th><th>الإجمالي</th><th>المتبقي</th><th></th></tr></thead><tbody>${sales.map(sale => {
    const inventory = db.inventorySessions.find(item => item.id === sale.inventoryId);
    return `<tr><td>${escapeHtml(sale.receiptNo)}</td><td>${escapeHtml(inventory?.name || 'جرد سابق')}</td><td>${sale.saleType === 'delivery' ? 'تسليم' : 'داخل المحل'}</td><td>${dateTime(sale.createdAt)}</td><td>${escapeHtml(sale.customerName || 'عميل نقدي')}</td><td>${money(sale.total)}</td><td>${money(sale.total - sale.paid)}</td><td><button class="button secondary small-button" data-action="show-invoice" data-id="${sale.id}">عرض</button></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function productOptions(selected = '') {
  return db.products.map(product => `<option value="${product.id}" ${selected === product.id ? 'selected' : ''}>${escapeHtml(product.name)} — متاح ${product.stock}</option>`).join('');
}

function customerOptions(selected = '') {
  return `<option value="">عميل نقدي</option>${db.customers.map(customer => `<option value="${customer.id}" ${selected === customer.id ? 'selected' : ''}>${escapeHtml(customer.name)}</option>`).join('')}`;
}

function supplierOptions(selected = '') {
  return `<option value="">بدون مورد</option>${db.suppliers.map(supplier => `<option value="${supplier.id}" ${selected === supplier.id ? 'selected' : ''}>${escapeHtml(supplier.name)}</option>`).join('')}`;
}

function renderSale() {
  const inventory = activeInventory();
  const shift = openShift();
  const cartTotal = saleCart.reduce((sum, line) => sum + line.quantity * line.price, 0);
  const grandTotal = cartTotal + Number(saleFormState.deliveryFee || 0);
  const parkedSales = [...(db.parkedSales || [])].sort((a, b) => b.parkedAt.localeCompare(a.parkedAt));
  return `
    ${!inventory || !shift ? `<div class="notice" style="margin-bottom:16px">${!inventory ? 'افتح جلسة جرد أولًا.' : ''} ${!shift ? 'ابدأ وردية من صفحة الورديات قبل تسجيل البيع.' : ''}</div>` : ''}
    <div class="content-grid">
      <section class="panel">
        <h2>إضافة صنف للفاتورة</h2>
        ${!db.products.length ? '<div class="empty-state">أضف الأصناف أولًا من صفحة الأصناف.</div>' : `
          <form id="add-cart-form" class="inline-form">
            <label>كود الصنف<input name="sku" autocomplete="off" placeholder="اكتب الكود أو امسحه" autofocus></label>
            <label>أو اختر الصنف<select name="productId"><option value="">اختر الصنف</option>${productOptions()}</select></label>
            <label>الكمية<input name="quantity" type="number" min="1" step="1" value="1" required></label>
            <button class="button primary" type="submit">إضافة</button>
          </form>`}
      </section>
      <section class="panel">
        <div class="panel-header"><h2>بيانات الفاتورة</h2><button class="button secondary small-button" type="button" data-action="park-invoice" ${saleCart.length ? '' : 'disabled'}>تعليق الفاتورة</button></div>
        <div id="cart-lines">${saleCart.length ? saleCart.map((line, index) => `
          <div class="cart-line"><span>${escapeHtml(line.name)}</span><span>${line.quantity} ×</span><strong>${money(line.price * line.quantity)}</strong><button class="button danger small-button" type="button" data-action="remove-cart" data-index="${index}">حذف</button></div>`).join('') : '<div class="empty-state">السلة فارغة.</div>'}</div>
        <div class="cart-total"><span>الإجمالي قبل التوصيل</span><span>${money(cartTotal)}</span></div>
        <form id="checkout-form" class="form-grid" style="margin-top:16px">
          <label class="wide-field">العميل<select name="customerId">${customerOptions(saleFormState.customerId)}</select></label>
          <label>نوع البيع<select name="saleType"><option value="store" ${saleFormState.saleType === 'store' ? 'selected' : ''}>داخل المحل</option><option value="delivery" ${saleFormState.saleType === 'delivery' ? 'selected' : ''}>تسليم / توصيل</option></select></label>
          <label>مصاريف التوصيل<input name="deliveryFee" type="number" min="0" step="0.01" value="${escapeHtml(saleFormState.deliveryFee)}"></label>
          <div class="cart-total wide-field"><span>الإجمالي شامل التوصيل</span><span id="sale-grand-total">${money(grandTotal)}</span></div>
          <label class="wide-field">عنوان التسليم (للتوصيل)<input name="deliveryAddress" maxlength="250" value="${escapeHtml(saleFormState.deliveryAddress)}"></label>
          <label>المدفوع الآن<input name="paid" type="number" min="0" step="0.01" value="${escapeHtml(saleFormState.paid || grandTotal)}" required></label>
          <button class="button primary" type="submit" ${!cartTotal || !inventory || !shift ? 'disabled' : ''}>حفظ الفاتورة</button>
        </form>
      </section>
    </div>
    <div class="notice" style="margin-top:16px">الفواتير تُحفظ محليًا، وترقيم البون مرتبط بجلسة الجرد الحالية. المبلغ غير المدفوع يُضاف إلى مديونية العميل المحدد.</div>
    <section class="table-panel" style="margin-top:16px"><div class="panel-header"><h2>الفواتير المعلّقة</h2><span class="tag">${parkedSales.length}</span></div>${parkedSales.length ? `
      <div class="table-wrap"><table><thead><tr><th>وقت التعليق</th><th>الكاشير</th><th>العميل</th><th>الأصناف</th><th>الإجمالي التقريبي</th><th></th></tr></thead><tbody>${parkedSales.map(draft => `
        <tr><td>${dateTime(draft.parkedAt)}</td><td>${escapeHtml(draft.cashierName)}</td><td>${escapeHtml(draft.form.customerName || 'عميل نقدي')}</td><td>${draft.items.length}</td><td>${money(draft.items.reduce((sum, item) => sum + item.price * item.quantity, 0) + Number(draft.form.deliveryFee || 0))}</td><td><button class="button primary small-button" data-action="resume-invoice" data-id="${draft.id}" ${saleCart.length ? 'disabled title="علّق الفاتورة الحالية أولًا"' : ''}>استعادة</button> <button class="button danger small-button" data-action="delete-parked-invoice" data-id="${draft.id}">حذف</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">لا توجد فواتير معلّقة.</div>'}</section>
    ${selectedInvoiceId ? renderReceipt(db.sales.find(sale => sale.id === selectedInvoiceId)) : ''}`;
}

function renderProducts() {
  return `
    <section class="panel" style="margin-bottom:16px">
      <div class="panel-header"><h2>إضافة صنف</h2></div>
      <form id="product-form" class="form-grid">
        <label>اسم الصنف<input name="name" required maxlength="100"></label>
        <label>كود الصنف<input name="sku" maxlength="60"></label>
        <label>سعر البيع<input name="price" type="number" min="0" step="0.01" required></label>
        <label>تكلفة الشراء<input name="cost" type="number" min="0" step="0.01" value="0" required></label>
        <label>الرصيد الافتتاحي<input name="stock" type="number" min="0" step="1" value="0" required></label>
        <label>حد تنبيه المخزون<input name="lowStock" type="number" min="0" step="1" value="3" required></label>
        <button class="button primary" type="submit">حفظ الصنف</button>
      </form>
    </section>
    <section class="table-panel"><div class="panel-header"><h2>الأصناف المسجلة</h2><span class="tag">${db.products.length} صنف</span></div>${renderProductsTable()}</section>`;
}

function renderProductsTable() {
  if (!db.products.length) return '<div class="empty-state">لا توجد أصناف. أضف أول صنف من النموذج أعلاه.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>الصنف</th><th>الكود</th><th>سعر البيع</th><th>التكلفة</th><th>الرصيد</th><th>حد التنبيه</th><th></th></tr></thead><tbody>${db.products.map(product => `
    <tr><td>${escapeHtml(product.name)}</td><td>${escapeHtml(product.sku || '—')}</td><td>${money(product.price)}</td><td>${money(product.cost)}</td><td><span class="tag ${product.stock <= product.lowStock ? 'warning' : 'success'}">${product.stock}</span></td><td>${product.lowStock}</td><td><button class="button secondary small-button" data-action="edit-product" data-id="${product.id}">تعديل البيانات</button></td></tr>`).join('')}</tbody></table></div>`;
}

function renderPeople(kind) {
  const isCustomer = kind === 'customer';
  const rows = isCustomer ? db.customers : db.suppliers;
  const title = isCustomer ? 'عميل' : 'مورد';
  return `
    <section class="panel" style="margin-bottom:16px">
      <h2>إضافة ${title}</h2>
      <form id="person-form" class="form-grid" data-kind="${kind}">
        <label>الاسم<input name="name" required maxlength="100"></label>
        <label>رقم الهاتف<input name="phone" type="tel" maxlength="30"></label>
        <label class="wide-field">ملاحظات<input name="notes" maxlength="250"></label>
        <button class="button primary" type="submit">حفظ ${title}</button>
      </form>
    </section>
    <section class="table-panel"><h2>قائمة ${isCustomer ? 'العملاء' : 'الموردين'}</h2>${rows.length ? `
      <div class="table-wrap"><table><thead><tr><th>الاسم</th><th>الهاتف</th><th>الرصيد المستحق</th><th>ملاحظات</th></tr></thead><tbody>${rows.map(person => `
        <tr><td>${escapeHtml(person.name)}</td><td>${escapeHtml(person.phone || '—')}</td><td>${money(person.balance)}</td><td>${escapeHtml(person.notes || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">لا توجد بيانات مسجلة.</div>'}</section>`;
}

function renderCustomers() {
  return renderPeople('customer');
}

function renderSuppliers() {
  return renderPeople('supplier');
}

function renderPurchases() {
  return `
    <section class="panel" style="margin-bottom:16px">
      <h2>تسجيل فاتورة مشتريات</h2>
      ${!db.products.length ? '<div class="notice">أضف صنفًا واحدًا على الأقل قبل تسجيل المشتريات.</div>' : `
      <form id="purchase-form" class="form-grid">
        <label>الصنف<select name="productId" required>${productOptions()}</select></label>
        <label>المورد<select name="supplierId">${supplierOptions()}</select></label>
        <label>الكمية<input name="quantity" type="number" min="1" step="1" required></label>
        <label>تكلفة الوحدة<input name="unitCost" type="number" min="0" step="0.01" required></label>
        <label>المدفوع للمورد<input name="paid" type="number" min="0" step="0.01" value="0" required></label>
        <label>رقم فاتورة المورد<input name="supplierInvoice" maxlength="60"></label>
        <button class="button primary" type="submit">حفظ المشتريات</button>
      </form>`}
    </section>
    <section class="table-panel"><h2>سجل المشتريات</h2>${db.purchases.length ? `
      <div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>الصنف</th><th>المورد</th><th>الكمية</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th></tr></thead><tbody>${[...db.purchases].reverse().map(purchase => `
        <tr><td>${dateTime(purchase.createdAt)}</td><td>${escapeHtml(purchase.productName)}</td><td>${escapeHtml(purchase.supplierName || '—')}</td><td>${purchase.quantity}</td><td>${money(purchase.total)}</td><td>${money(purchase.paid)}</td><td>${money(purchase.total - purchase.paid)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">لا توجد مشتريات مسجلة.</div>'}</section>`;
}

function renderInvoices() {
  const query = document.getElementById('invoice-search')?.value?.trim().toLowerCase() || '';
  const sales = [...db.sales].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter(sale => {
      const inventory = db.inventorySessions.find(item => item.id === sale.inventoryId);
      return !query || [sale.receiptNo, sale.customerName, sale.cashierName, inventory?.name].join(' ').toLowerCase().includes(query);
    });
  const sale = db.sales.find(item => item.id === selectedInvoiceId);
  return `
    <section class="table-panel" style="margin-bottom:16px">
      <div class="section-heading"><h2>سجل فواتير البيع</h2><label style="min-width:220px">بحث برقم البون أو العميل أو الكاشير<input id="invoice-search" value="${escapeHtml(query)}" placeholder="اكتب للبحث"></label></div>
      ${renderSalesTable(sales)}
    </section>
    ${sale ? renderReceipt(sale) : ''}`;
}

function renderReceipt(sale, receiptSettings = db.receiptSettings) {
  if (!sale) return '';
  const settings = { ...DEFAULT_RECEIPT_SETTINGS, ...receiptSettings };
  const inventory = db.inventorySessions.find(item => item.id === sale.inventoryId);
  const meta = [
    settings.showReceiptNumber ? `<p>رقم البون: ${escapeHtml(sale.receiptNo)}</p>` : '',
    settings.showDate ? `<p>${dateTime(sale.createdAt)}</p>` : '',
    settings.showCustomer ? `<p>العميل: ${escapeHtml(sale.customerName || 'عميل نقدي')}</p>` : '',
    settings.showCashier ? `<p>الكاشير: ${escapeHtml(sale.cashierName)}</p>` : '',
    settings.showDelivery && sale.saleType === 'delivery'
      ? `<p>تسليم إلى: ${escapeHtml(sale.deliveryAddress || '—')}</p>` : ''
  ].filter(Boolean).join('');
  return `<section class="panel receipt" style="--receipt-width:${escapeHtml(settings.paperWidth)}mm;--receipt-font:${escapeHtml(settings.fontSize)}px">
    <div class="receipt-actions no-print"><span>معاينة البون</span><button class="button secondary small-button" type="button" onclick="window.print()">طباعة</button></div>
    <header class="receipt-header">
      <h2>${escapeHtml(settings.shopName || 'اسم المحل')}</h2>
      ${settings.showPhone && settings.phone ? `<p>${escapeHtml(settings.phone)}</p>` : ''}
      ${settings.showAddress && settings.address ? `<p>${escapeHtml(settings.address)}</p>` : ''}
      ${settings.header ? `<p>${escapeHtml(settings.header)}</p>` : ''}
    </header>
    <div class="receipt-meta">${meta}${inventory ? `<p>الجرد: ${escapeHtml(inventory.name)}</p>` : ''}</div>
    <div class="table-wrap"><table><thead><tr>${settings.showSku ? '<th>الكود</th>' : ''}<th>الصنف</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead><tbody>${sale.items.map(item => `<tr>${settings.showSku ? `<td>${escapeHtml(item.sku || '—')}</td>` : ''}<td>${escapeHtml(item.name)}</td><td>${item.quantity}</td><td>${money(item.price)}</td><td>${money(item.price * item.quantity)}</td></tr>`).join('')}</tbody></table></div>
    ${settings.showDelivery && sale.deliveryFee ? `<div class="cart-total"><span>مصاريف التوصيل</span><span>${money(sale.deliveryFee)}</span></div>` : ''}
    <div class="cart-total"><span>الإجمالي</span><span>${money(sale.total)}</span></div>
    ${settings.showPaid ? `<div class="cart-total"><span>المدفوع</span><span>${money(sale.paid)}</span></div><div class="cart-total"><span>المتبقي</span><span>${money(sale.total - sale.paid)}</span></div>` : ''}
    ${settings.footer ? `<footer class="receipt-footer">${escapeHtml(settings.footer)}</footer>` : ''}
  </section>`;
}

function receiptCheckbox(name, label, checked) {
  return `<label class="receipt-option"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}> ${label}</label>`;
}

function receiptSettingsFromForm(form) {
  const values = new FormData(form);
  return {
    shopName: String(values.get('shopName') || '').trim(),
    phone: String(values.get('phone') || '').trim(),
    address: String(values.get('address') || '').trim(),
    header: String(values.get('header') || '').trim(),
    footer: String(values.get('footer') || '').trim(),
    paperWidth: ['58', '80', '210'].includes(String(values.get('paperWidth'))) ? String(values.get('paperWidth')) : '80',
    fontSize: Math.min(20, Math.max(10, Number(values.get('fontSize')) || 13)),
    showPhone: values.has('showPhone'),
    showAddress: values.has('showAddress'),
    showDate: values.has('showDate'),
    showReceiptNumber: values.has('showReceiptNumber'),
    showCustomer: values.has('showCustomer'),
    showCashier: values.has('showCashier'),
    showSku: values.has('showSku'),
    showDelivery: values.has('showDelivery'),
    showPaid: values.has('showPaid')
  };
}

function receiptPreviewMarkup(settings) {
  const sampleSale = {
    receiptNo: '00042',
    createdAt: new Date().toISOString(),
    inventoryId: null,
    customerName: 'عميل تجريبي',
    cashierName: currentUser.displayName,
    saleType: 'store',
    deliveryAddress: '',
    deliveryFee: 0,
    items: [
      { sku: 'A-102', name: 'صنف تجريبي', quantity: 2, price: 25 },
      { sku: 'B-204', name: 'منتج آخر', quantity: 1, price: 40 }
    ],
    total: 90,
    paid: 90
  };
  return renderReceipt(sampleSale, settings);
}

function renderReceiptSettings() {
  if (!isOwner()) return '<div class="notice">إعدادات شكل البون متاحة للمالك فقط.</div>';
  const settings = { ...DEFAULT_RECEIPT_SETTINGS, ...db.receiptSettings };
  return `
    <div class="content-grid receipt-settings-layout">
      <section class="panel">
        <div class="panel-header"><h2>بيانات وشكل البون</h2><button class="button primary small-button" form="receipt-settings-form" type="submit">حفظ الإعدادات</button></div>
        <form id="receipt-settings-form" class="form-grid">
          <label>اسم المحل<input name="shopName" maxlength="100" value="${escapeHtml(settings.shopName)}"></label>
          <label>رقم الهاتف<input name="phone" type="tel" maxlength="40" value="${escapeHtml(settings.phone)}"></label>
          <label class="wide-field">العنوان<input name="address" maxlength="180" value="${escapeHtml(settings.address)}"></label>
          <label class="wide-field">عبارة أعلى البون<input name="header" maxlength="180" value="${escapeHtml(settings.header)}"></label>
          <label class="wide-field">عبارة أسفل البون<input name="footer" maxlength="180" value="${escapeHtml(settings.footer)}"></label>
          <label>عرض الورق
            <select name="paperWidth">
              <option value="58" ${settings.paperWidth === '58' ? 'selected' : ''}>حراري 58 مم</option>
              <option value="80" ${settings.paperWidth === '80' ? 'selected' : ''}>حراري 80 مم</option>
              <option value="210" ${settings.paperWidth === '210' ? 'selected' : ''}>A4</option>
            </select>
          </label>
          <label>حجم الخط (10–20)
            <input name="fontSize" type="number" min="10" max="20" value="${settings.fontSize}">
          </label>
          <div class="wide-field"><strong>المعلومات التي تظهر على البون</strong><div class="receipt-options">
            ${receiptCheckbox('showReceiptNumber', 'رقم البون', settings.showReceiptNumber)}
            ${receiptCheckbox('showDate', 'التاريخ والوقت', settings.showDate)}
            ${receiptCheckbox('showPhone', 'هاتف المحل', settings.showPhone)}
            ${receiptCheckbox('showAddress', 'عنوان المحل', settings.showAddress)}
            ${receiptCheckbox('showCustomer', 'اسم العميل', settings.showCustomer)}
            ${receiptCheckbox('showCashier', 'اسم الكاشير', settings.showCashier)}
            ${receiptCheckbox('showSku', 'كود الصنف', settings.showSku)}
            ${receiptCheckbox('showDelivery', 'بيانات ومصاريف التسليم', settings.showDelivery)}
            ${receiptCheckbox('showPaid', 'المدفوع والمتبقي', settings.showPaid)}
          </div></div>
        </form>
        <p class="muted">تظهر التعديلات في المعاينة مباشرة. تُطبّق الإعدادات المحفوظة على الفواتير القديمة والجديدة.</p>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>معاينة قبل الطباعة</h2><button class="button secondary small-button no-print" type="button" onclick="window.print()">طباعة تجريبية</button></div>
        <div id="receipt-preview">${receiptPreviewMarkup(settings)}</div>
      </section>
    </div>`;
}

function renderDebts() {
  const customerDebts = db.customers.filter(customer => customer.balance > 0);
  const supplierDebts = db.suppliers.filter(supplier => supplier.balance > 0);
  return `
    <div class="content-grid">
      <section class="table-panel"><h2>مديونيات العملاء</h2>${renderDebtTable(customerDebts, 'customer')}</section>
      <section class="table-panel"><h2>مستحقات الموردين</h2>${renderDebtTable(supplierDebts, 'supplier')}</section>
    </div>
    <section class="table-panel" style="margin-top:16px"><h2>سجل التحصيلات والمدفوعات</h2>${db.payments.length ? `
      <div class="table-wrap"><table><thead><tr><th>التاريخ</th><th>الطرف</th><th>النوع</th><th>المبلغ</th><th>المسجل</th><th>ملاحظات</th></tr></thead><tbody>${[...db.payments].reverse().map(payment => `
        <tr><td>${dateTime(payment.createdAt)}</td><td>${escapeHtml(payment.personName)}</td><td>${payment.kind === 'customer' ? 'تحصيل من عميل' : 'سداد لمورد'}</td><td>${money(payment.amount)}</td><td>${escapeHtml(payment.userName)}</td><td>${escapeHtml(payment.notes || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">لا توجد حركات مالية مسجلة.</div>'}</section>`;
}

function renderDebtTable(people, kind) {
  if (!people.length) return '<div class="empty-state">لا توجد مديونيات مستحقة.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>الاسم</th><th>الرصيد</th><th></th></tr></thead><tbody>${people.map(person => `
    <tr><td>${escapeHtml(person.name)}</td><td>${money(person.balance)}</td><td><button class="button primary small-button" data-action="record-payment" data-id="${person.id}" data-kind="${kind}">${kind === 'customer' ? 'تسجيل تحصيل' : 'تسجيل سداد'}</button></td></tr>`).join('')}</tbody></table></div>`;
}

function shiftCashSummary(shift) {
  const sales = db.sales.filter(sale => sale.shiftId === shift.id);
  const purchases = db.purchases.filter(purchase => purchase.shiftId === shift.id);
  const payments = db.payments.filter(payment => payment.shiftId === shift.id);
  const received = sales.reduce((sum, sale) => sum + sale.paid, 0);
  const spent = purchases.reduce((sum, purchase) => sum + purchase.paid, 0);
  const debtReceived = payments.filter(payment => payment.kind === 'customer').reduce((sum, payment) => sum + payment.amount, 0);
  const debtPaid = payments.filter(payment => payment.kind === 'supplier').reduce((sum, payment) => sum + payment.amount, 0);
  return {
    sales: sales.reduce((sum, sale) => sum + sale.total, 0),
    received: received + debtReceived, spent: spent + debtPaid,
    expected: shift.openingCash + received + debtReceived - spent - debtPaid
  };
}

function renderShifts() {
  const shift = openShift();
  const summary = shift ? shiftCashSummary(shift) : null;
  return `
    <div class="content-grid">
      <section class="panel">
        <h2>${shift ? 'الوردية الحالية' : 'بدء وردية'}</h2>
        ${shift ? `
          <p class="muted">بدأت: ${dateTime(shift.openedAt)} · بواسطة ${escapeHtml(shift.userName)}</p>
          <div class="card-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
            ${statCard('إجمالي المبيعات', money(summary.sales))}
            ${statCard('النقد المتوقع بالصندوق', money(summary.expected), 'الرصيد الافتتاحي + المقبوضات - المدفوعات')}
          </div>
          <form id="close-shift-form" class="inline-form"><label>النقد الفعلي عند الإغلاق<input name="countedCash" type="number" min="0" step="0.01" required></label><button class="button primary" type="submit">إغلاق الوردية</button></form>
        ` : `<form id="open-shift-form" class="inline-form"><label>النقد الافتتاحي بالصندوق<input name="openingCash" type="number" min="0" step="0.01" value="0" required></label><button class="button primary" type="submit">بدء الوردية</button></form>`}
      </section>
      <section class="table-panel"><h2>سجل الورديات</h2>${db.shifts.length ? `
        <div class="table-wrap"><table><thead><tr><th>بداية الوردية</th><th>الكاشير</th><th>افتتاحي</th><th>متوقع</th><th>فعلي</th><th>الفرق</th><th>الحالة</th></tr></thead><tbody>${[...db.shifts].reverse().map(item => {
          const totals = shiftCashSummary(item);
          const difference = item.closedAt ? item.countedCash - totals.expected : null;
          return `<tr><td>${dateTime(item.openedAt)}</td><td>${escapeHtml(item.userName)}</td><td>${money(item.openingCash)}</td><td>${money(totals.expected)}</td><td>${item.closedAt ? money(item.countedCash) : '—'}</td><td>${difference === null ? '—' : money(difference)}</td><td><span class="tag ${item.closedAt ? '' : 'success'}">${item.closedAt ? 'مغلقة' : 'مفتوحة'}</span></td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty-state">لا توجد ورديات مسجلة.</div>'}</section>
    </div>`;
}

function renderInventory() {
  const session = activeInventory();
  return `
    <section class="panel" style="margin-bottom:16px">
      <div class="panel-header"><h2>${session ? `الجرد الحالي: ${escapeHtml(session.name)}` : 'فتح جلسة جرد جديدة'}</h2></div>
      ${session ? `
        <p class="muted">بدأ في ${dateTime(session.startedAt)} · البون التالي: ${session.nextReceiptNumber}</p>
        ${isOwner() ? `<form id="stock-count-form" class="inline-form">
          <label>الصنف<select name="productId" required>${productOptions()}</select></label>
          <label>الكمية الفعلية<input name="counted" type="number" min="0" step="1" required></label>
          <button class="button secondary" type="submit">تسجيل جرد الصنف</button>
        </form>
        <form id="close-inventory-form" class="inline-form" style="margin-top:12px">
          <label>اسم الجرد التالي<input name="name" placeholder="مثال: جرد نوفمبر" required></label>
          <button class="button primary" type="submit">إنهاء الجرد وبدء جرد جديد</button>
        </form>` : '<div class="notice">الجرد والتسويات متاحة للمالك فقط.</div>'}
      ` : isOwner() ? `
        <form id="start-inventory-form" class="inline-form"><label>اسم الجرد<input name="name" placeholder="مثال: الجرد الأول" required></label><button class="button primary" type="submit">بدء الجرد</button></form>
      ` : '<div class="notice">اطلب من المالك بدء جلسة الجرد.</div>'}
    </section>
    <section class="table-panel" style="margin-bottom:16px"><h2>سجل جلسات الجرد</h2>${db.inventorySessions.length ? `
      <div class="table-wrap"><table><thead><tr><th>الجرد</th><th>البداية</th><th>النهاية</th><th>الفواتير</th><th>تسويات المخزون</th></tr></thead><tbody>${[...db.inventorySessions].reverse().map(item => `
        <tr><td>${escapeHtml(item.name)}</td><td>${dateTime(item.startedAt)}</td><td>${dateTime(item.closedAt)}</td><td>${db.sales.filter(sale => sale.inventoryId === item.id).length}</td><td>${item.adjustments.length}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">لم تبدأ جلسة جرد بعد.</div>'}</section>
    <section class="table-panel"><h2>سجل فروقات الجرد</h2>${(() => {
      const adjustments = db.inventorySessions.flatMap(item => item.adjustments.map(adjustment => ({ ...adjustment, inventoryName: item.name }))).reverse();
      return adjustments.length ? `<div class="table-wrap"><table><thead><tr><th>الجرد</th><th>الصنف</th><th>الرصيد قبل</th><th>الكمية الفعلية</th><th>الفرق</th><th>المسجل</th><th>التاريخ</th></tr></thead><tbody>${adjustments.map(item => `
        <tr><td>${escapeHtml(item.inventoryName)}</td><td>${escapeHtml(item.productName)}</td><td>${item.before}</td><td>${item.counted}</td><td><span class="tag ${item.difference === 0 ? 'success' : 'warning'}">${item.difference > 0 ? '+' : ''}${item.difference}</span></td><td>${escapeHtml(item.userName)}</td><td>${dateTime(item.createdAt)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">لا توجد فروقات جرد مسجلة.</div>';
    })()}</section>`;
}

function updateReceiptPreview(form) {
  const preview = document.getElementById('receipt-preview');
  if (preview) preview.innerHTML = receiptPreviewMarkup(receiptSettingsFromForm(form));
}

function renderUsers() {
  if (!isOwner()) return '<div class="notice">إدارة الحسابات متاحة للمالك فقط.</div>';
  const permissionInputs = PERMISSIONS.filter(([key]) => key !== 'users').map(([key, label]) => `
    <label><input type="checkbox" name="permissions" value="${key}" checked> ${label}</label>`).join('');
  return `
    <section class="panel" style="margin-bottom:16px">
      <h2>إنشاء حساب كاشير</h2>
      <form id="user-form" class="form-grid">
        <label>اسم العرض<input name="displayName" required maxlength="80"></label>
        <label>اسم المستخدم<input name="username" required minlength="3" maxlength="30" autocomplete="off"></label>
        <label>كلمة المرور<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
        <div class="wide-field"><strong>الصلاحيات</strong><div class="permission-list">${permissionInputs}</div></div>
        <button class="button primary" type="submit">إنشاء الحساب</button>
      </form>
    </section>
    <section class="table-panel"><h2>الحسابات</h2><div class="table-wrap"><table><thead><tr><th>الاسم</th><th>المستخدم</th><th>الصلاحيات</th><th>الحالة</th><th></th></tr></thead><tbody>${db.users.map(user => `
      <tr><td>${escapeHtml(user.displayName)}</td><td>${escapeHtml(user.username)}</td><td>${user.role === 'owner' ? 'كامل الصلاحيات' : PERMISSIONS.filter(([key]) => user.permissions[key]).map(([, label]) => label).join('، ') || 'لا توجد'}</td><td><span class="tag ${user.active ? 'success' : 'danger'}">${user.active ? 'نشط' : 'موقوف'}</span></td><td>${user.role === 'owner' ? 'المالك' : `<details><summary class="button secondary small-button">الصلاحيات</summary><form class="stack" id="update-user-permissions-form" data-user-id="${user.id}" style="min-width:220px;padding:10px"><div class="permission-list">${PERMISSIONS.filter(([key]) => key !== 'users').map(([key, label]) => `<label><input type="checkbox" name="permissions" value="${key}" ${user.permissions[key] ? 'checked' : ''}> ${label}</label>`).join('')}</div><button class="button primary small-button" type="submit">حفظ الصلاحيات</button></form></details><button class="button ${user.active ? 'danger' : 'primary'} small-button" data-action="toggle-user" data-id="${user.id}">${user.active ? 'إيقاف الحساب' : 'تفعيل الحساب'}</button>`}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function addPerson(kind, values) {
  const list = kind === 'customer' ? db.customers : db.suppliers;
  list.push({
    id: newId(kind), name: String(values.get('name')).trim(),
    phone: String(values.get('phone') || '').trim(), notes: String(values.get('notes') || '').trim(),
    balance: 0, createdAt: new Date().toISOString()
  });
}

async function notifySaved(message) {
  const intendedState = JSON.parse(JSON.stringify(db));
  delete intendedState.users;
  try {
    await saveDatabase();
    render();
    showToast(message);
    return true;
  } catch (reason) {
    try {
      await refreshRemoteSession();
      render();
    } catch (refreshError) {
      showToast(refreshError instanceof Error ? refreshError.message : 'تعذر تحديث البيانات من الخادم.', true);
      return false;
    }
    const refreshedState = JSON.parse(JSON.stringify(db));
    delete refreshedState.users;
    if (stableJson(intendedState) === stableJson(refreshedState)) {
      showToast(message);
      return true;
    }
    showToast(reason instanceof Error ? reason.message : 'تعذر حفظ البيانات على الخادم.', true);
    return false;
  }
}

function handleAddCart(form) {
  const values = new FormData(form);
  const sku = String(values.get('sku') || '').trim().toLowerCase();
  const product = sku
    ? db.products.find(item => item.sku && item.sku.trim().toLowerCase() === sku)
    : db.products.find(item => item.id === values.get('productId'));
  const quantity = Number(values.get('quantity'));
  if (!product) throw new Error(sku ? 'كود الصنف غير موجود. تحقق من الكود أو اختر الصنف من القائمة.' : 'اكتب كود الصنف أو اختر صنفًا من القائمة.');
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('أدخل كمية صحيحة.');
  const inCart = saleCart.find(line => line.productId === product.id);
  if (quantity + (inCart?.quantity || 0) > product.stock) throw new Error('الكمية المطلوبة أكبر من الرصيد المتاح.');
  if (inCart) inCart.quantity += quantity;
  else saleCart.push({ productId: product.id, name: product.name, sku: product.sku || '', quantity, price: product.price });
  form.reset();
  saleFormState.paid = '';
  render();
  document.querySelector('#add-cart-form input[name="sku"]')?.focus();
}

async function parkCurrentInvoice() {
  if (!saleCart.length) throw new Error('أضف صنفًا واحدًا على الأقل قبل تعليق الفاتورة.');
  const cartToRetry = saleCart.map(item => ({ ...item }));
  const form = document.getElementById('checkout-form');
  if (form) {
    const values = new FormData(form);
    saleFormState = {
      customerId: String(values.get('customerId') || ''),
      saleType: String(values.get('saleType') || 'store'),
      deliveryFee: String(values.get('deliveryFee') || '0'),
      deliveryAddress: String(values.get('deliveryAddress') || ''),
      paid: String(values.get('paid') || '')
    };
  }
  const customer = db.customers.find(item => item.id === saleFormState.customerId);
  db.parkedSales = db.parkedSales || [];
  db.parkedSales.push({
    id: newId('parked'), cashierName: currentUser.displayName,
    items: saleCart.map(item => ({ ...item })),
    form: { ...saleFormState, customerName: customer?.name || '' },
    parkedAt: new Date().toISOString()
  });
  saleCart = [];
  saleFormState = { customerId: '', saleType: 'store', deliveryFee: '0', deliveryAddress: '', paid: '' };
  if (!await notifySaved('تم تعليق الفاتورة. يمكنك استعادتها من قائمة الفواتير المعلّقة.')) {
    saleCart = cartToRetry;
    render();
  }
}

async function resumeParkedInvoice(id) {
  if (saleCart.length) throw new Error('علّق الفاتورة الحالية أولًا قبل استعادة فاتورة أخرى.');
  const index = (db.parkedSales || []).findIndex(draft => draft.id === id);
  if (index < 0) throw new Error('الفاتورة المعلّقة غير موجودة.');
  const [draft] = db.parkedSales.splice(index, 1);
  saleCart = draft.items.map(item => ({ ...item }));
  saleFormState = {
    customerId: draft.form.customerId || '',
    saleType: draft.form.saleType || 'store',
    deliveryFee: String(draft.form.deliveryFee || '0'),
    deliveryAddress: draft.form.deliveryAddress || '',
    paid: draft.form.paid || ''
  };
  await notifySaved('تمت استعادة الفاتورة إلى نقطة البيع.');
}

async function handleCheckout(form) {
  if (!activeInventory()) throw new Error('افتح جلسة جرد أولًا.');
  const shift = openShift();
  if (!shift) throw new Error('ابدأ وردية قبل تسجيل البيع.');
  if (!saleCart.length) throw new Error('أضف صنفًا واحدًا على الأقل.');
  const values = new FormData(form);
  const subtotal = saleCart.reduce((sum, line) => sum + line.price * line.quantity, 0);
  const deliveryFee = Number(values.get('deliveryFee') || 0);
  const saleType = String(values.get('saleType') || 'store');
  const deliveryAddress = String(values.get('deliveryAddress') || '').trim();
  if (!Number.isFinite(deliveryFee) || deliveryFee < 0) throw new Error('تحقق من مصاريف التوصيل.');
  if (saleType === 'delivery' && !deliveryAddress) throw new Error('اكتب عنوان التسليم.');
  const total = subtotal + deliveryFee;
  const paid = Number(values.get('paid'));
  if (!Number.isFinite(paid) || paid < 0 || paid > total) throw new Error('تحقق من مبلغ المدفوع؛ لا يمكن أن يتجاوز إجمالي الفاتورة.');
  const customerId = String(values.get('customerId') || '');
  const customer = db.customers.find(item => item.id === customerId);
  if ((paid < total || saleType === 'delivery') && !customer) throw new Error('اختر عميلًا مسجلًا لإضافة المديونية أو تسجيل بيانات التسليم.');
  const latestInventory = activeInventory();
  const cartToRetry = saleCart.map(line => ({ ...line }));
  const formToRetry = {
    customerId,
    saleType,
    deliveryFee: String(values.get('deliveryFee') || '0'),
    deliveryAddress,
    paid: String(values.get('paid') || '')
  };
  for (const line of saleCart) {
    const product = db.products.find(item => item.id === line.productId);
    if (!product || product.stock < line.quantity) throw new Error(`الرصيد غير كافٍ للصنف ${line.name}.`);
  }
  const receiptNo = `${String(latestInventory.nextReceiptNumber).padStart(5, '0')}`;
  const sale = {
    id: newId('sale'), receiptNo, inventoryId: latestInventory.id, shiftId: shift.id,
    customerId: customer?.id || null, customerName: customer?.name || '',
    cashierId: currentUser.id, cashierName: currentUser.displayName,
    saleType, deliveryAddress: saleType === 'delivery' ? deliveryAddress : '',
    deliveryFee, items: saleCart.map(line => ({ ...line })), total, paid, createdAt: new Date().toISOString()
  };
  saleCart.forEach(line => {
    const product = db.products.find(item => item.id === line.productId);
    product.stock -= line.quantity;
  });
  latestInventory.nextReceiptNumber += 1;
  db.sales.push(sale);
  if (customer) customer.balance += total - paid;
  selectedInvoiceId = sale.id;
  saleCart = [];
  saleFormState = { customerId: '', saleType: 'store', deliveryFee: '0', deliveryAddress: '', paid: '' };
  if (!await notifySaved(`تم حفظ البون رقم ${receiptNo}.`)) {
    saleCart = cartToRetry;
    saleFormState = formToRetry;
    currentView = 'sale';
    render();
    return;
  }
  currentView = can('invoices') ? 'invoices' : 'sale';
  render();
}

async function handlePurchase(form) {
  const values = new FormData(form);
  const product = db.products.find(item => item.id === values.get('productId'));
  const supplier = db.suppliers.find(item => item.id === values.get('supplierId'));
  const quantity = Number(values.get('quantity'));
  const unitCost = Number(values.get('unitCost'));
  const paid = Number(values.get('paid'));
  if (!product || !Number.isInteger(quantity) || quantity <= 0) throw new Error('تحقق من الصنف والكمية.');
  if (![unitCost, paid].every(Number.isFinite) || unitCost < 0 || paid < 0) throw new Error('تحقق من التكلفة والمبلغ المدفوع.');
  const shift = openShift();
  if (paid > 0 && !shift) throw new Error('ابدأ وردية قبل تسجيل دفعة نقدية للمورد.');
  const total = quantity * unitCost;
  if (paid > total) throw new Error('المدفوع لا يمكن أن يتجاوز إجمالي المشتريات.');
  const purchase = {
    id: newId('purchase'), productId: product.id, productName: product.name,
    supplierId: supplier?.id || null, supplierName: supplier?.name || '',
    supplierInvoice: String(values.get('supplierInvoice') || '').trim(), quantity, unitCost, total, paid,
    shiftId: shift?.id || null, userName: currentUser.displayName, createdAt: new Date().toISOString()
  };
  product.stock += quantity;
  product.cost = unitCost;
  if (supplier) supplier.balance += total - paid;
  db.purchases.push(purchase);
  await notifySaved('تم تسجيل فاتورة المشتريات وتحديث رصيد الصنف.');
}

async function recordPayment(kind, id) {
  const shift = openShift();
  if (!shift) throw new Error('ابدأ وردية قبل تسجيل تحصيل أو سداد نقدي.');
  const people = kind === 'customer' ? db.customers : db.suppliers;
  const person = people.find(item => item.id === id);
  if (!person || person.balance <= 0) throw new Error('لا يوجد رصيد مستحق لهذا الطرف.');
  const answer = window.prompt(`الرصيد الحالي ${money(person.balance)}. أدخل مبلغ ${kind === 'customer' ? 'التحصيل' : 'السداد'}:`);
  if (answer === null) return;
  const amount = Number(answer);
  if (!Number.isFinite(amount) || amount <= 0 || amount > person.balance) throw new Error('أدخل مبلغًا صحيحًا لا يتجاوز الرصيد المستحق.');
  const notes = window.prompt('ملاحظات (اختياري):') || '';
  person.balance -= amount;
  db.payments.push({
    id: newId('payment'), kind, personId: person.id, personName: person.name,
    amount, notes: notes.trim(), userName: currentUser.displayName, shiftId: shift.id, createdAt: new Date().toISOString()
  });
  await notifySaved('تم تسجيل الحركة وتحديث الرصيد.');
}

async function handleFormSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const submit = event.submitter || form.querySelector('button[type="submit"]');
  if (submit?.disabled) return;
  if (submit) submit.disabled = true;
  try {
    const values = new FormData(form);
    switch (form.id) {
      case 'add-cart-form':
        handleAddCart(form);
        break;
      case 'checkout-form':
        await handleCheckout(form);
        break;
      case 'product-form': {
        const name = String(values.get('name')).trim();
        const sku = String(values.get('sku') || '').trim();
        if (sku && db.products.some(product => product.sku.toLowerCase() === sku.toLowerCase())) throw new Error('كود الصنف مستخدم بالفعل.');
        db.products.push({
          id: newId('product'), name, sku, price: Number(values.get('price')), cost: Number(values.get('cost')),
          stock: Number(values.get('stock')), lowStock: Number(values.get('lowStock')), createdAt: new Date().toISOString()
        });
        await notifySaved('تم حفظ الصنف.');
        break;
      }
      case 'person-form':
        addPerson(form.dataset.kind, values);
        await notifySaved('تم حفظ البيانات.');
        break;
      case 'purchase-form':
        await handlePurchase(form);
        break;
      case 'open-shift-form':
        if (openShift()) throw new Error('توجد وردية مفتوحة بالفعل.');
        db.shifts.push({
          id: newId('shift'), userId: currentUser.id, userName: currentUser.displayName,
          openingCash: Number(values.get('openingCash')), openedAt: new Date().toISOString(), closedAt: null
        });
        await notifySaved('بدأت الوردية.');
        break;
      case 'close-shift-form': {
        const shift = openShift();
        if (!shift) throw new Error('لا توجد وردية مفتوحة.');
        shift.countedCash = Number(values.get('countedCash'));
        shift.closedAt = new Date().toISOString();
        await notifySaved('تم إغلاق الوردية وحفظ الفرق.');
        break;
      }
      case 'start-inventory-form':
        if (!requireOwner()) return;
        if (activeInventory()) throw new Error('هناك جرد مفتوح بالفعل.');
        db.inventorySessions.push({
          id: newId('inventory'), name: String(values.get('name')).trim(), startedAt: new Date().toISOString(),
          nextReceiptNumber: 1, adjustments: []
        });
        await notifySaved('بدأت جلسة الجرد. تسلسل البونات يبدأ من 00001.');
        break;
      case 'close-inventory-form': {
        if (!requireOwner()) return;
        const session = activeInventory();
        if (!session) throw new Error('لا توجد جلسة جرد مفتوحة.');
        session.closedAt = new Date().toISOString();
        db.inventorySessions.push({
          id: newId('inventory'), name: String(values.get('name')).trim(), startedAt: new Date().toISOString(),
          nextReceiptNumber: 1, adjustments: []
        });
        await notifySaved('انتهى الجرد السابق وبدأ جرد جديد. الفواتير القديمة محفوظة.');
        break;
      }
      case 'stock-count-form': {
        if (!requireOwner()) return;
        const session = activeInventory();
        const product = db.products.find(item => item.id === values.get('productId'));
        const counted = Number(values.get('counted'));
        if (!session || !product || !Number.isInteger(counted) || counted < 0) throw new Error('تحقق من الصنف والكمية الفعلية.');
        const before = product.stock;
        product.stock = counted;
        session.adjustments.push({
          id: newId('adjustment'), productId: product.id, productName: product.name,
          before, counted, difference: counted - before, userName: currentUser.displayName, createdAt: new Date().toISOString()
        });
        await notifySaved(`تم تحديث الرصيد. فرق الجرد: ${counted - before}.`);
        break;
      }
      case 'user-form': {
        if (!requireOwner()) return;
        const username = String(values.get('username')).trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('اسم المستخدم: 3 أحرف على الأقل، وبالإنجليزية أو الأرقام أو . _ -');
        if (db.users.some(user => user.username === username)) throw new Error('اسم المستخدم موجود بالفعل.');
        const password = String(values.get('password'));
        if (password.length < 8) throw new Error('كلمة المرور يجب ألا تقل عن 8 أحرف.');
        const permissions = Object.fromEntries(PERMISSIONS.map(([key]) => [key, values.getAll('permissions').includes(key)]));
        const result = await apiRequest('create-user', {
          method: 'POST',
          body: { username, displayName: String(values.get('displayName')).trim(), password, permissions }
        });
        db.users.push(result.user);
        dataRevision = result.revision;
        render();
        showToast('تم إنشاء حساب الكاشير.');
        break;
      }
      case 'update-user-permissions-form': {
        if (!requireOwner()) return;
        const user = db.users.find(account => account.id === form.dataset.userId && account.role === 'cashier');
        if (!user) throw new Error('حساب الكاشير غير موجود.');
        const permissions = Object.fromEntries(PERMISSIONS.map(([key]) => [
          key, key !== 'users' && values.getAll('permissions').includes(key)
        ]));
        const result = await apiRequest('update-user', {
          method: 'POST',
          body: { userId: user.id, permissions }
        });
        Object.assign(user, result.user);
        dataRevision = result.revision;
        render();
        showToast('تم تحديث صلاحيات الحساب.');
        break;
      }
      case 'receipt-settings-form':
        if (!requireOwner()) return;
        db.receiptSettings = receiptSettingsFromForm(form);
        await notifySaved('تم حفظ إعدادات شكل البون.');
        break;
      default:
        return;
    }
  } catch (reason) {
    showToast(reason instanceof Error ? reason.message : 'تعذّر تنفيذ العملية.', true);
  } finally {
    if (submit?.isConnected) submit.disabled = false;
  }
}

async function handleClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) {
    currentView = button.dataset.view;
    selectedInvoiceId = null;
    render();
    return;
  }
  const { action, id, kind, index } = button.dataset;
  if (!action) return;
  if (button.disabled) return;
  button.disabled = true;
  try {
    if (action === 'remove-cart') {
      saleCart.splice(Number(index), 1);
      render();
    } else if (action === 'park-invoice') {
      await parkCurrentInvoice();
    } else if (action === 'resume-invoice') {
      await resumeParkedInvoice(id);
    } else if (action === 'delete-parked-invoice') {
      const draftIndex = (db.parkedSales || []).findIndex(draft => draft.id === id);
      if (draftIndex < 0) throw new Error('الفاتورة المعلّقة غير موجودة.');
      if (!window.confirm('هل تريد حذف الفاتورة المعلّقة؟')) return;
      db.parkedSales.splice(draftIndex, 1);
      await notifySaved('تم حذف الفاتورة المعلّقة.');
    } else if (action === 'show-invoice') {
      selectedInvoiceId = id;
      currentView = 'invoices';
      render();
    } else if (action === 'record-payment') {
      await recordPayment(kind, id);
    } else if (action === 'toggle-user') {
      if (!requireOwner()) return;
      const user = db.users.find(item => item.id === id);
      if (!user || user.role === 'owner') throw new Error('لا يمكن تغيير حالة هذا الحساب.');
      const active = !user.active;
      const result = await apiRequest('update-user', {
        method: 'POST',
        body: { userId: user.id, active }
      });
      Object.assign(user, result.user);
      dataRevision = result.revision;
      render();
      showToast(user.active ? 'تم تفعيل الحساب.' : 'تم إيقاف الحساب.');
    } else if (action === 'edit-product') {
      const product = db.products.find(item => item.id === id);
      if (!product) throw new Error('الصنف غير موجود.');
      const priceAnswer = window.prompt(`سعر البيع للصنف ${product.name}:`, String(product.price));
      if (priceAnswer === null) return;
      const costAnswer = window.prompt('تكلفة الشراء:', String(product.cost));
      if (costAnswer === null) return;
      const lowStockAnswer = window.prompt('حد تنبيه المخزون:', String(product.lowStock));
      if (lowStockAnswer === null) return;
      const price = Number(priceAnswer);
      const cost = Number(costAnswer);
      const lowStock = Number(lowStockAnswer);
      if (![price, cost, lowStock].every(Number.isFinite) || price < 0 || cost < 0 || !Number.isInteger(lowStock) || lowStock < 0) {
        throw new Error('أدخل أسعارًا صحيحة وحد تنبيه صحيحًا.');
      }
      product.price = price;
      product.cost = cost;
      product.lowStock = lowStock;
      await notifySaved('تم تحديث بيانات الصنف.');
    }
  } catch (reason) {
    showToast(reason instanceof Error ? reason.message : 'تعذّر تنفيذ الإجراء.', true);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function exportBackup() {
  try {
    const backup = { ...JSON.parse(JSON.stringify(db)), exportedAt: new Date().toISOString() };
    delete backup.users;
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `cashier-backup-${todayKey()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showToast('تم تنزيل النسخة الاحتياطية. احتفظ بها في مكان آمن.');
  } catch (reason) {
    showToast(reason instanceof Error ? reason.message : 'تعذر إنشاء النسخة الاحتياطية.', true);
  }
}

async function importBackup(file) {
  if (!requireOwner()) return;
  if (!window.confirm('سيتم استبدال بيانات النظام المشتركة بالنسخة المختارة على جميع الأجهزة. هل أنشأت نسخة احتياطية من البيانات الحالية؟')) return;
  const imported = JSON.parse(await file.text());
  const requiredArrays = ['products', 'customers', 'suppliers', 'sales', 'purchases', 'payments', 'inventorySessions', 'shifts'];
  if (imported.version !== 1 || requiredArrays.some(key => !Array.isArray(imported[key]))) {
    throw new Error('ملف النسخة الاحتياطية غير صالح أو من إصدار غير مدعوم.');
  }
  delete imported.users;
  delete imported.exportedAt;
  const { data, error } = await supabaseClient.rpc('save_cashier_state', {
    p_revision: dataRevision,
    p_data: imported
  });
  if (error) throw error;
  applyRemoteSession({ revision: data.revision, data: imported });
  render();
  showToast('تمت استعادة النسخة الاحتياطية على جميع الأجهزة.');
}

document.getElementById('page-content').addEventListener('submit', handleFormSubmit);
document.getElementById('application').addEventListener('click', handleClick);
document.getElementById('backup-button').addEventListener('click', exportBackup);
document.getElementById('restore-input').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await importBackup(file);
  } catch (reason) {
    showToast(reason instanceof Error ? reason.message : 'تعذّرت استعادة النسخة الاحتياطية.', true);
  } finally {
    event.target.value = '';
  }
});
document.getElementById('page-content').addEventListener('input', event => {
  if (event.target.id === 'invoice-search') {
    const cursor = event.target.selectionStart;
    render();
    const input = document.getElementById('invoice-search');
    input.focus();
    input.setSelectionRange(cursor, cursor);
  } else if (event.target.form?.id === 'checkout-form') {
    const form = event.target.form;
    const values = new FormData(form);
    saleFormState = {
      customerId: String(values.get('customerId') || ''),
      saleType: String(values.get('saleType') || 'store'),
      deliveryFee: String(values.get('deliveryFee') || '0'),
      deliveryAddress: String(values.get('deliveryAddress') || ''),
      paid: String(values.get('paid') || '')
    };
    const fee = Number(saleFormState.deliveryFee);
    const subtotal = saleCart.reduce((sum, line) => sum + line.quantity * line.price, 0);
    const total = document.getElementById('sale-grand-total');
    if (total) total.textContent = money(subtotal + (Number.isFinite(fee) && fee > 0 ? fee : 0));
  } else if (event.target.form?.id === 'receipt-settings-form') {
    updateReceiptPreview(event.target.form);
  }
});
document.getElementById('page-content').addEventListener('change', event => {
  if (event.target.form?.id === 'checkout-form') {
    const values = new FormData(event.target.form);
    saleFormState = {
      customerId: String(values.get('customerId') || ''),
      saleType: String(values.get('saleType') || 'store'),
      deliveryFee: String(values.get('deliveryFee') || '0'),
      deliveryAddress: String(values.get('deliveryAddress') || ''),
      paid: String(values.get('paid') || '')
    };
  } else if (event.target.form?.id === 'receipt-settings-form') {
    updateReceiptPreview(event.target.form);
  }
});

initializeApplication();
setInterval(pollRemoteChanges, 10000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') pollRemoteChanges();
});
