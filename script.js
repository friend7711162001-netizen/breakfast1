/**
 * 早餐點餐工具 - 原生 API 版 (OAuth 2.0)
 * 完全移除 GAS，改用 Google Sheets API v4。
 */

// --- 憑證設定 (由 config.js 提供) ---
let API_KEY, CLIENT_ID, SPREADSHEET_ID;

try {
    if (typeof CONFIG === 'undefined') {
        throw new Error('找不到 CONFIG 設定。請確認 config.js 是否正確載入並上傳至伺服器。');
    }
    API_KEY = CONFIG.API_KEY;
    CLIENT_ID = CONFIG.CLIENT_ID;
    SPREADSHEET_ID = CONFIG.SPREADSHEET_ID;
} catch (e) {
    console.error('Initialization error:', e);
    // 注意：此時 DOM 可能還沒載入完畢，預留一個標記
    window.configError = e.message;
}

const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email';
const DISCOVERY_DOC = 'https://sheets.googleapis.com/$discovery/rest?version=v4';

// --- 狀態管理 ---
let state = {
    shops: [],
    menu: [],
    records: [],
    admins: [], // 新增：管理員清單
    user: null, // 新增：當前使用者資訊
    currentShop: null,
    order: [],
    tokenClient: null,
    gapiInited: false,
    gisInited: false,
    currentItemWithOptions: null // 暫存正在選擇選項的品項
};

// --- 初始化流程 ---

function gapiLoaded() {
    gapi.load('client', initializeGapiClient);
}

async function initializeGapiClient() {
    try {
        console.log('Initializing GAPI client...');
        await gapi.client.init({
            apiKey: API_KEY,
            discoveryDocs: [DISCOVERY_DOC],
        });
        state.gapiInited = true;
        console.log('GAPI client inited.');
        maybeStartApp();
    } catch (e) {
        console.error('GAPI init error:', e);
        const errorDetail = e.details || e.message || (e.result && e.result.error ? e.result.error.message : JSON.stringify(e));
        showFatalError(`Google API (GAPI) 初始化失敗：${errorDetail}`);
    }
}

function gisLoaded() {
    try {
        console.log('Initializing GIS client...');
        if (!google || !google.accounts || !google.accounts.oauth2) {
            throw new Error('找不到 Google Identity Services 腳本，可能被廣告攔截器阻擋。');
        }
        state.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES,
            callback: '',
        });
        state.gisInited = true;
        console.log('GIS client inited.');
        maybeStartApp();
    } catch (e) {
        console.error('GIS init error:', e);
        showFatalError(`Google 登入元件 (GIS) 載入失敗：${e.message}`);
    }
}

// 初始化監聽狗：如果 10 秒後還沒完成初始化，給予提示
setTimeout(() => {
    if (!state.gapiInited || !state.gisInited) {
        if (!window.configError) {
            console.warn('Initialization timeout.');
            const missing = [];
            if (!state.gapiInited) missing.push('基礎 API (GAPI)');
            if (!state.gisInited) missing.push('登入元件 (GIS)');
            showFatalError(`系統初始化超時，尚未載入：${missing.join('、')}。請檢查網路連接或關閉廣告攔截器 (AdBlock)。`);
        }
    }
}, 10000);

function maybeStartApp() {
    if (state.gapiInited && state.gisInited) {
        initApp();
    }
}

function initApp() {
    initDateTime();
    initEventListeners();

    // 檢查是否有設定檔錯誤
    if (window.configError) {
        showFatalError(window.configError);
        return;
    }

    // 更新登入按鈕狀態為可用
    const loginBtn = document.getElementById('login-btn-lg');
    if (loginBtn) {
        loginBtn.disabled = false;
        loginBtn.innerHTML = '🔐 以 Google 帳號登入';
    }

    // 如果已經有 token，嘗試獲取使用者資訊並進入
    const savedToken = localStorage.getItem('google_access_token');
    if (savedToken) {
        gapi.client.setToken({ access_token: savedToken });
        fetchUserInfo();
    } else {
        showLoginOverlay(true);
    }
}

