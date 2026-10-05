import { cli, Strategy } from '@jackwener/opencli/registry';
import { UE, ensureUE, isLoggedIn, api } from './_shared.js';

cli({
  site: 'ubereats',
  name: 'whoami',
  access: 'read',
  description: 'Uber Eats 登录态（bootstrap.json isLoggedIn + getUserV1）',
  domain: 'www.ubereats.com',
  strategy: Strategy.COOKIE,
  args: [],
  columns: ['logged_in', 'name', 'email_masked'],
  navigateBefore: false,
  func: async (page) => {
    await ensureUE(page);
    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) return [{ logged_in: false, name: '', email_masked: '' }];
    let name = ''; let email = '';
    try {
      const u = await api(page, 'getUserV1', {});
      name = [u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.firstname || '';
      const e = String(u?.email || '');
      email = e ? e.replace(/^(.).*(@.*)$/, '$1***$2') : '';
    } catch { /* 有登录态就行 */ }
    void UE;
    return [{ logged_in: true, name, email_masked: email }];
  },
});
