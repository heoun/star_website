// Provider transport only. Route handlers select the realm and grant business access.
// No client-supplied project, tenant, issuer, or API endpoint is accepted.
import {createRemoteJWKSet, jwtVerify} from 'jose';

const GOOGLE_KEYS = new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
// Only public verification keys are cached; never sessions or user data.
const googleKeys = createRemoteJWKSet(GOOGLE_KEYS, {timeoutDuration:10000, cacheMaxAge:300000});
const invalidSession = () => Object.assign(new Error('Please sign in again.'), {status:401, code:'invalid_session'});
const unavailable = () => Object.assign(new Error('Sign-in is temporarily unavailable.'), {status:503, code:'auth_unavailable'});

export function gipConfig(env, scope) {
  if (!['applicant','workspace'].includes(scope)) throw unavailable();
  const projectId = env.GIP_PROJECT_ID;
  const apiKey = env.GIP_API_KEY;
  const applicant = env.GIP_APPLICANT_TENANT_ID;
  const workspace = env.GIP_WORKSPACE_TENANT_ID;
  const validTenant = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (env.ACCOUNT_SECURITY !== 'on' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId || '') ||
      typeof apiKey !== 'string' || !apiKey.trim() || !validTenant(applicant) || !validTenant(workspace) || applicant === workspace) throw unavailable();
  return {projectId, apiKey, tenantId:scope === 'applicant' ? applicant : workspace, scope,
    issuer:`https://securetoken.google.com/${projectId}`};
}

async function readJson(response) {
  // Auth responses are small. Bound the body even when a gateway returns bad data.
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  let size = 0, text = '';
  const decoder = new TextDecoder();
  for (;;) {
    const {done,value} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 131072) {await reader.cancel(); throw unavailable();}
    text += decoder.decode(value, {stream:true});
  }
  try {return JSON.parse(text + decoder.decode());} catch {throw unavailable();}
}

function providerError(response, data) {
  // Never echo Google's raw body, which can contain identifiers or credentials.
  const code = String(data?.error?.message || '').split(' : ')[0];
  if (response.status === 429 || ['TOO_MANY_ATTEMPTS_TRY_LATER','QUOTA_EXCEEDED'].includes(code)) {
    return Object.assign(new Error('Too many attempts. Please wait and try again.'), {status:429,code:'rate_limited'});
  }
  if (['INVALID_LOGIN_CREDENTIALS','INVALID_PASSWORD','EMAIL_NOT_FOUND'].includes(code)) {
    return Object.assign(new Error('Email or password is incorrect.'), {status:401,code:'invalid_credentials'});
  }
  if (code === 'EMAIL_EXISTS') return Object.assign(new Error('This email already has an account here. Sign in or reset your password.'), {status:409,code:'already_registered'});
  if (code === 'WEAK_PASSWORD' || code === 'PASSWORD_DOES_NOT_MEET_REQUIREMENTS') return Object.assign(new Error('Choose a stronger password that meets the security requirements.'), {status:422,code:'weak_password'});
  if (['INVALID_ID_TOKEN','TOKEN_EXPIRED','USER_DISABLED','USER_NOT_FOUND','INVALID_REFRESH_TOKEN','TENANT_ID_MISMATCH','INVALID_TENANT_ID'].includes(code)) return invalidSession();
  if (['INVALID_OOB_CODE','EXPIRED_OOB_CODE'].includes(code)) return Object.assign(new Error('This link is invalid or expired. Request a new one.'), {status:400,code:'invalid_link'});
  if (['INVALID_CODE','INVALID_MFA_PENDING_CREDENTIAL','MFA_ENROLLMENT_NOT_FOUND'].includes(code)) return Object.assign(new Error('The verification code is invalid or expired.'), {status:401,code:'invalid_mfa'});
  return unavailable();
}