// --- 介面控制 ---

function showLoginOverlay(show) {
    const overlay = document.getElementById('login-overlay');
    if (show) {
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
        
        // 如果 API 還沒準備好，禁用按鈕並提示
        const loginBtn = document.getElementById('login-btn-lg');
        if (loginBtn && (!state.gapiInited || !state.gisInited) && !window.configError) {
            loginBtn.disabled = true;
            loginBtn.innerHTML = '⌛ 正在初始化系統...';
        }
    } else {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.style.display = 'none', 500);
    }
}

function showFatalError(msg) {
    const errorMsgEl = document.getElementById('auth-error-msg');
    const loginBtn = document.getElementById('login-btn-lg');
    
    if (errorMsgEl) {
        errorMsgEl.textContent = `⚠️ 系統錯誤：${msg}`;
        errorMsgEl.classList.remove('hidden');
    }
    if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.innerHTML = '❌ 系統無法啟動';
    }
}

function updateRoleUI(role) {
    const roleBadge = document.getElementById('user-role');
    const adminBtns = document.querySelectorAll('.btn-admin');

    if (role === '管理員') {
        roleBadge.textContent = '👑 管理員';
        roleBadge.className = 'badge admin';
        adminBtns.forEach(b => b.classList.remove('hidden'));
    } else {
        roleBadge.textContent = '👤 人員';
        roleBadge.className = 'badge';
        adminBtns.forEach(b => b.classList.add('hidden'));
    }
}

// --- 授權邏輯 ---

async function fetchUserInfo() {
    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { 'Authorization': `Bearer ${gapi.client.getToken().access_token}` }
        });
        state.user = await response.json();
        updateAuthUI(true);
        fetchData();
    } catch (e) {
        showLoginOverlay(true);
    }
}

function getToken(callback) {
    console.log('getToken called');
    const loginBtn = document.getElementById('login-btn-lg');
    const originalText = loginBtn ? loginBtn.innerHTML : '🔐 以 Google 帳號登入';
    
    if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.innerHTML = '⌛ 正在開啟驗證視窗...';
    }

    try {
        if (!state.tokenClient) {
            throw new Error('Google 登入元件尚未就緒，請稍後再試。');
        }

        state.tokenClient.callback = async (resp) => {
            console.log('GIS callback received', resp);
            if (resp.error !== undefined) {
                if (loginBtn) {
                    loginBtn.disabled = false;
                    loginBtn.innerHTML = originalText;
                }
                alert(`登入發生錯誤: ${resp.error}\n${resp.error_description || ''}`);
                throw (resp);
            }
            localStorage.setItem('google_access_token', resp.access_token);
            localStorage.setItem('google_token_expiry', Date.now() + (resp.expires_in * 1000));
            fetchUserInfo();
            if (callback) callback();
        };

        console.log('Requesting access token...');
        if (gapi.client.getToken() === null) {
            state.tokenClient.requestAccessToken({ prompt: 'consent' });
        } else {
            state.tokenClient.requestAccessToken({ prompt: '' });
        }

        // 超時恢復機制：如果 10 秒後沒反應，恢復按鈕（可能彈窗被攔截了）
        setTimeout(() => {
            if (loginBtn && loginBtn.disabled && loginBtn.innerHTML.includes('正在開啟')) {
                loginBtn.disabled = false;
                loginBtn.innerHTML = originalText;
                console.warn('Login request timed out. Popup might be blocked.');
            }
        }, 10000);

    } catch (err) {
        console.error('getToken error:', err);
        alert(`無法啟動 Google 登入: ${err.message}`);
        if (loginBtn) {
            loginBtn.disabled = false;
            loginBtn.innerHTML = originalText;
        }
    }
}

