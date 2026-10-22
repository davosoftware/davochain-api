import { EmailTemplateService } from './email-template.service';
import { EMAIL_TEMPLATES, SAMPLE_VALUES } from './email-templates';
import { PANEL_COLOURS } from './email-frame';

/**
 * The email design (look C, receipt layout 1, approved 22 Oct 2026): a coloured
 * panel at the top of a white card, a receipt list for money emails, the logo
 * carried inside the email, and a button to the website.
 */
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');

function service(o: { logo?: Buffer | null; website?: string } = {}) {
  const site = {
    companyName: 'DavoChain',
    supportEmail: 'support@davochain.com',
    address: null,
    websiteUrl: o.website ?? 'https://davochain.com',
    logo: o.logo === undefined ? PNG : o.logo,
    logoType: o.logo === null ? null : 'image/png',
    logoUpdatedAt: new Date(0),
    emailLegalName: null,
    emailAddressLine: null,
    emailOptInNote: null,
    emailUnsubscribeNote: null,
    emailUnsubscribeUrl: null,
  };
  const prisma = {
    siteSetting: { findUnique: jest.fn(async () => site) },
    emailTemplate: { findUnique: jest.fn(async () => null) },
  };
  const config = { get: (k: string) => (k === 'PUBLIC_API_URL' ? 'http://localhost:3000' : undefined) };
  const socials = { enabled: jest.fn(async () => []) };
  return new EmailTemplateService(prisma as never, config as never, {} as never, socials as never);
}

describe('email design: every email', () => {
  it.each(EMAIL_TEMPLATES.map((t) => [t.key]))('%s renders with its panel, no leftover {{blanks}}, in HTML and text', async (key) => {
    const r = await service().render(key, SAMPLE_VALUES);
    expect(r).not.toBeNull();
    expect(r!.subject).not.toMatch(/\{\{/);
    expect(r!.html).not.toMatch(/\{\{/);
    expect(r!.text).not.toMatch(/\{\{/);
    const def = EMAIL_TEMPLATES.find((t) => t.key === key)!;
    expect(r!.html).toContain(`background-color:${PANEL_COLOURS[def.frame.panel.kind]}`);
  });

  it('every template has a panel; every money email has a receipt list with a reference', () => {
    for (const t of EMAIL_TEMPLATES) {
      expect(t.frame.panel.label.length).toBeGreaterThan(0);
      if (t.variables.includes('transactionId')) {
        expect(t.frame.details?.some(([label]) => label === 'Reference')).toBe(true);
      }
    }
  });
});

describe('email design: the parts', () => {
  it('a code email shows the code big in the blue panel', async () => {
    const r = await service().render('user.email_verify', { firstName: 'Ada', code: '482913', expiresIn: '10 minutes' });
    expect(r!.html).toContain(`background-color:${PANEL_COLOURS.code}`);
    expect(r!.html).toMatch(/letter-spacing:[^;]+;[^>]*>482913</);
    expect(r!.text).toContain('482913');
  });

  it('a receipt lists its rows, with a status chip, and the amount gets thousands separators', async () => {
    const r = await service().render('ngn.deposit.credited', { firstName: 'Ada', amount: '200000.00', transactionId: 'tx-123' });
    expect(r!.subject).toBe('₦200,000.00 added to your balance');
    expect(r!.html).toContain('₦200,000.00');
    expect(r!.html).toContain('>Reference<');
    expect(r!.html).toContain('tx-123');
    expect(r!.html).toContain('>Completed<');
  });

  it('a receipt row whose value was not passed is left out, never shown blank or as {{braces}}', async () => {
    // ngn.withdrawal.submitted has a Fee row; leave the fee out.
    const r = await service().render('ngn.withdrawal.submitted', {
      firstName: 'Ada', amount: '10000', bankName: 'Access Bank', accountNumber: '••6789', transactionId: 'tx-9',
    });
    expect(r!.html).not.toContain('>Fee<');
    expect(r!.html).not.toMatch(/\{\{/);
    expect(r!.html).toContain('>Bank<');
  });

  it('values are escaped in the panel and the list: a reason cannot inject HTML', async () => {
    const r = await service().render('withdrawal.rejected', {
      firstName: 'Ada', amount: '1', assetCode: 'BTC', transactionId: '<img src=x onerror=alert(1)>', reason: '<script>alert(1)</script>',
    });
    expect(r!.html).not.toContain('<script>');
    expect(r!.html).not.toContain('<img src=x');
    expect(r!.html).toContain('&lt;img src=x');
  });

  it('the logo travels inside the email as an attachment the HTML points at', async () => {
    const r = await service().render('user.welcome', { firstName: 'Ada' });
    expect(r!.attachments).toEqual([expect.objectContaining({ cid: 'logo@davochain', contentType: 'image/png', content: PNG })]);
    expect(r!.html).toContain('src="cid:logo@davochain"');
    expect(r!.html).not.toContain('/v1/site/logo');
  });

  it('with no logo uploaded: no attachment, the name in the header', async () => {
    const r = await service({ logo: null }).render('user.welcome', { firstName: 'Ada' });
    expect(r!.attachments).toEqual([]);
    expect(r!.html).not.toContain('cid:');
    expect(r!.html).toContain('DavoChain');
  });

  it('customer emails have a button to the website; code emails have none', async () => {
    const welcome = await service({ website: 'https://davochain.com/' }).render('user.welcome', { firstName: 'Ada' });
    expect(welcome!.html).toMatch(/<a href="https:\/\/davochain\.com\/?"[^>]*>[^<]*Open DavoChain/);
    const code = await service().render('user.password_reset', { firstName: 'Ada', code: '111222', expiresIn: '10 minutes' });
    expect(code!.html).not.toContain('Open DavoChain');
  });

  it('the admin invitation button opens the invitation link', async () => {
    const r = await service().render('admin.invited', { inviteUrl: 'https://admin.davochain.com/invite/abc', role: 'Sub-admin', invitedBy: 'Chidi', expiresIn: '7 days' });
    expect(r!.html).toMatch(/<a href="https:\/\/admin\.davochain\.com\/invite\/abc"[^>]*>[^<]*Accept the invitation/);
  });

  it('the sign-off is two lines; receipts end with their list instead of a sign-off', async () => {
    const welcome = await service().render('user.welcome', { firstName: 'Ada' });
    expect(welcome!.html).toContain('Thanks,<br />The DavoChain team');
    const receipt = await service().render('trade.buy.completed', { fromAmount: '1', toAmount: '1', toAsset: 'BTC', rate: '1', transactionId: 't' });
    expect(receipt!.html).not.toContain('Thanks,');
  });

  it('panel colours by kind', () => {
    expect(PANEL_COLOURS).toEqual({ done: '#1062d3', code: '#1062d3', progress: '#b7791f', problem: '#c0392b', security: '#102c58' });
  });
});
