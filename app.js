(() => {
  "use strict";

  const config = window.CASHIER_CONFIG;
  const loginView = document.getElementById("loginView");
  const appView = document.getElementById("appView");
  const accountBar = document.getElementById("accountBar");
  const loginForm = document.getElementById("loginForm");
  const recoveryForm = document.getElementById("recoveryForm");
  const updatePasswordForm = document.getElementById("updatePasswordForm");
  const loginError = document.getElementById("loginError");
  const appMessage = document.getElementById("appMessage");
  const money = new Intl.NumberFormat("ar-EG", { style: "currency", currency: "EGP" });
  let supabase;
  let products = [];
  let cart = new Map();
  let refreshTimer;

  const byId = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const formatMoney = (value) => money.format(Number(value) || 0);

  function setMessage(text, isError = false) {
    appMessage.textContent = text;
    appMessage.classList.toggle("error-text", isError);
  }

  function setLoggedIn(isLoggedIn, email = "") {
    loginView.classList.toggle("hidden", isLoggedIn);
    appView.classList.toggle("hidden", !isLoggedIn);
    accountBar.classList.toggle("hidden", !isLoggedIn);
    byId("accountEmail").textContent = email;
  }

  async function loadProducts() {
    const { data, error } = await supabase.from("products")
      .select("id,name,price,stock")
      .eq("active", true)
      .order("name");
    if (error) throw error;
    products = data;
    renderProducts();
    byId("productCount").textContent = String(products.length);
  }

  async function loadSales() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const [recentResult, todayResult] = await Promise.all([
      supabase.from("sales")
      .select("id,total,created_at")
      .order("created_at", { ascending: false })
      .limit(12),
      supabase.from("sales")
        .select("total", { count: "exact" })
        .gte("created_at", start.toISOString())
    ]);
    if (recentResult.error) throw recentResult.error;
    if (todayResult.error) throw todayResult.error;
    const data = recentResult.data;
    byId("todayTotal").textContent = formatMoney(todayResult.data.reduce((sum, sale) => sum + Number(sale.total), 0));
    byId("todaySales").textContent = String(todayResult.count);
    byId("salesRows").innerHTML = data.map((sale) => {
      const date = new Date(sale.created_at).toLocaleString("ar-EG", { dateStyle: "short", timeStyle: "short" });
      return `<tr><td>${escapeHtml(sale.id.slice(0, 8).toUpperCase())}</td><td>${escapeHtml(date)}</td><td>${formatMoney(sale.total)}</td></tr>`;
    }).join("");
    byId("salesEmpty").classList.toggle("hidden", data.length > 0);
  }

  async function refreshData() {
    byId("syncText").textContent = "جارٍ التحديث";
    try {
      await Promise.all([loadProducts(), loadSales()]);
      byId("syncText").textContent = `آخر تحديث ${new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })}`;
    } catch (error) {
      byId("syncText").textContent = "تعذّر التحديث";
      setMessage(`تعذّر تحميل البيانات: ${error.message}`, true);
    }
  }

  function renderProducts() {
    const query = byId("searchInput").value.trim().toLocaleLowerCase("ar");
    const filtered = products.filter((product) => product.name.toLocaleLowerCase("ar").includes(query));
    byId("productsList").innerHTML = filtered.map((product) => `
      <article class="product-row">
        <div><div class="product-title">${escapeHtml(product.name)}</div><div class="product-meta">المتاح: ${Number(product.stock)}</div></div>
        <div class="product-price">${formatMoney(product.price)}</div>
        <button class="add-item" type="button" aria-label="إضافة ${escapeHtml(product.name)}" data-add="${escapeHtml(product.id)}" ${Number(product.stock) < 1 ? "disabled" : ""}>+</button>
      </article>`).join("");
    byId("productsEmpty").classList.toggle("hidden", products.length > 0);
    byId("productsList").querySelectorAll("[data-add]").forEach((button) => {
      button.addEventListener("click", () => addToCart(button.dataset.add));
    });
  }

  function addToCart(productId) {
    const product = products.find((item) => item.id === productId);
    if (!product) return;
    const current = cart.get(productId)?.quantity || 0;
    if (current >= Number(product.stock)) {
      setMessage("الكمية المطلوبة أكبر من المخزون المتاح.", true);
      return;
    }
    cart.set(productId, { product, quantity: current + 1 });
    renderCart();
    setMessage("");
  }

  function renderCart() {
    const items = [...cart.values()];
    byId("cartCount").textContent = String(items.reduce((sum, item) => sum + item.quantity, 0));
    byId("cartTotal").textContent = formatMoney(items.reduce((sum, item) => sum + Number(item.product.price) * item.quantity, 0));
    byId("checkoutButton").disabled = items.length === 0;
    byId("cartList").innerHTML = items.length ? items.map(({ product, quantity }) => `
      <div class="cart-row">
        <div class="cart-name">${escapeHtml(product.name)}</div>
        <div class="cart-subtotal">${formatMoney(Number(product.price) * quantity)}</div>
        <div class="quantity-controls">
          <button type="button" aria-label="تقليل" data-change="-1" data-id="${escapeHtml(product.id)}">−</button>
          <span>${quantity}</span>
          <button type="button" aria-label="زيادة" data-change="1" data-id="${escapeHtml(product.id)}">+</button>
          <button type="button" aria-label="حذف" data-remove="${escapeHtml(product.id)}">حذف</button>
        </div>
      </div>`).join("") : '<div class="empty-state">اختر المنتجات لإضافتها للفاتورة.</div>';
    byId("cartList").querySelectorAll("[data-change]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.id;
        const item = cart.get(id);
        const quantity = item.quantity + Number(button.dataset.change);
        if (quantity < 1) cart.delete(id);
        else if (quantity <= Number(item.product.stock)) item.quantity = quantity;
        else setMessage("الكمية المطلوبة أكبر من المخزون المتاح.", true);
        renderCart();
      });
    });
    byId("cartList").querySelectorAll("[data-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        cart.delete(button.dataset.remove);
        renderCart();
      });
    });
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginError.textContent = "";
    byId("loginInfo").classList.add("hidden");
    const button = loginForm.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: byId("emailInput").value.trim(),
        password: byId("passwordInput").value
      });
      if (error) throw error;
      setLoggedIn(true, data.user.email);
      await refreshData();
      clearInterval(refreshTimer);
      refreshTimer = setInterval(refreshData, 15000);
    } catch (error) {
      loginError.textContent = `تعذّر تسجيل الدخول: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });

  byId("forgotPasswordButton").addEventListener("click", () => {
    byId("recoveryEmail").value = byId("emailInput").value.trim();
    loginForm.classList.add("hidden");
    recoveryForm.classList.remove("hidden");
    loginError.textContent = "";
  });

  byId("backToLoginButton").addEventListener("click", () => {
    recoveryForm.classList.add("hidden");
    loginForm.classList.remove("hidden");
    byId("recoveryMessage").textContent = "";
  });

  recoveryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = recoveryForm.querySelector("button[type=submit]");
    button.disabled = true;
    byId("recoveryMessage").classList.remove("error-text");
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(byId("recoveryEmail").value.trim(), {
        redirectTo: `${window.location.origin}${window.location.pathname}`
      });
      if (error) throw error;
      byId("recoveryMessage").textContent = "إذا كان البريد مسجلاً، سيصلك رابط لتغيير كلمة المرور.";
    } catch (error) {
      byId("recoveryMessage").textContent = `تعذّر إرسال الرابط: ${error.message}`;
      byId("recoveryMessage").classList.add("error-text");
    } finally {
      button.disabled = false;
    }
  });

  updatePasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = updatePasswordForm.querySelector("button[type=submit]");
    const message = byId("passwordUpdateMessage");
    if (byId("newPassword").value !== byId("confirmPassword").value) {
      message.textContent = "كلمتا المرور غير متطابقتين.";
      message.classList.add("error-text");
      return;
    }
    button.disabled = true;
    try {
      const { data, error } = await supabase.auth.updateUser({ password: byId("newPassword").value });
      if (error) throw error;
      updatePasswordForm.classList.add("hidden");
      loginForm.classList.remove("hidden");
      byId("loginInfo").textContent = "تم تغيير كلمة المرور. سجّل الدخول الآن.";
      byId("loginInfo").classList.remove("hidden");
      byId("emailInput").value = data.user.email || byId("recoveryEmail").value;
      byId("passwordInput").value = "";
    } catch (error) {
      message.textContent = `تعذّر تغيير كلمة المرور: ${error.message}`;
      message.classList.add("error-text");
    } finally {
      button.disabled = false;
    }
  });

  byId("logoutButton").addEventListener("click", async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      setMessage(`تعذّر تسجيل الخروج: ${error.message}`, true);
      return;
    }
    clearInterval(refreshTimer);
    cart.clear();
    renderCart();
    setLoggedIn(false);
  });

  byId("addProductToggle").addEventListener("click", () => byId("productForm").classList.toggle("hidden"));
  byId("searchInput").addEventListener("input", renderProducts);
  byId("clearCartButton").addEventListener("click", () => { cart.clear(); renderCart(); setMessage(""); });
  byId("refreshButton").addEventListener("click", refreshData);

  byId("productForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const { data: storeId, error: storeError } = await supabase.rpc("current_store_id");
      if (storeError) throw storeError;
      const { error } = await supabase.from("products").insert({
        store_id: storeId,
        name: byId("productName").value.trim(),
        price: Number(byId("productPrice").value),
        stock: Number(byId("productStock").value)
      });
      if (error) throw error;
      event.currentTarget.reset();
      byId("productForm").classList.add("hidden");
      setMessage("تم حفظ المنتج.");
      await refreshData();
    } catch (error) {
      setMessage(`تعذّر حفظ المنتج: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  });

  byId("checkoutButton").addEventListener("click", async () => {
    const button = byId("checkoutButton");
    button.disabled = true;
    try {
      const { data, error } = await supabase.rpc("checkout_sale", {
        p_items: [...cart.values()].map(({ product, quantity }) => ({ product_id: product.id, quantity }))
      });
      if (error) throw error;
      cart.clear();
      renderCart();
      setMessage(`تم إتمام البيع بنجاح. الإجمالي: ${formatMoney(data.total)}`);
      await refreshData();
    } catch (error) {
      setMessage(`تعذّر إتمام البيع: ${error.message}`, true);
      await refreshData();
    } finally {
      button.disabled = cart.size === 0;
    }
  });

  if (!config || !config.supabaseUrl || config.supabaseUrl.startsWith("YOUR_") ||
      !config.supabaseAnonKey || config.supabaseAnonKey.startsWith("YOUR_")) {
    loginError.textContent = "أكمل إعداد رابط Supabase والمفتاح في config.js أولاً.";
    loginForm.querySelector("button[type=submit]").disabled = true;
    return;
  }

  supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  supabase.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") {
      loginForm.classList.add("hidden");
      recoveryForm.classList.add("hidden");
      updatePasswordForm.classList.remove("hidden");
    }
  });
  supabase.auth.getSession().then(({ data, error }) => {
    if (error) {
      loginError.textContent = `تعذّر التحقق من الجلسة: ${error.message}`;
      return;
    }
    if (data.session) {
      setLoggedIn(true, data.session.user.email);
      refreshData();
      refreshTimer = setInterval(refreshData, 15000);
    }
  });
})();