function revokeToken() {
    const token = gapi.client.getToken();
    if (token !== null) {
        google.accounts.oauth2.revoke(token.access_token);
        gapi.client.setToken('');
        localStorage.removeItem('google_access_token');
        localStorage.removeItem('google_token_expiry');
        updateAuthUI(false);
        showLoginOverlay(true);
        showToast('🔓 已登出 Google 授權');
    }
}

function updateAuthUI(isLoggedIn) {
    const authBtn = document.getElementById('auth-btn');
    const userName = document.getElementById('user-name');
    if (isLoggedIn) {
        authBtn.textContent = '🔓 登出';
        authBtn.onclick = revokeToken;
        userName.textContent = state.user.email;
    } else {
        authBtn.textContent = '🔐 登入';
        authBtn.onclick = () => getToken();
        userName.textContent = '未登入';
    }
}

// --- 資料讀取邏輯 ---

async function fetchData() {
    try {
        const response = await gapi.client.sheets.spreadsheets.values.batchGet({
            spreadsheetId: SPREADSHEET_ID,
            ranges: ['早餐店!A1:A100', '價格!A2:E500', '紀錄!A:D', '管理員!A2:C50'],
        });
        const valueRanges = response.result.valueRanges;

        // 1. 處理管理員清單並驗證權限
        state.admins = (valueRanges[3].values || []).map(row => ({
            name: row[0],
            email: row[1],
            role: row[2]
        }));

        const currentUser = state.admins.find(a => a.email.toLowerCase() === state.user.email.toLowerCase());
        if (!currentUser) {
            document.getElementById('auth-error-msg').classList.remove('hidden');
            showLoginOverlay(true);
            return;
        }

        showLoginOverlay(false);
        updateRoleUI(currentUser.role);

        // 2. 處理其它資料
        state.shops = (valueRanges[0].values || []).flat().filter(s => s !== "");
        state.menu = (valueRanges[1].values || []).map(row => {
            const item = row[1] || "";
            // 嚴格限制：僅限「紅茶、豆漿、奶茶、咖啡、拿鐵」才開啟選項
            const isDrink = ["紅茶", "豆漿", "奶茶", "咖啡", "拿鐵"].some(key => item.includes(key));
            return {
                shop: row[0],
                item: item,
                price: parseInt(row[2]) || 0,
                hasTemp: isDrink,
                hasSugar: isDrink
            };
        });
        const recordRows = valueRanges[2].values || [];
        state.records = recordRows.slice(1).reverse().slice(0, 5).map(row => ({
            pickupDate: row[0],
            pickupTime: row[1],
            items: row[2],
            total: row[3]
        }));

        renderShops();
        renderRecords();
    } catch (err) {
        console.error('Fetch error:', err);
        showToast('❌ 讀取失敗，請確認授權權限');
    }
}

// --- 渲染與點餐邏輯 ---

function initDateTime() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 使用在地時間格式避免 UTC 時差造成日期偏移
    const y = tomorrow.getFullYear();
    const m = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const d = String(tomorrow.getDate()).padStart(2, '0');
    document.getElementById('pickup-date').value = `${y}-${m}-${d}`;
    const timeSelect = document.getElementById('pickup-time');
    timeSelect.innerHTML = '';
    for (let h = 6; h <= 11; h++) {
        ['00', '15', '30', '45'].forEach(m => {
            const time = `${h.toString().padStart(2, '0')}:${m}`;
            const opt = document.createElement('option');
            opt.value = time; opt.textContent = time;
            if (time === "06:45") opt.selected = true;
            timeSelect.appendChild(opt);
        });
    }
}

