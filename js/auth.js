/* ---------- Login GitHub & Profil (sesi nyata di server, bukan localStorage) ----------
 * Alur (authorization code flow standar OAuth2):
 *   1. Klik "Login dengan GitHub" -> taruh nonce acak di cookie sekali-pakai,
 *      lalu browser di-redirect PENUH (bukan fetch) ke github.com/login/oauth/authorize.
 *   2. Pengguna approve di GitHub -> GitHub redirect balik ke
 *      /api/auth?action=github_callback membawa code+state.
 *   3. Server (BUKAN frontend ini) menukar code -> access_token pakai
 *      client_secret yang cuma ada di server, ambil profil GitHub, buat
 *      sesi + cookie httpOnly, lalu redirect balik ke halaman ini.
 *   4. Frontend tinggal GET /api/auth untuk tahu status login terkini —
 *      tidak pernah membuat/menyimpan status "login" sendiri.
 */
let authAvailable = false;
let githubClientId = null;
let currentAccount = null; // profil publik dari server, atau null kalau belum login

async function authFetch(payload){
  const resp = await fetch('/api/auth', {
    method: payload ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: payload ? {'Content-Type':'application/json'} : undefined,
    body: payload ? JSON.stringify(payload) : undefined
  });
  let j = null;
  try{ j = await resp.json(); }catch(e){}
  return { ok: resp.ok, status: resp.status, data: j };
}

function consumeLoginRedirectFlag(){
  const params = new URLSearchParams(location.search);
  if(!params.has('login')) return;
  const status = params.get('login');
  if(status === 'unavailable'){
    alert('Fitur login belum dikonfigurasi di server.');
  } else if(status && status !== 'success'){
    alert('Login GitHub gagal. Kode alasan: ' + status + '\n\n(Screenshot pesan ini kalau perlu bantuan lebih lanjut.)');
  }
  params.delete('login');
  const qs = params.toString();
  history.replaceState({}, '', location.pathname + (qs? '?'+qs : '') + location.hash);
}

async function initAuthState(){
  consumeLoginRedirectFlag();
  const { ok, data } = await authFetch(null);
  if(!ok || !data) return;
  authAvailable = !!data.authAvailable;
  githubClientId = data.githubClientId || null;
  currentAccount = data.loggedIn ? data.profile : null;
  updateAccountButton();
}

function updateAccountButton(){
  const label = $('#account-btn-label');
  if(!label) return;
  label.textContent = currentAccount ? (currentAccount.name || currentAccount.providerName || 'Akun') : 'Login';
}

function startGithubLogin(){
  if(!githubClientId) return;
  const state = (crypto.randomUUID ? crypto.randomUUID() : (Date.now()+'-'+Math.random().toString(36).slice(2))).replace(/-/g,'');
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `naze_oauth_state=${state}; Path=/; Max-Age=600; SameSite=Lax${secure}`;
  const redirectUri = `${location.origin}/api/auth?action=github_callback`;
  const authorizeUrl = 'https://github.com/login/oauth/authorize'
    + '?client_id=' + encodeURIComponent(githubClientId)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&scope=' + encodeURIComponent('read:user user:email')
    + '&state=' + encodeURIComponent(state);
  window.location.href = authorizeUrl; // full-page redirect, bukan fetch/XHR
}

function renderAccountView(){
  const elUnavailable = $('#account-unavailable');
  const elOut = $('#account-logged-out');
  const elIn = $('#account-logged-in');
  if(!elUnavailable || !elOut || !elIn) return;
  [elUnavailable, elOut, elIn].forEach(el=> el.style.display='none');

  if(!authAvailable){
    elUnavailable.style.display = '';
    return;
  }
  if(!currentAccount){
    elOut.style.display = '';
    return;
  }
  elIn.style.display = '';
  $('#account-avatar').src = currentAccount.picture || '';
  $('#account-provider-login').textContent = currentAccount.providerLogin ? ('@'+currentAccount.providerLogin) : '';
  $('#account-provider-email').textContent = currentAccount.email || '';
  $('#account-name-input').value = currentAccount.name || currentAccount.providerName || '';
  $('#account-name-hint').style.display = currentAccount.needsName ? '' : 'none';
}

document.addEventListener('DOMContentLoaded', ()=>{
  initAuthState();

  const accBtn = $('#account-btn');
  if(accBtn) accBtn.addEventListener('click', ()=>{
    $('#settings-overlay').classList.add('show');
    settingsStack = ['root','account'];
    showSettingsView('account');
    closeSidebarMobile();
  });

  const githubBtn = $('#github-login-btn');
  if(githubBtn) githubBtn.addEventListener('click', startGithubLogin);

  const saveBtn = $('#account-save-btn');
  if(saveBtn) saveBtn.addEventListener('click', async ()=>{
    const input = $('#account-name-input');
    const name = (input && input.value || '').trim();
    if(!name) return;
    saveBtn.disabled = true;
    const { ok, data } = await authFetch({ action:'update_profile', name });
    saveBtn.disabled = false;
    if(ok && data && data.profile){
      currentAccount = data.profile;
      updateAccountButton();
      renderAccountView();
    } else {
      alert((data && data.error) || 'Gagal menyimpan nama.');
    }
  });

  const logoutBtn = $('#account-logout-btn');
  if(logoutBtn) logoutBtn.addEventListener('click', async ()=>{
    if(!confirm('Logout dari akun GitHub ini?')) return;
    await authFetch({ action:'logout' });
    currentAccount = null;
    updateAccountButton();
    renderAccountView();
  });
});