export async function verifyGipToken(token, config, keyResolver = googleKeys) {
  if (typeof token !== 'string' || token.length > 16384) throw invalidSession();
  let payload;
  try {
    ({payload} = await jwtVerify(token, keyResolver, {algorithms:['RS256'], issuer:config.issuer,
      audience:config.projectId, requiredClaims:['exp','iat','sub','auth_time','firebase'], clockTolerance:0}));
  } catch (error) {
    if (error.code === 'ERR_JWKS_TIMEOUT' || error.code === 'ERR_JOSE_GENERIC' || error instanceof TypeError) throw unavailable();
    throw invalidSession();
  }
  const now = Math.floor(Date.now()/1000);
  if (typeof payload.sub !== 'string' || !payload.sub.length || payload.sub.length > 128 ||
      !Number.isInteger(payload.iat) || payload.iat > now ||
      !Number.isInteger(payload.auth_time) || payload.auth_time < 0 || payload.auth_time > payload.iat ||
      payload.firebase?.tenant !== config.tenantId || payload.firebase?.sign_in_provider === 'anonymous' ||
      typeof payload.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) throw invalidSession();
  return payload;
}

export function createGipClient(env, scope, {fetcher = fetch, keyResolver = googleKeys} = {}) {
  const config = gipConfig(env, scope);
  async function post(path, body, refresh = false) {
    const url = refresh ? new URL('https://securetoken.googleapis.com/v1/token') : new URL(`https://identitytoolkit.googleapis.com/${path}`);
    url.searchParams.set('key', config.apiKey);
    let response;
    try {
      response = await fetcher(url, {method:'POST', redirect:'error', signal:AbortSignal.timeout(15000),
        headers:{'Content-Type':refresh ? 'application/x-www-form-urlencoded' : 'application/json'},
        body:refresh ? new URLSearchParams(body).toString() : JSON.stringify(body)});
    } catch {throw unavailable();}
    const data = await readJson(response);
    if (!response.ok) throw providerError(response, data);
    return data;
  }
  // End-user lookup takes only idToken. The signed tenant claim is checked first.
  async function lookup(idToken, {requireVerified = true} = {}) {
    const claims = await verifyGipToken(idToken, config, keyResolver);
    const data = await post('v1/accounts:lookup', {idToken});
    const user = data.users?.length === 1 ? data.users[0] : null;
    const validSince = Number(user?.validSince ?? 0);
    if (!user || user.disabled || user.localId !== claims.sub || user.tenantId !== config.tenantId ||
        user.email?.toLowerCase() !== claims.email.toLowerCase() || !Number.isFinite(validSince) || validSince < 0 ||
        claims.auth_time < validSince || claims.iat < validSince) throw invalidSession();
    if (requireVerified && (claims.email_verified !== true || user.emailVerified !== true)) {
      throw Object.assign(new Error('Confirm your email before signing in.'), {status:403,code:'email_unverified'});
    }
    return {claims, user};
  }
  async function session(data, options) {
    if (typeof data.idToken !== 'string' || typeof data.refreshToken !== 'string' || !data.refreshToken) throw invalidSession();
    return {...await lookup(data.idToken, options), idToken:data.idToken, refreshToken:data.refreshToken};
  }
  async function checkEmailAction(oobCode) {
    if (typeof oobCode !== 'string' || !oobCode || oobCode.length > 2048) throw invalidSession();
    const data = await post('v1/accounts:resetPassword', {oobCode,tenantId:config.tenantId});
    if (!['PASSWORD_RESET','VERIFY_EMAIL'].includes(data.requestType) || typeof data.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw invalidSession();
    return {email:data.email.toLowerCase(),requestType:data.requestType};
  }
  function requireRecentEnrollment(claims,user) {
    const recent = Math.floor(Date.now()/1000)-claims.auth_time < 300;
    if (!recent || ((user.mfaInfo || []).length && claims.firebase?.sign_in_second_factor !== 'totp')) {
      throw Object.assign(new Error('Sign in again and verify your existing authenticator first.'), {status:403,code:'reauth_required'});
    }
  }
  return {
    config, lookup,
    async signUp(email, password) {
      // Workspace provisioning is invitation-only and needs the admin adapter.
      if (scope !== 'applicant') throw Object.assign(new Error('Use your workspace invitation.'), {status:403});
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') || typeof password !== 'string' || password.length < 8 || password.length > 200) {
        throw Object.assign(new Error('Enter a valid email and a password of at least 8 characters.'), {status:422});
      }
      const data = await post('v1/accounts:signUp', {email,password,tenantId:config.tenantId});
      // Used only to request verification; never establishes a business session.
      return session(data, {requireVerified:false});
    },
    async signIn(email, password) {
      const data = await post('v1/accounts:signInWithPassword', {email,password,returnSecureToken:true,tenantId:config.tenantId});
      if (data.mfaPendingCredential) {
        // This is not an authenticated session. The caller must keep the pending
        // credential out of its normal session cookie and complete MFA first.
        return {mfaPendingCredential:data.mfaPendingCredential,
          factors:(data.mfaInfo || []).filter(f=>f.totpInfo).map(f=>({id:f.mfaEnrollmentId,name:f.displayName || 'Authenticator'}))};
      }
      return session(data);
    },
    async finishMfa(pendingCredential, factorId, code) {
      if (typeof pendingCredential !== 'string' || !pendingCredential || typeof factorId !== 'string' || !factorId || !/^\d{6}$/.test(code)) throw invalidSession();
      const data = await post('v2/accounts/mfaSignIn:finalize', {tenantId:config.tenantId,
        mfaPendingCredential:pendingCredential,mfaEnrollmentId:factorId,totpVerificationInfo:{verificationCode:code}});
      const result = await session(data);
      if (result.claims.firebase?.sign_in_second_factor !== 'totp' || result.claims.firebase?.second_factor_identifier !== factorId) throw invalidSession();
      return result;
    },
    async refresh(refreshToken) {
      const data = await post('', {grant_type:'refresh_token',refresh_token:refreshToken}, true);
      // Refresh has no tenant parameter; validate the returned JWT before reuse.
      return session({idToken:data.id_token,refreshToken:data.refresh_token});
    },
    checkEmailAction,
    async verifyEmail(oobCode) {
      const action = await checkEmailAction(oobCode);
      if (action.requestType !== 'VERIFY_EMAIL') throw invalidSession();
      // GIP consumes the code. Replays and cross-tenant codes fail at the provider.
      const data = await post('v1/accounts:update', {oobCode,tenantId:config.tenantId});
      if (data.email?.toLowerCase() !== action.email || data.emailVerified !== true) throw invalidSession();
      return {email:data.email,verified:data.emailVerified === true};
    },
    async resetPassword(oobCode, newPassword) {
      if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) {
        throw Object.assign(new Error('Choose a password of at least 8 characters.'), {status:422});
      }
      const action = await checkEmailAction(oobCode);
      if (action.requestType !== 'PASSWORD_RESET') throw invalidSession();
      const data = await post('v1/accounts:resetPassword', {oobCode,newPassword,tenantId:config.tenantId});
      if (data.email?.toLowerCase() !== action.email) throw invalidSession();
      // A password reset is not a sign-in and must not bypass the next MFA challenge.
      return {email:action.email};
    },
    async startTotp(idToken) {
      const {claims,user} = await lookup(idToken);
      requireRecentEnrollment(claims,user);
      const data = await post('v2/accounts/mfaEnrollment:start', {idToken,tenantId:config.tenantId,totpEnrollmentInfo:{}});
      const info = data.totpSessionInfo;
      if (!info?.sessionInfo || !info.sharedSecretKey || info.verificationCodeLength !== 6 || !info.periodSec || !['SHA1','SHA256','SHA512'].includes(info.hashingAlgorithm)) throw unavailable();
      return {...info,uri:`otpauth://totp/${encodeURIComponent('Star Real Estate:'+user.email)}?secret=${encodeURIComponent(info.sharedSecretKey)}&issuer=Star%20Real%20Estate&algorithm=${info.hashingAlgorithm}&digits=${info.verificationCodeLength}&period=${info.periodSec}`};
    },
    async finishTotpEnrollment(idToken, sessionInfo, code) {
      const before = await lookup(idToken);
      requireRecentEnrollment(before.claims,before.user);
      if (!/^\d{6}$/.test(code) || typeof sessionInfo !== 'string' || !sessionInfo) throw invalidSession();
      const data = await post('v2/accounts/mfaEnrollment:finalize', {idToken,tenantId:config.tenantId,
        displayName:'Star Real Estate',totpVerificationInfo:{sessionInfo,verificationCode:code}});
      const result = await session(data);
      if (result.user.localId !== before.user.localId) throw invalidSession();
      return result;
    }
  };
}