function initEventListeners() {
    document.getElementById('login-btn-lg').addEventListener('click', () => getToken());
    document.getElementById('auth-btn').addEventListener('click', revokeToken);
    document.getElementById('submit-order').addEventListener('click', submitOrder);
    document.getElementById('clear-order').addEventListener('click', clearOrder);
    document.getElementById('cancel-options').addEventListener('click', closeOptionsModal);
    document.getElementById('confirm-options').addEventListener('click', confirmOptions);

    // 管理員按鈕
    document.getElementById('admin-add-shop').addEventListener('click', openAddShopModal);
    document.getElementById('cancel-add-shop').addEventListener('click', () => document.getElementById('add-shop-modal').classList.add('hidden'));
    document.getElementById('confirm-add-shop').addEventListener('click', confirmAddShop);

    document.getElementById('admin-add-meal').addEventListener('click', openAddMealModal);
    document.getElementById('cancel-add-meal').addEventListener('click', () => document.getElementById('add-meal-modal').classList.add('hidden'));
    document.getElementById('confirm-add-meal').addEventListener('click', confirmAddMeal);

    // 數量彈窗控制
    document.getElementById('modal-qty-minus').onclick = () => updateModalQty(-1);
    document.getElementById('modal-qty-plus').onclick = () => updateModalQty(1);
    document.querySelectorAll('.chip-qty').forEach(chip => {
        chip.onclick = () => {
            document.querySelectorAll('.chip-qty').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            document.getElementById('modal-qty-input').value = chip.dataset.val;
        };
    });

    // 選項 Chip 點擊
    document.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const siblings = chip.parentElement.querySelectorAll('.chip');
            siblings.forEach(s => s.classList.remove('active'));
            chip.classList.add('active');
        });
    });
}

function renderShops() {
    const shopList = document.getElementById('shop-list');
    shopList.innerHTML = '';
    state.shops.forEach(shop => {
        const btn = document.createElement('button');
        btn.className = `btn-shop ${state.currentShop === shop ? 'active' : ''}`;
        btn.textContent = shop;
        btn.onclick = () => selectShop(shop);
        shopList.appendChild(btn);
    });
}

function selectShop(shopName) {
    state.currentShop = shopName;
    document.getElementById('current-shop-name').textContent = `🔍 ${shopName}`;
    renderShops();
    renderMenu(shopName);
}

function renderMenu(shopName) {
    const menuList = document.getElementById('menu-list');
    menuList.innerHTML = '';
    const items = state.menu.filter(m => m.shop === shopName);
    items.forEach(product => {
        const div = document.createElement('div');
        div.className = 'menu-item';
        div.innerHTML = `
            <div class="item-info">
                <span class="item-name">${product.item}</span>
                <span class="item-price">$${product.price}</span>
            </div>
            <div class="add-icon">➕</div>
        `;
        div.onclick = () => handleAddToOrder(product);
        menuList.appendChild(div);
    });
}

// 點擊加入點餐 (統一開彈窗)
function handleAddToOrder(product) {
    openOptionsModal(product);
}

function openOptionsModal(product) {
    state.currentItemWithOptions = product;
    document.getElementById('modal-item-name').textContent = product.item;

    // 初始化數量
    document.getElementById('modal-qty-input').value = 1;
    document.querySelectorAll('.chip-qty').forEach(c => c.classList.remove('active'));

    // 重設選項顯示
    document.getElementById('temp-options-group').style.display = product.hasTemp ? 'block' : 'none';
    document.getElementById('sugar-options-group').style.display = product.hasSugar ? 'block' : 'none';

    // 重設選中狀態
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    document.getElementById('options-modal').classList.remove('hidden');
}

function updateModalQty(delta) {
    const input = document.getElementById('modal-qty-input');
    let val = parseInt(input.value) || 1;
    val = Math.max(1, val + delta);
    input.value = val;
    document.querySelectorAll('.chip-qty').forEach(c => c.classList.remove('active'));
}

function closeOptionsModal() {
    document.getElementById('options-modal').classList.add('hidden');
    state.currentItemWithOptions = null;
}

function confirmOptions() {
    const qty = parseInt(document.getElementById('modal-qty-input').value) || 1;
    const activeChips = document.querySelectorAll('.chip.active');
    const options = { qty };
    activeChips.forEach(chip => {
        const type = chip.parentElement.id.includes('temp') ? 'temp' : 'sugar';
        options[type] = chip.dataset.val;
    });

    confirmAddToOrder(state.currentItemWithOptions, options);
    closeOptionsModal();
}

function confirmAddToOrder(product, options) {
    const qty = options.qty || 1;
    // 檢查是否已有相同品項且相同選項
    const existing = state.order.find(o =>
        o.shop === product.shop &&
        o.item === product.item &&
        o.temp === (options.temp || '') &&
        o.sugar === (options.sugar || '')
    );

    if (existing) {
        existing.qty += qty;
    } else {
        state.order.push({
            ...product,
            qty: qty,
            temp: options.temp || '',
            sugar: options.sugar || ''
        });
    }
    showToast(`已加入：${product.item} x${qty}`);
    renderOrder();
}

function updateQty(index, delta) {
    state.order[index].qty += delta;
    if (state.order[index].qty <= 0) state.order.splice(index, 1);
    renderOrder();
}

function setQty(index, value) {
    state.order[index].qty = value;
    renderOrder();
}

function clearOrder() {
    if (state.order.length === 0) return;
    if (confirm('確定要清空目前的點餐清單嗎？')) {
        state.order = [];
        renderOrder();
    }
}

function renderOrder() {
    const orderListEl = document.getElementById('order-list');
    const totalAmountEl = document.getElementById('total-amount');
    const submitBtn = document.getElementById('submit-order');

    if (state.order.length === 0) {
        orderListEl.innerHTML = '<p class="empty-msg">目前還沒有點餐喔～快去選購吧！</p>';
        totalAmountEl.textContent = '$0';
        submitBtn.disabled = true;
        return;
    }

    orderListEl.innerHTML = '';
    let totalOverall = 0;
    const groups = {};
    state.order.forEach((item, originalIndex) => {
        if (!groups[item.shop]) groups[item.shop] = [];
        groups[item.shop].push({ ...item, originalIndex });
    });

    Object.keys(groups).forEach(shopName => {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'shop-order-group';
        let itemsHtml = groups[shopName].map(o => {
            totalOverall += o.price * o.qty;
            const optionsLabel = (o.temp || o.sugar) ? `<div class="item-options-label">${[o.temp, o.sugar].filter(v => v).join(', ')}</div>` : '';
            return `
                <div class="order-row">
                    <div class="order-item-detail">
                        <div class="item-name">${o.item}</div>
                        ${optionsLabel}
                        <div class="item-price">$${o.price}</div>
                    </div>
                    <div class="controls">
                        <button class="qty-btn minus" onclick="updateQty(${o.originalIndex}, -1)">-</button>
                        <span class="qty-val">${o.qty}</span>
                        <button class="qty-btn" onclick="updateQty(${o.originalIndex}, 1)">+</button>
                    </div>
                </div>
            `;
        }).join('');

        groupDiv.innerHTML = `
            <div class="shop-group-header">
                <span class="shop-group-title">🏪 ${shopName}</span>
                <button class="btn-copy-shop" onclick="copyOrderText('${shopName}')">📋 複製</button>
            </div>
            <div class="shop-items-grid">
                ${itemsHtml}
            </div>
        `;
        orderListEl.appendChild(groupDiv);
    });

    totalAmountEl.textContent = `$${totalOverall}`;
    submitBtn.disabled = false;
}

function copyOrderText(shopName) {
    const shopItems = state.order.filter(o => o.shop === shopName);
    const date = document.getElementById('pickup-date').value;
    const time = document.getElementById('pickup-time').value;
    const itemsText = shopItems.map((o, index) => {
        const opts = [o.temp, o.sugar].filter(v => v).join(', ');
        const itemLine = `${o.item}${opts ? '(' + opts + ')' : ''} x${o.qty}`;
        return index === 0 ? itemLine : `          ${itemLine}`;
    }).join('\n');
    const shopTotal = shopItems.reduce((acc, o) => acc + (o.price * o.qty), 0);
    const text = `【訂餐資訊】\n日期：${date}\n時間：${time}\n內容：${itemsText}\n總額：$${shopTotal}\n\n再麻煩您了，謝謝`;
    navigator.clipboard.writeText(text).then(() => showToast(`✅ 已複製 ${shopName} 的內容`));
}

function renderRecords() {
    const recordList = document.getElementById('records-list');
    recordList.innerHTML = '';
    if (state.records.length === 0) {
        recordList.innerHTML = '<p class="empty-msg">尚無紀錄</p>';
        return;
    }
    state.records.forEach(r => {
        const div = document.createElement('div');
        div.className = 'record-item';
        div.innerHTML = `
            <div class="record-header">
                <span class="record-pickup-meta">🗓️ ${r.pickupDate} ⏰ ${r.pickupTime}</span>
                <span class="record-total-header">總計: $${r.total}</span>
            </div>
            <div class="record-content">${r.items}</div>
        `;
        recordList.appendChild(div);
    });
}

async function submitOrder() {
    const token = gapi.client.getToken();
    if (token === null || Date.now() > localStorage.getItem('google_token_expiry')) {
        showToast('🔑 授權已過期，請重新登入 Google');
        getToken(submitOrder);
        return;
    }
    const submitBtn = document.getElementById('submit-order');
    submitBtn.disabled = true;
    submitBtn.textContent = '送出中...';
    const pickupDate = document.getElementById('pickup-date').value;
    const pickupTime = document.getElementById('pickup-time').value;
    const items = state.order.map(o => {
        const opts = [o.temp, o.sugar].filter(v => v).join(', ');
        return `${o.shop}-${o.item}${opts ? '(' + opts + ')' : ''} x${o.qty}`;
    }).join(', ');
    const total = state.order.reduce((acc, o) => acc + (o.price * o.qty), 0);
    try {
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: '紀錄!A:D',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[pickupDate, pickupTime, items, total]] },
        });
        showToast('✅ 點餐成功！');
        state.order = []; renderOrder(); fetchData();
    } catch (err) {
        console.error('Submit error:', err);
        showToast('❌ 送出失敗，請確認網路或授權');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '確認送出';
    }
}

// --- 管理員功能實作 ---

function openAddShopModal() {
    document.getElementById('new-shop-name').value = '';
    document.getElementById('add-shop-modal').classList.remove('hidden');
}

async function confirmAddShop() {
    const shopName = document.getElementById('new-shop-name').value.trim();
    if (!shopName) return showToast('⚠️ 請輸入店名');

    try {
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: '早餐店!A:A',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[shopName]] },
        });
        showToast(`✅ 已新增：${shopName}`);
        document.getElementById('add-shop-modal').classList.add('hidden');
        fetchData();
    } catch (err) {
        showToast('❌ 新增失敗，請確認權限');
    }
}

function openAddMealModal() {
    if (!state.currentShop) return showToast('⚠️ 請先選擇一家店');
    document.getElementById('meal-modal-shop-name').textContent = `目標店家：${state.currentShop}`;
    document.getElementById('new-meal-name').value = '';
    document.getElementById('new-meal-price').value = '';
    document.getElementById('add-meal-modal').classList.remove('hidden');
}

async function confirmAddMeal() {
    const name = document.getElementById('new-meal-name').value.trim();
    const price = document.getElementById('new-meal-price').value.trim();
    if (!name || !price) return showToast('⚠️ 請填寫名稱與價格');

    // 自動判斷是否給予溫度/甜度選項
    const isDrink = ["紅茶", "豆漿", "奶茶", "咖啡", "拿鐵"].some(key => name.includes(key));
    const hasTemp = isDrink ? "v" : "";
    const hasSugar = isDrink ? "v" : "";

    try {
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: '價格!A:E',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[state.currentShop, name, price, hasTemp, hasSugar]] },
        });
        showToast(`✅ 已新增：${name}`);
        document.getElementById('add-meal-modal').classList.add('hidden');
        fetchData();
    } catch (err) {
        showToast('❌ 新增失敗，請確認權限');
    }
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    toast.style.opacity = '1';
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.classList.add('hidden'), 300);
    }, 2500);
}
